import type { CostSource, Usage } from '@acc/protocol';
import { errorBody, fetchSse, parseJson, redactSecrets, retrying, str } from './http';
import type { RetryOptions } from './openai';
import { APP_NOTE_LABEL, lastLaterSystem } from './messages';
import { type ModelPrice, costOf } from './pricing';
import { cacheCounts } from './usage';
import {
  type ChatMessage,
  type ChatRequest,
  type ChatToolCall,
  LlmError,
  type LlmProvider,
  type LlmStreamEvent,
  type PricingLookup,
} from './types';

/** Models of this provider carry this prefix in the gateway (`anthropic/claude-sonnet-4-6`). */
export const ANTHROPIC_PREFIX = 'anthropic/';
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
/** Output tokens a call may produce when the request names no limit. */
const DEFAULT_MAX_TOKENS = 8192;

export interface AnthropicConnection {
  apiKey: string | null;
  /** Null = the public API. */
  baseUrl: string | null;
}

export interface AnthropicProviderOptions {
  connection: () => AnthropicConnection;
  fetch?: typeof fetch;
  pricing?: PricingLookup;
  idleTimeoutMs?: number;
  retry?: RetryOptions;
}

type Block = Record<string, unknown>;
interface WireMessage {
  role: 'user' | 'assistant' | 'system';
  content: Block[];
}

const CACHE = { cache_control: { type: 'ephemeral' } } as const;
/** Anthropic's stop_reason → the finish reason every provider reports (OpenAI's words). */
const FINISH_REASONS: Record<string, string> = {
  tool_use: 'tool_calls',
  max_tokens: 'length',
  refusal: 'content_filter',
};
/** Blocks that may carry a cache mark (not thinking blocks). */
const CACHEABLE = new Set(['text', 'tool_use', 'tool_result', 'image', 'document']);

function parseArgs(args: string): unknown {
  try {
    return JSON.parse(args || '{}');
  } catch {
    return {};
  }
}

/**
 * Models that take a `role: "system"` message inside `messages` (checked on the real API
 * 2026-10-31: Haiku 5.5, Sonnet 5 / 5.5, Opus 5.5 do; Haiku 4.5 answers 400). A model that
 * answers 400 anyway is sent the labelled user text from then on (AnthropicProvider).
 */
export function acceptsMidSystem(model: string): boolean {
  return /(?:opus|sonnet|haiku)-(?:[5-9]|\d{2})|opus-4-8|fable|mythos/i.test(model);
}

/** The 400 of a model that does not take a mid-conversation system message. */
const MID_SYSTEM_REJECTED = /role 'system' is not supported/i;

/**
 * Messages API body for a request (https://docs.anthropic.com/en/api/messages): leading
 * system messages become system blocks (the first marked for the prompt cache, so the
 * unchanging role of a supervisor or the assistant is read at a tenth of the price), tool
 * calls and results become `tool_use` / `tool_result` blocks, neighbours of one role are
 * merged (the API wants user and assistant to alternate), reasoning blocks of a turn are
 * sent back as they came. The last tool carries the cache mark too.
 *
 * A later system message stays a `role: "system"` message where the model takes one and the
 * API allows it there (right after a user turn, last or before an assistant turn); else it
 * travels as a labelled user text. Only the first keeps the cache across runs: a block the
 * cache stored in the middle of a message is not read back where that message ends (real API,
 * snapshot 20261031_supervisor-window-cache.md), and the run's status text after the last
 * user turn is gone in the next run.
 */
export function toMessagesBody(
  req: ChatRequest,
  opts: { midSystem?: boolean } = {},
): Record<string, unknown> {
  const midSystem = opts.midSystem ?? acceptsMidSystem(req.model);
  const system: Block[] = [];
  const messages: WireMessage[] = [];
  const push = (role: WireMessage['role'], blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };
  const src = req.messages;
  let leadingCount = 0;
  while (src[leadingCount]?.role === 'system') leadingCount++;
  const lastLater = lastLaterSystem(src);
  let anchor: Block | null = null;
  for (const [i, m] of src.entries()) {
    if (m.role === 'system') {
      if (i < leadingCount) {
        system.push({ type: 'text', text: m.content });
        continue;
      }
      if (i === lastLater) anchor = messages.at(-1)?.content.at(-1) ?? null;
      let next = i + 1;
      while (src[next]?.role === 'system') next++;
      const native =
        midSystem &&
        (messages.at(-1)?.role === 'user' || messages.at(-1)?.role === 'system') &&
        (next === src.length || src[next]!.role === 'assistant');
      if (native) push('system', [{ type: 'text', text: m.content }]);
      // A user turn otherwise: labelled, so it is not taken for the person's words.
      else push('user', [{ type: 'text', text: `${APP_NOTE_LABEL}\n${m.content}` }]);
      continue;
    }
    if (m.role === 'user') {
      push('user', [{ type: 'text', text: m.content }]);
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]);
    } else {
      const blocks: Block[] = [];
      for (const b of m.thinkingBlocks ?? []) {
        if (b && typeof b === 'object') blocks.push(b as Block);
      }
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parseArgs(tc.arguments) });
      }
      push('assistant', blocks);
    }
  }
  if (system.length > 0) system[0] = { ...system[0], ...CACHE };
  // The history: read back up to the anchor in the next run, and up to the last block on the
  // next call of this run (a tool loop resends everything). 4 marks at most: last tool,
  // system, anchor, last block (not of a system message: that one changes every run).
  const lastTurn = messages.findLast((w) => w.role !== 'system');
  for (const block of [anchor, lastTurn?.content.at(-1)]) {
    if (block && CACHEABLE.has(String(block.type))) Object.assign(block, CACHE);
  }
  const tools = (req.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
  if (tools.length > 0) tools[tools.length - 1] = { ...tools[tools.length - 1]!, ...CACHE };
  const body: Record<string, unknown> = {
    model: req.model.startsWith(ANTHROPIC_PREFIX)
      ? req.model.slice(ANTHROPIC_PREFIX.length)
      : req.model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages,
    stream: true,
  };
  if (system.length > 0) body.system = system;
  if (tools.length > 0) body.tools = tools;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  return body;
}

