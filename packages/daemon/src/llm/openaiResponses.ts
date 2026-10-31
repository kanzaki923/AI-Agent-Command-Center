import type { CostSource, Usage } from '@acc/protocol';
import { errorBody, fetchSse, parseJson, redactSecrets, retrying, str } from './http';
import type { RetryOptions } from './openai';
import { type ModelPrice, costOf } from './pricing';
import {
  type ChatRequest,
  type ChatToolCall,
  LlmError,
  type LlmProvider,
  type LlmStreamEvent,
  type PricingLookup,
} from './types';

/** Models of this provider carry this prefix in the gateway (`openai/gpt-5`). */
export const OPENAI_PREFIX = 'openai/';
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export interface OpenAiConnection {
  apiKey: string | null;
  /** Null = the public API. */
  baseUrl: string | null;
}

/** How a call is authorized: an API key (billed) or a ChatGPT plan token (the plan's quota). */
export type OpenAiAuth =
  | { kind: 'key'; apiKey: string; baseUrl: string }
  | { kind: 'chatgpt'; token: string; baseUrl: string };

export interface OpenAiResponsesProviderOptions {
  connection: () => OpenAiConnection;
  /** The access token of a signed-in ChatGPT account (refreshed as needed), or null. */
  chatgptToken?: () => Promise<string | null>;
  fetch?: typeof fetch;
  pricing?: PricingLookup;
  idleTimeoutMs?: number;
  retry?: RetryOptions;
}

type Item = Record<string, unknown>;

/**
 * Responses API body (https://platform.openai.com/docs/api-reference/responses): system
 * messages become `instructions` (a later one, a `developer` item in place); the conversation is `input` items — messages, the
 * `function_call` items of earlier turns with their `function_call_output`, and the
 * reasoning items the model returned with a tool call (sent back whole, encrypted, since
 * nothing is stored server side). A ChatGPT plan token forbids `temperature` and
 * `max_output_tokens`, and every call is `store: false`, `stream: true`.
 */
export function toResponsesBody(
  req: ChatRequest,
  auth: OpenAiAuth['kind'],
): Record<string, unknown> {
  const instructions: string[] = [];
  const input: Item[] = [];
  for (const m of req.messages) {
    if (m.role === 'system') {
      // Leading system messages are the instructions; a later one (what changes per run, e.g.
      // the status of the trees) stays where it is, so the prefix before it can be cached.
      if (input.length === 0) instructions.push(m.content);
      else input.push({ role: 'developer', content: m.content });
    } else if (m.role === 'user') {
      input.push({ role: 'user', content: m.content });
    } else if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
    } else {
      for (const b of m.thinkingBlocks ?? []) {
        if (b && typeof b === 'object') input.push(b as Item);
      }
      if (m.content) input.push({ role: 'assistant', content: m.content });
      for (const tc of m.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        });
      }
    }
  }
  const body: Record<string, unknown> = {
    model: req.model.startsWith(OPENAI_PREFIX) ? req.model.slice(OPENAI_PREFIX.length) : req.model,
    input,
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
  };
  if (instructions.length > 0) body.instructions = instructions.join('\n\n');
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    }));
  }
  if (auth === 'key') {
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_output_tokens = req.maxTokens;
  }
  return body;
}

/** Error codes of ChatGPT plan use (Sign in with ChatGPT, errors and recovery). */
const PLAN_ERRORS: Record<string, { message: string; quota?: boolean }> = {
  subscription_sharing_user_not_eligible: {
    message: 'この ChatGPT プランでは、アプリからの利用ができません',
  },
  subscription_sharing_usage_limit_exceeded: {
    message: 'ChatGPT の利用枠を使い切りました。ChatGPT の設定 → 利用状況で確認してください',
    quota: true,
  },
  subscription_sharing_usage_unavailable: {
    message: 'ChatGPT の利用枠がいま使えません。しばらく待ってから再試行してください',
  },
  subscription_sharing_user_unavailable: {
    message: 'ChatGPT 側がいま応答できません。しばらく待ってから再試行してください',
  },
  subscription_sharing_unsupported_capability: {
    message: 'この指定は ChatGPT プランでは使えません',
  },
  subscription_sharing_route_not_supported: {
    message: 'この呼び出し先は ChatGPT プランでは使えません',
  },
  subscription_sharing_invalid_user: {
    message: 'ChatGPT のサインインが無効です。設定からサインインし直してください',
  },
  chatpass_v2_scope_not_authorized: {
    message: 'ChatGPT のサインインに利用の許可がありません。サインインし直してください',
  },
  chatpass_v2_invalid_authorization_context: {
    message: 'ChatGPT のサインインの状態が正しくありません。サインインし直してください',
  },
};

