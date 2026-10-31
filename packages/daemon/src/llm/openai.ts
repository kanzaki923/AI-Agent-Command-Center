import type { CostSource, Usage } from '@acc/protocol';
import type { Logger } from '../core/log';
import { describeGatewayError, gatewayErrorHint } from './gatewayErrors';
import { SseParser } from './sse';
import {
  type ChatMessage,
  type ChatRequest,
  type ChatToolCall,
  LlmError,
  type LlmProvider,
  type LlmStreamEvent,
  type PricingLookup,
  abortError,
  isAbortError,
  sleep,
} from './types';
import { cacheCounts } from './usage';

export interface LiteLlmConnection {
  baseUrl: string | null;
  apiKey: string | null;
}

export interface OpenAiProviderOptions {
  /** Read at call time so settings changes apply without a restart. */
  connection: () => LiteLlmConnection;
  fetch?: typeof fetch;
  pricing?: PricingLookup;
  /** No bytes from LiteLLM for this long aborts the call (default 5 min). */
  idleTimeoutMs?: number;
  /** Retries of calls that failed before any token arrived (429 / 5xx / connection). */
  retry?: RetryOptions;
  /**
   * The deployment behind a LiteLLM model name (`litellm_params.model` from `/model/info`,
   * e.g. `team-sonnet` → `anthropic/claude-sonnet-4-5`), when known. Decides the cache marks.
   */
  deploymentOf?: (model: string) => string | null;
  log?: Logger;
}

export interface RetryOptions {
  /** Default 2. */
  maxRetries?: number;
  /** Wait before the first retry without Retry-After, doubled each time (default 1 s). */
  baseDelayMs?: number;
  /** Longest wait; a Retry-After beyond it is not waited for (default 20 s). */
  maxDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * How long to wait before retrying a failed call, or null when it must not be retried: only
 * a 429 / 5xx answer or a failed connection (LiteLLM's key budget, auth and bad requests are
 * not), at most `maxRetries` times, honouring Retry-After up to `maxDelayMs`.
 */
export function retryDelayMs(err: unknown, attempt: number, o: RetryOptions = {}): number | null {
  if (!(err instanceof LlmError) || attempt >= (o.maxRetries ?? 2)) return null;
  const retryable =
    err.code === 'llm_unreachable' ||
    (err.code === 'llm_http_error' &&
      err.status !== undefined &&
      (err.status === 429 || err.status >= 500));
  if (!retryable) return null;
  const max = o.maxDelayMs ?? 20_000;
  if (err.retryAfterMs !== undefined) return err.retryAfterMs <= max ? err.retryAfterMs : null;
  return Math.min(max, (o.baseDelayMs ?? 1000) * 2 ** attempt);
}

/** `Retry-After`: seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** LiteLLM puts the computed cost of a call in this response header. */
export const LITELLM_COST_HEADER = 'x-litellm-response-cost';
/** The deployment's model of a call (e.g. `anthropic/claude-sonnet-5-5`). */
export const LITELLM_MODEL_HEADER = 'x-litellm-model-name';
export const LITELLM_VERSION_HEADER = 'x-litellm-version';

/**
 * Before 1.104.0 LiteLLM moves every system message into Anthropic's top-level `system`, so
 * the per-run context at the end of a conversation lands in front of the history and the
 * history cache never hits (docs/snapshot/20261031_litellm-prompt-caching-verified.md).
 */
export function hoistsLaterSystem(version: string): boolean {
  const m = /^(\d+)\.(\d+)\./.exec(version.trim());
  if (!m) return false;
  const major = Number(m[1]);
  return major < 1 || (major === 1 && Number(m[2]) < 104);
}

/**
 * Cache marks go to Claude deployments only: LiteLLM passes them as they are to an
 * OpenAI-compatible upstream, and turns them into paid explicit caching on GPT-5.6+ and
 * Gemini.
 */
export const isClaudeDeployment = (model: string): boolean => /claude/i.test(model);

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/** Map provider-neutral messages to the OpenAI `/chat/completions` wire format. */
export function toWireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'system':
      case 'user':
        return { role: m.role, content: m.content };
      case 'assistant': {
        // LiteLLM turns `thinking_blocks` back into Anthropic thinking blocks (with signature).
        const thinking =
          m.thinkingBlocks && m.thinkingBlocks.length > 0
            ? { thinking_blocks: m.thinkingBlocks }
            : {};
        return m.toolCalls && m.toolCalls.length > 0
          ? {
              role: 'assistant',
              content: m.content,
              tool_calls: m.toolCalls.map((t) => ({
                id: t.id,
                type: 'function',
                function: { name: t.name, arguments: t.arguments },
              })),
              ...thinking,
            }
          : { role: 'assistant', content: m.content ?? '', ...thinking };
      }
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
  });
}

