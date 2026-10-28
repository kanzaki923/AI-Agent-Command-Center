import type { Usage } from '@acc/protocol';

/** A complete tool call requested by the model (arguments are the raw JSON string). */
export interface ChatToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Provider-neutral chat message (mapped to the OpenAI wire format by the provider). */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ChatToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

/** Function tool offered to the model. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
}

/**
 * Normalized stream every provider produces. Text / reasoning arrive incrementally; tool
 * calls arrive complete (argument fragments already joined) after the text; `usage` and
 * `finish` come last.
 */
export type LlmStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; toolCall: ChatToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: string | null };

export interface ChatResult {
  text: string;
  reasoning: string;
  toolCalls: ChatToolCall[];
  usage: Usage;
  finishReason: string | null;
}

export interface LlmProvider {
  readonly id: string;
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent>;
}

/** USD per 1M tokens, used to estimate cost when the gateway does not report it. */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}
export type PricingLookup = (model: string) => ModelPricing | null;

/**
 * Error from the LLM layer. `code` is a stable machine-readable string (stored in
 * Run.error.code); `message` is user-facing Japanese.
 */
export class LlmError extends Error {
  constructor(
    readonly code:
      | 'llm_not_configured'
      | 'llm_unreachable'
      | 'llm_http_error'
      | 'llm_stream_error'
      | 'llm_model_not_found',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  return new DOMException('The operation was aborted', 'AbortError');
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** Sleep that rejects with an AbortError when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