function planError(code: string | null, message: string, param: string | null, status: number) {
  const known = code ? PLAN_ERRORS[code] : undefined;
  if (!known) return null;
  const detail = param ? `${known.message}（${param}）` : known.message;
  return new LlmError(
    known.quota ? 'llm_quota_exceeded' : 'llm_http_error',
    `${detail}: ${message}`,
    status,
  );
}

function httpError(status: number, body: string, retryAfterMs?: number): LlmError {
  const e = errorBody(body);
  const detail = redactSecrets(e.message).slice(0, 300);
  const plan = planError(e.code, detail, e.param, status);
  if (plan) return plan;
  const head = `OpenAI の呼び出しに失敗しました（HTTP ${status}）`;
  if (status === 404 || e.code === 'model_not_found') {
    return new LlmError(
      'llm_model_not_found',
      `${head}。モデルが見つかりません: ${detail}`,
      status,
    );
  }
  if (e.code === 'insufficient_quota') {
    return new LlmError(
      'llm_quota_exceeded',
      `OpenAI の利用枠（請求）が不足しています: ${detail}`,
      status,
    );
  }
  const hint =
    status === 401 || status === 403
      ? 'OpenAI の API キーか ChatGPT のサインインを確認してください'
      : status === 429
        ? 'レート制限に達しました。しばらく待ってから再試行してください'
        : status >= 500
          ? 'OpenAI 側でエラーが発生しました'
          : null;
  return new LlmError(
    'llm_http_error',
    [hint ? `${head}。${hint}` : head, detail].filter(Boolean).join(': '),
    status,
    retryAfterMs,
  );
}

interface StreamEvent {
  type: string;
  item?: Item;
  item_id?: string;
  delta?: string;
  arguments?: string;
  response?: {
    status?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
    incomplete_details?: { reason?: string };
    error?: { code?: string; message?: string };
  };
  error?: { code?: string; message?: string; param?: string };
}

const n = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;

/** Turns the Responses API event stream into the gateway's events. */
export class ResponsesStreamAccumulator {
  private readonly calls = new Map<string, { callId: string; name: string; args: string }>();
  private readonly order: string[] = [];
  private readonly reasoning: Item[] = [];
  private usage: NonNullable<StreamEvent['response']>['usage'] | undefined;
  private finish: string | null = null;
  done = false;

  constructor(
    private readonly model: string,
    private readonly auth: OpenAiAuth['kind'],
    private readonly pricing?: PricingLookup,
  ) {}

  handle(data: string): LlmStreamEvent[] {
    const ev = parseJson<StreamEvent>('OpenAI', data);
    switch (ev.type) {
      case 'response.output_item.added': {
        const item = ev.item ?? {};
        if (item.type === 'function_call') {
          const id = str(item.id, str(item.call_id, String(this.order.length)));
          this.calls.set(id, {
            callId: str(item.call_id, id),
            name: str(item.name),
            args: typeof item.arguments === 'string' ? item.arguments : '',
          });
          this.order.push(id);
        }
        return [];
      }
      case 'response.output_text.delta':
        return ev.delta ? [{ type: 'text', text: ev.delta }] : [];
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        return ev.delta ? [{ type: 'reasoning', text: ev.delta }] : [];
      case 'response.function_call_arguments.delta': {
        const c = ev.item_id ? this.calls.get(ev.item_id) : undefined;
        if (c && ev.delta) c.args += ev.delta;
        return [];
      }
      case 'response.function_call_arguments.done': {
        const c = ev.item_id ? this.calls.get(ev.item_id) : undefined;
        if (c && typeof ev.arguments === 'string') c.args = ev.arguments;
        return [];
      }
      case 'response.output_item.done': {
        const item = ev.item ?? {};
        if (item.type === 'function_call') {
          const id = str(item.id, str(item.call_id));
          const c = this.calls.get(id);
          if (c && typeof item.arguments === 'string' && item.arguments) c.args = item.arguments;
        } else if (item.type === 'reasoning') {
          this.reasoning.push(item);
        }
        return [];
      }
      case 'response.completed':
        this.usage = ev.response?.usage;
        this.finish = this.order.length > 0 ? 'tool_calls' : 'stop';
        this.done = true;
        return this.finishEvents();
      case 'response.incomplete':
        this.usage = ev.response?.usage;
        this.finish =
          ev.response?.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'stop';
        this.done = true;
        return this.finishEvents();
      case 'response.failed': {
        const e = ev.response?.error ?? {};
        throw (
          planError(e.code ?? null, e.message ?? '', null, 500) ??
          new LlmError(
            'llm_stream_error',
            `OpenAI がエラーを返しました: ${redactSecrets(e.message ?? e.code ?? 'unknown')}`,
          )
        );
      }
      case 'error': {
        const e = ev.error ?? {};
        throw (
          planError(e.code ?? null, e.message ?? '', e.param ?? null, 500) ??
          new LlmError(
            'llm_stream_error',
            `OpenAI がエラーを返しました: ${redactSecrets(e.message ?? e.code ?? 'unknown')}`,
          )
        );
      }
      default:
        return [];
    }
  }