const CACHE_MARK = { type: 'ephemeral' } as const;
type WireObject = Record<string, unknown>;

/**
 * Prompt-cache marks in the shape LiteLLM carries to Anthropic (checked against a real
 * LiteLLM, docs/snapshot/20261031_litellm-prompt-caching-verified.md), at the places the
 * Anthropic path marks: the first system message, the last message before the first later
 * system message (the anchor: the history up to there is the same in the next run) and the
 * last message (a tool loop resends everything). With the last tool, 4 marks at most:
 * LiteLLM does not drop extra ones and the API rejects them.
 */
function markForCache(source: ChatMessage[], wire: WireObject[]): void {
  let leading = 0;
  while (source[leading]?.role === 'system') leading++;
  const later = source.findIndex((m, i) => i >= leading && m.role === 'system');
  let last = -1;
  for (let i = source.length - 1; i >= leading; i--) {
    if (source[i]!.role !== 'system') {
      last = i;
      break;
    }
  }
  const targets = new Set<number>();
  if (leading > 0) targets.add(0);
  if (later > leading) targets.add(later - 1);
  if (last >= 0) targets.add(last);
  for (const i of targets) {
    const m = wire[i]!;
    const calls = m.tool_calls as WireObject[] | undefined;
    if (calls && calls.length > 0) {
      // On the message itself the mark is lost when the content is null (and lands on a text
      // LiteLLM makes up when it is ''); on the call it reaches the tool_use block.
      calls[calls.length - 1] = { ...calls.at(-1), cache_control: CACHE_MARK };
    } else if (typeof m.content === 'string' && m.content !== '') {
      m.cache_control = CACHE_MARK;
    }
  }
}

/** `cache`: add prompt-cache marks (Claude deployments only, see isClaudeDeployment). */
export function toWireRequest(
  req: ChatRequest,
  opts: { cache?: boolean } = {},
): Record<string, unknown> {
  const messages = toWireMessages(req.messages) as WireObject[];
  if (opts.cache) markForCache(req.messages, messages);
  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools && req.tools.length > 0) {
    const tools: WireObject[] = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    // At the top level, not inside `function`: Bedrock reads only this one.
    if (opts.cache) tools[tools.length - 1]!.cache_control = CACHE_MARK;
    body.tools = tools;
  }
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  return body;
}

interface WireChunk {
  error?: { message?: unknown } | string;
  choices?: {
    index?: number;
    delta?: {
      content?: unknown;
      reasoning_content?: unknown;
      thinking_blocks?: unknown;
      tool_calls?: {
        index?: number;
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      }[];
    };
    finish_reason?: unknown;
  }[];
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    cost?: unknown;
    /** OpenAI's (and LiteLLM's) cached part of prompt_tokens. */
    prompt_tokens_details?: { cached_tokens?: unknown } | null;
    /** What LiteLLM passes through from Anthropic. */
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  } | null;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : null;

/**
 * Folds OpenAI-style stream chunks into normalized events: text/reasoning deltas pass
 * through, tool-call fragments are joined per `index`, usage and cost are resolved at the end.
 */
export class OpenAiStreamAccumulator {
  private readonly calls = new Map<number, { id: string; name: string; args: string }>();
  private readonly thinking: Record<string, unknown>[] = [];
  private finishReason: string | null = null;
  private usage: WireChunk['usage'] = null;
  done = false;

  constructor(
    private readonly model: string,
    private readonly headerCost: number | null,
    private readonly pricing?: PricingLookup,
  ) {}

