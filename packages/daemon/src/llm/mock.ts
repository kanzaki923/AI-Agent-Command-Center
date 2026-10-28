import type { ModelInfo, Usage } from '@acc/protocol';
import {
  type ChatMessage,
  type ChatRequest,
  LlmError,
  type LlmProvider,
  type LlmStreamEvent,
  abortError,
  sleep,
} from './types';

/** What a mock model answers for one call. */
export interface MockReply {
  text?: string;
  reasoning?: string;
  /** Scripted tool calls (emitted after the text, like real models do). */
  toolCalls?: { name: string; input?: unknown; id?: string }[];
  /** Override the computed usage (e.g. to exercise budgets). */
  usage?: Partial<Usage>;
  /** Fail the call with this message (after streaming the text, if any). */
  error?: string;
}

export interface MockCallInfo {
  /**
   * Model calls already made in the current turn: the number of assistant messages after
   * the last user message. 0 for the first call, 1 after one round of tool results, ...
   */
  turn: number;
  /** Text of the last user message ('' if none). */
  lastUserText: string;
  /** The trailing tool messages (results of the previous turn's tool calls). */
  toolResults: Extract<ChatMessage, { role: 'tool' }>[];
}

export type MockResponder = (
  req: ChatRequest,
  info: MockCallInfo,
) => MockReply | Promise<MockReply>;

export interface MockModelOptions {
  label?: string;
  /** Delay between streamed chunks. Defaults to the provider's delay. */
  chunkDelayMs?: number;
  /** Characters per streamed chunk (default 4). */
  chunkSize?: number;
}

interface MockModel {
  info: ModelInfo;
  responder: MockResponder;
  opts: MockModelOptions;
}

export const MOCK_PREFIX = 'mock/';

/** Context info derived from a request, shared by scripts. */
export function mockCallInfo(req: ChatRequest): MockCallInfo {
  let lastUser = -1;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i]!.role === 'user') {
      lastUser = i;
      break;
    }
  }
  const after = req.messages.slice(lastUser + 1);
  const toolResults: MockCallInfo['toolResults'] = [];
  for (let i = req.messages.length - 1; i > lastUser; i--) {
    const m = req.messages[i]!;
    if (m.role !== 'tool') break;
    toolResults.unshift(m);
  }
  const u = lastUser >= 0 ? req.messages[lastUser] : undefined;
  return {
    turn: after.filter((m) => m.role === 'assistant').length,
    lastUserText: u?.role === 'user' ? u.content : '',
    toolResults,
  };
}

/**
 * A scripted multi-turn conversation: step `n` answers the n-th model call of a turn (see
 * MockCallInfo.turn). Steps are replies or functions of the request (e.g. to read tool
 * results). Past the last step the model answers with empty text, ending the loop.
 *
 * ```ts
 * llm.mock.define('mock/demo', scripted([
 *   { text: '一覧を見ます', toolCalls: [{ name: 'session__list', input: {} }] },
 *   (_req, info) => ({ text: `結果: ${info.toolResults[0]?.content}` }),
 * ]));
 * ```
 */
export function scripted(steps: (MockReply | MockResponder)[]): MockResponder {
  return (req, info) => {
    const step = steps[info.turn];
    if (step === undefined) return { text: '' };
    return typeof step === 'function' ? step(req, info) : step;
  };
}

const echoResponder: MockResponder = (_req, info) => {
  if (info.toolResults.length > 0) {
    return { text: `ツールの結果を ${info.toolResults.length} 件受け取りました。` };
  }
  return {
    text: info.lastUserText ? `エコー: ${info.lastUserText}` : 'エコー: （空のメッセージ）',
  };
};

const estimateTokens = (chars: number) => Math.ceil(chars / 4);

/**
 * Deterministic offline provider for tests, demos and keyless use. Built-in models:
 * - `mock/echo`: echoes the last user message with realistic chunk timing
 * - `mock/fast`: same reply, streamed without delay
 * Add more with `define(model, responder)` (the hook the demo orchestrator uses).
 */
export class MockProvider implements LlmProvider {
  readonly id = 'mock';
  private readonly models = new Map<string, MockModel>();
  private callCounter = 0;
  /** Default delay between chunks for models without their own (tests set 0). */
  chunkDelayMs = 30;

  constructor() {
    this.define('mock/echo', echoResponder, { label: 'モック（エコー）' });
    this.define('mock/fast', echoResponder, { label: 'モック（高速）', chunkDelayMs: 0 });
  }

  /** Define (or replace) a mock model. Returns a function that removes it. */
  define(model: string, responder: MockResponder, opts: MockModelOptions = {}): () => void {
    if (!model.startsWith(MOCK_PREFIX)) {
      throw new Error(`Mock model ids must start with "${MOCK_PREFIX}": ${model}`);
    }
    const entry: MockModel = {
      info: { id: model, label: opts.label ?? model, provider: 'mock' },
      responder,
      opts,
    };
    this.models.set(model, entry);
    return () => {
      if (this.models.get(model) === entry) this.models.delete(model);
    };
  }

  has(model: string): boolean {
    return this.models.has(model);
  }

  list(): ModelInfo[] {
    return [...this.models.values()].map((m) => m.info);
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const model = this.models.get(req.model);
    if (!model) {
      throw new LlmError('llm_model_not_found', `モックモデルが見つかりません: ${req.model}`);
    }
    const reply = await model.responder(req, mockCallInfo(req));
    const delay = model.opts.chunkDelayMs ?? this.chunkDelayMs;
    const size = Math.max(1, model.opts.chunkSize ?? 4);

    for (const [type, text] of [
      ['reasoning', reply.reasoning ?? ''],
      ['text', reply.text ?? ''],
    ] as const) {
      // Split by code point so surrogate pairs (emoji) stay intact.
      const chars = Array.from(text);
      for (let i = 0; i < chars.length; i += size) {
        if (signal.aborted) throw abortError(signal);
        await sleep(delay, signal);
        yield { type, text: chars.slice(i, i + size).join('') };
      }
    }
    if (reply.error) throw new LlmError('llm_stream_error', reply.error);
    await sleep(delay, signal);

    for (const tc of reply.toolCalls ?? []) {
      yield {
        type: 'tool_call',
        toolCall: {
          id: tc.id ?? `call_mock_${++this.callCounter}`,
          name: tc.name,
          arguments: JSON.stringify(tc.input ?? {}),
        },
      };
    }
    const promptChars = req.messages.reduce(
      (n, m) =>
        n +
        (m.content?.length ?? 0) +
        (m.role === 'assistant'
          ? (m.toolCalls ?? []).reduce((k, t) => k + t.arguments.length, 0)
          : 0),
      0,
    );
    const outChars =
      (reply.text?.length ?? 0) +
      (reply.toolCalls ?? []).reduce((k, t) => k + JSON.stringify(t.input ?? {}).length, 0);
    yield {
      type: 'usage',
      usage: {
        inputTokens: estimateTokens(promptChars),
        outputTokens: estimateTokens(outChars),
        costUsd: 0,
        costSource: 'reported',
        ...reply.usage,
      },
    };
    yield { type: 'finish', reason: reply.toolCalls?.length ? 'tool_calls' : 'stop' };
  }
}