function httpError(status: number, body: string, retryAfterMs?: number): LlmError {
  const e = errorBody(body);
  const detail = redactSecrets(e.message).slice(0, 300);
  const head = `Anthropic の呼び出しに失敗しました（HTTP ${status}）`;
  if (status === 404 && /model/i.test(detail)) {
    return new LlmError(
      'llm_model_not_found',
      `${head}。モデルが見つかりません: ${detail}`,
      status,
    );
  }
  const hint =
    status === 401 || status === 403
      ? 'Anthropic の API キーを確認してください'
      : status === 429
        ? 'レート制限に達しました。しばらく待ってから再試行してください'
        : status === 529 || status >= 500
          ? 'Anthropic 側が混み合っています'
          : null;
  return new LlmError(
    'llm_http_error',
    [hint ? `${head}。${hint}` : head, detail].filter(Boolean).join(': '),
    status === 529 ? 503 : status,
    retryAfterMs,
  );
}

interface StreamEvent {
  type: string;
  index?: number;
  message?: { usage?: Record<string, unknown> };
  content_block?: Record<string, unknown>;
  delta?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  error?: { type?: string; message?: string };
}

const n = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;

/** Turns the Messages API event stream into the gateway's events. */
export class AnthropicStreamAccumulator {
  private readonly blocks = new Map<number, Block & { json?: string; thinking?: string }>();
  private readonly thinking: Block[] = [];
  private readonly calls: ChatToolCall[] = [];
  private usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private stopReason: string | null = null;
  done = false;

  constructor(
    private readonly model: string,
    private readonly pricing?: PricingLookup,
  ) {}