  /** Handle one SSE `data:` payload. */
  handle(data: string): LlmStreamEvent[] {
    if (data.trim() === '[DONE]') {
      this.done = true;
      return [];
    }
    let chunk: WireChunk;
    try {
      chunk = JSON.parse(data) as WireChunk;
    } catch {
      throw new LlmError('llm_stream_error', 'LLM のストリームを解釈できませんでした');
    }
    if (chunk.error) {
      const msg =
        typeof chunk.error === 'string'
          ? chunk.error
          : typeof chunk.error.message === 'string'
            ? chunk.error.message
            : 'unknown error';
      throw new LlmError('llm_stream_error', `LLM がエラーを返しました: ${msg}`);
    }
    const out: LlmStreamEvent[] = [];
    const choice = chunk.choices?.find((c) => (c.index ?? 0) === 0);
    if (choice) {
      const d = choice.delta;
      if (typeof d?.reasoning_content === 'string' && d.reasoning_content) {
        out.push({ type: 'reasoning', text: d.reasoning_content });
      }
      if (typeof d?.content === 'string' && d.content) {
        out.push({ type: 'text', text: d.content });
      }
      if (Array.isArray(d?.thinking_blocks)) {
        for (const b of d.thinking_blocks as unknown[]) this.addThinking(b);
      }
      for (const tc of d?.tool_calls ?? []) {
        // Some providers omit `index` when sending each call whole; append those.
        const index = typeof tc.index === 'number' ? tc.index : this.calls.size;
        const cur = this.calls.get(index) ?? { id: '', name: '', args: '' };
        if (typeof tc.id === 'string' && tc.id) cur.id = tc.id;
        if (typeof tc.function?.name === 'string') cur.name += tc.function.name;
        if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments;
        this.calls.set(index, cur);
      }
      if (typeof choice.finish_reason === 'string') this.finishReason = choice.finish_reason;
    }
    if (chunk.usage) this.usage = chunk.usage;
    return out;
  }

  /**
   * LiteLLM streams Anthropic thinking as `thinking_blocks` fragments: text pieces of the
   * current block, then a piece carrying its signature, empty (1.106) or repeating the whole
   * text (1.105). Fragments are joined into whole blocks; a signature closes a block.
   */
  private addThinking(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const b = raw as Record<string, unknown>;
    const last = this.thinking.at(-1);
    if (b.type === 'thinking' && last?.type === 'thinking' && !last.signature) {
      const prev = typeof last.thinking === 'string' ? last.thinking : '';
      const signature = typeof b.signature === 'string' && b.signature ? b.signature : null;
      if (typeof b.thinking === 'string') {
        // The text the signature signs: a closing piece that restates it is not appended.
        last.thinking = signature && prev && b.thinking.startsWith(prev) ? b.thinking : prev + b.thinking;
      }
      if (signature) last.signature = signature;
      return;
    }
    this.thinking.push({ ...b });
  }

  finish(): LlmStreamEvent[] {
    const out: LlmStreamEvent[] = [];
    if (this.thinking.length > 0) out.push({ type: 'thinking_blocks', blocks: this.thinking });
    const sorted = [...this.calls.entries()].sort((a, b) => a[0] - b[0]);
    for (const [index, c] of sorted) {
      const toolCall: ChatToolCall = {
        id: c.id || `call_${index}`,
        name: c.name,
        arguments: c.args || '{}',
      };
      out.push({ type: 'tool_call', toolCall });
    }
    out.push({ type: 'usage', usage: this.resolveUsage() });
    out.push({ type: 'finish', reason: this.finishReason });
    return out;
  }

  /**
   * Cost precedence: `usage.cost` from the stream (LiteLLM, reported) > the cost header
   * (reported; a zero header with non-zero tokens is ignored because streaming responses
   * send headers before the cost is known) > tokens x pricing (estimated) > unknown.
   */
  private resolveUsage(): Usage {
    const inputTokens = Math.max(0, Math.round(num(this.usage?.prompt_tokens) ?? 0));
    const outputTokens = Math.max(0, Math.round(num(this.usage?.completion_tokens) ?? 0));
    // prompt_tokens includes the cached part (LiteLLM, for Anthropic models too).
    const u = this.usage;
    const read = Math.min(
      inputTokens,
      Math.max(
        num(u?.prompt_tokens_details?.cached_tokens) ?? 0,
        num(u?.cache_read_input_tokens) ?? 0,
      ),
    );
    const write = Math.min(inputTokens - read, num(u?.cache_creation_input_tokens) ?? 0);
    const usageCost = num(u?.cost);
    let costUsd = 0;
    let costSource: CostSource = 'unknown';
    if (usageCost !== null && usageCost >= 0) {
      costUsd = usageCost;
      costSource = 'reported';
    } else if (
      this.headerCost !== null &&
      this.headerCost >= 0 &&
      (this.headerCost > 0 || inputTokens + outputTokens === 0)
    ) {
      costUsd = this.headerCost;
      costSource = 'reported';
    } else {
      const price = this.pricing?.(this.model);
      if (price && inputTokens + outputTokens > 0) {
        // Cache reads and writes at their own prices, not at the input price.
        const cacheRead = price.cacheReadPerMTok ?? price.inputPerMTok * 0.1;
        const cacheWrite = price.cacheWritePerMTok ?? price.inputPerMTok * 1.25;
        costUsd =
          ((inputTokens - read - write) * price.inputPerMTok +
            read * cacheRead +
            write * cacheWrite +
            outputTokens * price.outputPerMTok) /
          1_000_000;
        costSource = 'estimated';
      }
    }
    return {
      inputTokens,
      outputTokens,
      ...cacheCounts(read, write),
      costUsd,
      costSource,
    };
  }
}

