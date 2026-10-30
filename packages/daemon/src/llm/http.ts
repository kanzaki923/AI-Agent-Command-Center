import { retryDelayMs, type RetryOptions, DEFAULT_LLM_IDLE_TIMEOUT_MS } from './openai';
import { type SseMessage, SseParser } from './sse';
import { LlmError, type LlmStreamEvent, abortError, isAbortError, sleep } from './types';

export interface SseFetchOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  fetch?: typeof fetch;
  /** No bytes for this long aborts the call (default 5 min). */
  idleTimeoutMs?: number;
  /** Name of the service in messages (e.g. "Anthropic"). */
  name: string;
  /** The error for a non-2xx answer (the body is read for it). */
  httpError: (status: number, body: string, retryAfterMs?: number) => LlmError;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s % 60 === 0 && s >= 60 ? `${s / 60} 分` : `${s} 秒`;
}

/** `Retry-After`: seconds or an HTTP date. */
function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * POST a JSON body and read the answer as Server-Sent Events, with the idle timeout and the
 * error mapping every provider needs (the OpenAI-compatible client in openai.ts predates this
 * and keeps its own copy). Yields parsed messages; throws LlmError.
 */
export async function* fetchSse(o: SseFetchOptions): AsyncIterable<SseMessage> {
  const fetchImpl = o.fetch ?? globalThis.fetch.bind(globalThis);
  if (o.signal.aborted) throw abortError(o.signal);
  const idleMs = o.idleTimeoutMs ?? DEFAULT_LLM_IDLE_TIMEOUT_MS;
  const ctl = new AbortController();
  const forward = () => ctl.abort(o.signal.reason);
  o.signal.addEventListener('abort', forward, { once: true });
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
      `${o.name} から${formatDuration(idleMs)}以上応答がないため停止しました`,
    );
  try {
    let res: Response;
    arm();
    try {
      res = await fetchImpl(o.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...o.headers },
        body: JSON.stringify(o.body),
        signal: ctl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw o.httpError(res.status, body, retryAfterMs(res.headers.get('retry-after')));
      }
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (timedOut) throw timeout();
      if (o.signal.aborted || isAbortError(err)) throw abortError(o.signal);
      const cause = (err as { cause?: { code?: unknown } }).cause?.code;
      throw new LlmError(
        'llm_unreachable',
        `${o.name}（${o.url}）に接続できませんでした${typeof cause === 'string' ? `: ${cause}` : ''}`,
      );
    } finally {
      disarm();
    }
    if (!res.body) throw new LlmError('llm_stream_error', `${o.name} の応答が空でした`);
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
          if (o.signal.aborted || isAbortError(err)) throw abortError(o.signal);
          throw new LlmError('llm_stream_error', `${o.name} のストリームが途中で切断されました`);
        } finally {
          disarm();
        }
        const text = chunk.done
          ? decoder.decode()
          : decoder.decode(chunk.value as Uint8Array, { stream: true });
        const messages = chunk.done ? [...parser.push(text), ...parser.flush()] : parser.push(text);
        for (const m of messages) yield m;
        if (chunk.done) break;
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
  } finally {
    disarm();
    o.signal.removeEventListener('abort', forward);
  }
}

/**
 * Run `attempt` and retry it (429 / 5xx / no connection, honouring Retry-After) as long as
 * nothing was received yet; once a token arrived a failure is final.
 */
export async function* retrying(
  attempt: () => AsyncIterable<LlmStreamEvent>,
  signal: AbortSignal,
  retry: RetryOptions = {},
): AsyncIterable<LlmStreamEvent> {
  for (let n = 0; ; n++) {
    let received = false;
    try {
      for await (const ev of attempt()) {
        received = true;
        yield ev;
      }
      return;
    } catch (err) {
      const wait = received || signal.aborted ? null : retryDelayMs(err, n, retry);
      if (wait === null) throw err;
      await (retry.sleep ?? sleep)(wait, signal);
    }
  }
}

/** JSON of an SSE payload, or an `llm_stream_error`. */
export function parseJson<T>(name: string, data: string): T {
  try {
    return JSON.parse(data) as T;
  } catch {
    throw new LlmError('llm_stream_error', `${name} のストリームを解釈できませんでした`);
  }
}

/** The message (and code) of a JSON error body: `{error: {message, code, type}}` or `{detail}`. */
export function errorBody(body: string): {
  message: string;
  code: string | null;
  param: string | null;
} {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown; code?: unknown; type?: unknown; param?: unknown } | string;
      detail?: unknown;
    };
    const e = parsed.error;
    if (typeof e === 'string') return { message: e, code: null, param: null };
    if (e && typeof e === 'object') {
      return {
        message: typeof e.message === 'string' ? e.message : body,
        code: typeof e.code === 'string' ? e.code : typeof e.type === 'string' ? e.type : null,
        param: typeof e.param === 'string' ? e.param : null,
      };
    }
    if (typeof parsed.detail === 'string')
      return { message: parsed.detail, code: null, param: null };
  } catch {
    // plain text
  }
  return { message: body, code: null, param: null };
}

/** A string field of a loosely typed payload, or the fallback. */
export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
}

/** Keys and tokens never reach messages or logs. */
export function redactSecrets(text: string): string {
  return text.replace(/\b(sk-[A-Za-z0-9_-]{6,}|eyJ[A-Za-z0-9_-]{20,})/g, '…');
}