  finishEvents(): LlmStreamEvent[] {
    const out: LlmStreamEvent[] = [];
    if (this.reasoning.length > 0) out.push({ type: 'thinking_blocks', blocks: this.reasoning });
    for (const id of this.order) {
      const c = this.calls.get(id)!;
      const toolCall: ChatToolCall = { id: c.callId, name: c.name, arguments: c.args || '{}' };
      out.push({ type: 'tool_call', toolCall });
    }
    out.push({ type: 'usage', usage: this.resolveUsage() });
    out.push({ type: 'finish', reason: this.finish });
    return out;
  }

  /**
   * A ChatGPT plan is not billed per call: the cost is 0 and `reported` (the plan has its
   * own limit). With an API key: tokens × the list price, cached input at its price.
   */
  private resolveUsage(): Usage {
    const inputTokens = n(this.usage?.input_tokens);
    const outputTokens = n(this.usage?.output_tokens);
    const cached = Math.min(inputTokens, n(this.usage?.input_tokens_details?.cached_tokens));
    if (this.auth === 'chatgpt') {
      return { inputTokens, outputTokens, costUsd: 0, costSource: 'reported' };
    }
    let costUsd = 0;
    let costSource: CostSource = 'unknown';
    const price = this.pricing?.(this.model) as
      (ModelPrice & { basis?: string }) | null | undefined;
    if (price && inputTokens + outputTokens > 0) {
      costUsd = costOf(
        {
          inputPerMTok: price.inputPerMTok,
          outputPerMTok: price.outputPerMTok,
          cacheReadPerMTok: price.cacheReadPerMTok ?? price.inputPerMTok * 0.1,
          cacheWritePerMTok: price.cacheWritePerMTok ?? price.inputPerMTok,
        },
        { inputTokens: inputTokens - cached, outputTokens, cacheReadTokens: cached },
      );
      costSource = 'estimated';
    }
    return { inputTokens, outputTokens, costUsd, costSource };
  }
}

/** OpenAI Responses API streaming client (`openai/…` models), by API key or ChatGPT plan. */
export class OpenAiResponsesProvider implements LlmProvider {
  readonly id = 'openai';

  constructor(private readonly opts: OpenAiResponsesProviderOptions) {}

  /** The plan when signed in, else the key; null when neither is set. */
  async auth(): Promise<OpenAiAuth | null> {
    const { apiKey, baseUrl } = this.opts.connection();
    const base = (baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '');
    const token = (await this.opts.chatgptToken?.()) ?? null;
    if (token) return { kind: 'chatgpt', token, baseUrl: base };
    if (apiKey) return { kind: 'key', apiKey, baseUrl: base };
    return null;
  }

  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent> {
    return retrying(() => this.attempt(req, signal), signal, this.opts.retry);
  }

  private async *attempt(req: ChatRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const auth = await this.auth();
    if (!auth) {
      throw new LlmError(
        'llm_not_configured',
        'OpenAI の API キーも ChatGPT のサインインもありません。設定の接続で指定してください',
      );
    }
    const acc = new ResponsesStreamAccumulator(req.model, auth.kind, this.opts.pricing);
    const messages = fetchSse({
      url: `${auth.baseUrl}/responses`,
      headers: { authorization: `Bearer ${auth.kind === 'key' ? auth.apiKey : auth.token}` },
      body: toResponsesBody(req, auth.kind),
      signal,
      name: 'OpenAI',
      httpError,
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      ...(this.opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: this.opts.idleTimeoutMs } : {}),
    });
    for await (const m of messages) {
      if (!m.data || m.data === '[DONE]') continue;
      for (const ev of acc.handle(m.data)) yield ev;
      if (acc.done) break;
    }
    if (!acc.done) for (const ev of acc.finishEvents()) yield ev;
  }
}