/** OpenAI-compatible `/chat/completions` streaming client (pointed at LiteLLM). */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = 'litellm';
  private readonly fetchImpl: typeof fetch;
  /** `baseUrl model` → the deployment LiteLLM answered with (LITELLM_MODEL_HEADER). */
  private readonly deployments = new Map<string, string>();
  private readonly warnedVersions = new Set<string>();

  constructor(private readonly opts: OpenAiProviderOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * One model call. A call that fails before anything arrived (429 / 5xx / no connection) is
   * retried up to twice, honouring Retry-After (LiteLLM's own retries cover the upstream; this
   * covers LiteLLM itself and what it gives up on). Once a token arrived it is never retried.
   */
  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const retry = this.opts.retry ?? {};
    for (let attempt = 0; ; attempt++) {
      let received = false;
      try {
        for await (const ev of this.attempt(req, signal)) {
          received = true;
          yield ev;
        }
        return;
      } catch (err) {
        const wait = received || signal.aborted ? null : retryDelayMs(err, attempt, retry);
        if (wait === null) throw err;
        await (retry.sleep ?? sleep)(wait, signal);
      }
    }
  }

  /**
   * Whether a call gets cache marks: its deployment is a Claude model. The deployment comes
   * from LiteLLM's answer to an earlier call, else `/model/info`, else the name itself (so an
   * alias like `team-sonnet` gets marks once LiteLLM has said what is behind it).
   */
  private cacheable(baseUrl: string, model: string): boolean {
    const deployment =
      this.deployments.get(`${baseUrl} ${model}`) ?? this.opts.deploymentOf?.(model) ?? model;
    return isClaudeDeployment(deployment);
  }

  /** Remembers the deployment of a model; warns once about a LiteLLM that hoists. */
  private learn(baseUrl: string, model: string, headers: Headers): void {
    const deployment = headers.get(LITELLM_MODEL_HEADER)?.trim();
    if (deployment) this.deployments.set(`${baseUrl} ${model}`, deployment);
    const version = headers.get(LITELLM_VERSION_HEADER)?.trim();
    if (version && hoistsLaterSystem(version) && !this.warnedVersions.has(version)) {
      this.warnedVersions.add(version);
      this.opts.log?.warn(
        'LiteLLM before 1.104.0 moves later system messages to the top: the history prompt cache will not hit',
        { version },
      );
    }
  }

  private async *attempt(req: ChatRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const { baseUrl, apiKey } = this.opts.connection();
    if (!baseUrl) {
      throw new LlmError(
        'llm_not_configured',
        'LiteLLM の接続先が設定されていません。設定で LiteLLM の URL を指定してください',
      );
    }
    if (signal.aborted) throw abortError(signal);
    // LiteLLM keeps a stalled upstream stream open for its own request timeout (6000 s by
    // default), so silence is bounded here: no bytes for idleMs (waiting for the response
    // headers included) aborts the call.
    const idleMs = this.opts.idleTimeoutMs ?? DEFAULT_LLM_IDLE_TIMEOUT_MS;
    const ctl = new AbortController();
    const forward = () => ctl.abort(signal.reason);
    signal.addEventListener('abort', forward, { once: true });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, idleMs);
    };
    const disarm = () => clearTimeout(timer);
    const timeout = () =>
      new LlmError(
        'llm_timeout',
        `LLM から${formatDuration(idleMs)}以上応答がないため停止しました（LiteLLM か上流のモデルが応答していません）`,
      );

    try {
      const url = joinUrl(baseUrl, 'chat/completions');
      let res: Response;
      arm();
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...authHeaders(apiKey),
          },
          body: JSON.stringify(toWireRequest(req, { cache: this.cacheable(baseUrl, req.model) })),
          signal: ctl.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw httpError(res.status, body, parseRetryAfter(res.headers.get('retry-after')));
        }
      } catch (err) {
        if (err instanceof LlmError) throw err;
        if (timedOut) throw timeout();
        if (signal.aborted || isAbortError(err)) throw abortError(signal);
        const cause = (err as { cause?: { code?: unknown } }).cause?.code;
        throw new LlmError(
          'llm_unreachable',
          `LiteLLM（${baseUrl}）に接続できませんでした${typeof cause === 'string' ? `: ${cause}` : ''}`,
        );
      } finally {
        disarm();
      }
      this.learn(baseUrl, req.model, res.headers);
      if (!res.body) throw new LlmError('llm_stream_error', 'LLM の応答が空でした');

      const acc = new OpenAiStreamAccumulator(
        req.model,
        num(res.headers.get(LITELLM_COST_HEADER)),
        this.opts.pricing,
      );
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      try {
        for (;;) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          arm();
          try {
            chunk = await reader.read();
          } catch (err) {
            if (timedOut) throw timeout();
            if (signal.aborted || isAbortError(err)) throw abortError(signal);
            throw new LlmError('llm_stream_error', 'LLM のストリームが途中で切断されました');
          } finally {
            disarm();
          }
          const text = chunk.done
            ? decoder.decode()
            : decoder.decode(chunk.value as Uint8Array, { stream: true });
          const messages = chunk.done
            ? [...parser.push(text), ...parser.flush()]
            : parser.push(text);
          for (const m of messages) {
            if (acc.done) break;
            for (const ev of acc.handle(m.data)) yield ev;
          }
          if (chunk.done || acc.done) break;
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      for (const ev of acc.finish()) yield ev;
    } finally {
      disarm();
      signal.removeEventListener('abort', forward);
    }
  }
}