  handle(event: string, data: string): LlmStreamEvent[] {
    const ev = parseJson<StreamEvent>('Anthropic', data);
    const type = ev.type || event;
    switch (type) {
      case 'message_start': {
        const u = ev.message?.usage ?? {};
        this.usage.input = n(u.input_tokens);
        this.usage.cacheRead = n(u.cache_read_input_tokens);
        this.usage.cacheWrite = n(u.cache_creation_input_tokens);
        this.usage.output = n(u.output_tokens);
        return [];
      }
      case 'content_block_start': {
        const b = { ...(ev.content_block ?? {}) };
        if (b.type === 'tool_use') b.json = '';
        if (b.type === 'thinking') b.thinking = typeof b.thinking === 'string' ? b.thinking : '';
        this.blocks.set(ev.index ?? 0, b);
        return [];
      }
      case 'content_block_delta': {
        const b = this.blocks.get(ev.index ?? 0);
        const d = ev.delta ?? {};
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          return d.text ? [{ type: 'text', text: d.text }] : [];
        }
        if (d.type === 'input_json_delta' && b && typeof d.partial_json === 'string') {
          b.json = `${b.json ?? ''}${d.partial_json}`;
          return [];
        }
        if (d.type === 'thinking_delta' && b && typeof d.thinking === 'string') {
          b.thinking = `${b.thinking ?? ''}${d.thinking}`;
          return d.thinking ? [{ type: 'reasoning', text: d.thinking }] : [];
        }
        if (d.type === 'signature_delta' && b && typeof d.signature === 'string') {
          b.signature = d.signature;
        }
        return [];
      }
      case 'content_block_stop': {
        const b = this.blocks.get(ev.index ?? 0);
        if (!b) return [];
        if (b.type === 'tool_use') {
          this.calls.push({
            id: str(b.id, `toolu_${this.calls.length}`),
            name: str(b.name),
            arguments: (b.json as string) || '{}',
          });
        } else if (b.type === 'thinking') {
          this.thinking.push({
            type: 'thinking',
            thinking: b.thinking ?? '',
            signature: b.signature,
          });
        } else if (b.type === 'redacted_thinking') {
          const { json: _j, thinking: _t, ...rest } = b;
          this.thinking.push(rest);
        }
        return [];
      }
      case 'message_delta': {
        const d = ev.delta ?? {};
        if (typeof d.stop_reason === 'string') this.stopReason = d.stop_reason;
        const u = ev.usage ?? {};
        if (u.output_tokens !== undefined) this.usage.output = n(u.output_tokens);
        if (u.input_tokens !== undefined) this.usage.input = n(u.input_tokens);
        if (u.cache_read_input_tokens !== undefined)
          this.usage.cacheRead = n(u.cache_read_input_tokens);
        if (u.cache_creation_input_tokens !== undefined) {
          this.usage.cacheWrite = n(u.cache_creation_input_tokens);
        }
        return [];
      }
      case 'message_stop':
        this.done = true;
        return this.finish();
      case 'error':
        throw new LlmError(
          'llm_stream_error',
          `Anthropic がエラーを返しました: ${redactSecrets(ev.error?.message ?? ev.error?.type ?? 'unknown')}`,
        );
      default:
        return [];
    }
  }

  finish(): LlmStreamEvent[] {
    const out: LlmStreamEvent[] = [];
    if (this.thinking.length > 0) out.push({ type: 'thinking_blocks', blocks: this.thinking });
    for (const toolCall of this.calls) out.push({ type: 'tool_call', toolCall });
    out.push({ type: 'usage', usage: this.resolveUsage() });
    const reason = this.stopReason === null ? null : (FINISH_REASONS[this.stopReason] ?? 'stop');
    out.push({ type: 'finish', reason });
    return out;
  }

  /** Tokens × the list price (with the cache prices); the API reports no money. */
  private resolveUsage(): Usage {
    const { input, output, cacheRead, cacheWrite } = this.usage;
    const inputTokens = input + cacheRead + cacheWrite;
    let costUsd = 0;
    let costSource: CostSource = 'unknown';
    const price = this.pricing?.(this.model) as
      (ModelPrice & { basis?: string }) | null | undefined;
    if (price && inputTokens + output > 0) {
      const full: ModelPrice = {
        inputPerMTok: price.inputPerMTok,
        outputPerMTok: price.outputPerMTok,
        cacheReadPerMTok: price.cacheReadPerMTok ?? price.inputPerMTok * 0.1,
        cacheWritePerMTok: price.cacheWritePerMTok ?? price.inputPerMTok * 1.25,
      };
      costUsd = costOf(full, {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      });
      costSource = 'estimated';
    }
    return {
      inputTokens,
      outputTokens: output,
      ...cacheCounts(cacheRead, cacheWrite),
      costUsd,
      costSource,
    };
  }
}

/** Anthropic Messages API streaming client (`anthropic/…` models). */
export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';

  /** Models that answered 400 to a mid-conversation system message (see acceptsMidSystem). */
  private readonly noMidSystem = new Set<string>();

  constructor(private readonly opts: AnthropicProviderOptions) {}

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const midSystem = acceptsMidSystem(req.model) && !this.noMidSystem.has(req.model);
    try {
      yield* retrying(() => this.attempt(req, signal, midSystem), signal, this.opts.retry);
    } catch (err) {
      // Refused before any token: send the same request with the labelled user texts.
      if (!midSystem || !(err instanceof LlmError) || !MID_SYSTEM_REJECTED.test(err.message)) {
        throw err;
      }
      this.noMidSystem.add(req.model);
      yield* retrying(() => this.attempt(req, signal, false), signal, this.opts.retry);
    }
  }

  private async *attempt(
    req: ChatRequest,
    signal: AbortSignal,
    midSystem: boolean,
  ): AsyncIterable<LlmStreamEvent> {
    const { apiKey, baseUrl } = this.opts.connection();
    if (!apiKey) {
      throw new LlmError(
        'llm_not_configured',
        'Anthropic の API キーが設定されていません。設定の接続で指定してください',
      );
    }
    const base = (baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/, '');
    const acc = new AnthropicStreamAccumulator(req.model, this.opts.pricing);
    const messages = fetchSse({
      url: `${base}/v1/messages`,
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: toMessagesBody(req, { midSystem }),
      signal,
      name: 'Anthropic',
      httpError,
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      ...(this.opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: this.opts.idleTimeoutMs } : {}),
    });
    for await (const m of messages) {
      if (!m.data) continue;
      for (const ev of acc.handle(m.event, m.data)) yield ev;
      if (acc.done) break;
    }
    if (!acc.done) for (const ev of acc.finish()) yield ev;
  }
}

export type { ChatMessage as AnthropicChatMessage };
