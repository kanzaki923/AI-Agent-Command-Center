import type { CostSource, Usage } from '@acc/protocol';
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
} from './types';

export interface LiteLlmConnection {
  baseUrl: string | null;
  apiKey: string | null;
}

export interface OpenAiProviderOptions {
  /** Read at call time so settings changes apply without a restart. */
  connection: () => LiteLlmConnection;
  fetch?: typeof fetch;
  pricing?: PricingLookup;
}

/** LiteLLM puts the computed cost of a call in this response header. */
export const LITELLM_COST_HEADER = 'x-litellm-response-cost';

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
      case 'assistant':
        return m.toolCalls && m.toolCalls.length > 0
          ? {
              role: 'assistant',
              content: m.content,
              tool_calls: m.toolCalls.map((t) => ({
                id: t.id,
                type: 'function',
                function: { name: t.name, arguments: t.arguments },
              })),
            }
          : { role: 'assistant', content: m.content ?? '' };
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
  });
}

export function toWireRequest(req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toWireMessages(req.messages),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
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
      tool_calls?: {
        index?: number;
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      }[];
    };
    finish_reason?: unknown;
  }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown } | null;
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

  finish(): LlmStreamEvent[] {
    const out: LlmStreamEvent[] = [];
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
    const usageCost = num(this.usage?.cost);
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
        costUsd =
          (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
        costSource = 'estimated';
      }
    }
    return { inputTokens, outputTokens, costUsd, costSource };
  }
}

/** OpenAI-compatible `/chat/completions` streaming client (pointed at LiteLLM). */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = 'litellm';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAiProviderOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const { baseUrl, apiKey } = this.opts.connection();
    if (!baseUrl) {
      throw new LlmError(
        'llm_not_configured',
        'LiteLLM の接続先が設定されていません。設定で LiteLLM の URL を指定してください',
      );
    }
    const url = joinUrl(baseUrl, 'chat/completions');
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...authHeaders(apiKey),
        },
        body: JSON.stringify(toWireRequest(req)),
        signal,
      });
    } catch (err) {
      if (signal.aborted || isAbortError(err)) throw abortError(signal);
      const cause = (err as { cause?: { code?: unknown } }).cause?.code;
      throw new LlmError(
        'llm_unreachable',
        `LiteLLM（${baseUrl}）に接続できませんでした${typeof cause === 'string' ? `: ${cause}` : ''}`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new LlmError(
        'llm_http_error',
        `LLM の呼び出しに失敗しました（HTTP ${res.status}）${errorDetail(body)}`,
        res.status,
      );
    }
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
        try {
          chunk = await reader.read();
        } catch (err) {
          if (signal.aborted || isAbortError(err)) throw abortError(signal);
          throw new LlmError('llm_stream_error', 'LLM のストリームが途中で切断されました');
        }
        const text = chunk.done
          ? decoder.decode()
          : decoder.decode(chunk.value as Uint8Array, { stream: true });
        const messages = chunk.done ? [...parser.push(text), ...parser.flush()] : parser.push(text);
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
  }
}

/** Short, key-free detail from an error body (OpenAI / LiteLLM `{ error: { message } }`). */
function errorDetail(body: string): string {
  if (!body) return '';
  let msg = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string };
    const e = parsed.error;
    if (typeof e === 'string') msg = e;
    else if (e && typeof e.message === 'string') msg = e.message;
  } catch {
    // plain text body
  }
  msg = msg.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-…').trim();
  return msg ? `: ${msg.length > 300 ? `${msg.slice(0, 300)}…` : msg}` : '';
}