/** Default for OpenAiProviderOptions.idleTimeoutMs. */
export const DEFAULT_LLM_IDLE_TIMEOUT_MS = 5 * 60_000;

function formatDuration(ms: number): string {
  return ms >= 60_000 ? ` ${Math.round(ms / 60_000)} 分` : ` ${Math.round(ms / 1000)} 秒`;
}

/** Japanese hint per HTTP status of a failed call (LiteLLM's own or the upstream's). */
function statusHint(status: number): string | null {
  if (status === 401 || status === 403) {
    return 'LiteLLM の API キー、または LiteLLM に設定した上流の認証情報を確認してください';
  }
  if (status === 429) return 'レート制限に達しました。しばらく待ってから再試行してください';
  if (status >= 500) return 'LiteLLM か上流のモデルでエラーが発生しました';
  return null;
}

/** LlmError for a non-2xx answer, with LiteLLM's wrapping removed and the key masked. */
export function httpError(status: number, body: string, retryAfterMs?: number): LlmError {
  let raw = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string };
    const e = parsed.error;
    if (typeof e === 'string') raw = e;
    else if (e && typeof e.message === 'string') raw = e.message;
  } catch {
    // plain text body
  }
  const described = describeGatewayError(raw);
  const info =
    described.kind === null && /"type"\s*:\s*"budget_exceeded"/.test(body)
      ? { ...described, kind: 'quota_exceeded' as const }
      : described;
  let detail = info.message.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-…').trim();
  if (detail.length > 300) detail = `${detail.slice(0, 300)}…`;
  const hint = gatewayErrorHint(info) ?? statusHint(status);
  const head = `LLM の呼び出しに失敗しました（HTTP ${status}）`;
  const message = [hint ? `${head}。${hint}` : head, detail].filter(Boolean).join(': ');
  return new LlmError(
    info.kind === 'model_not_found'
      ? 'llm_model_not_found'
      : info.kind === 'quota_exceeded'
        ? 'llm_quota_exceeded'
        : 'llm_http_error',
    message,
    status,
    retryAfterMs,
  );
}
