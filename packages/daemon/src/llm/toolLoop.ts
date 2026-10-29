import { type ContentPart, EMPTY_USAGE, type RunStopReason, type Usage } from '@acc/protocol';
import type { ApprovalRequest, RunController } from '../contracts';
import type { DaemonContext } from '../core/context';
import { ApiError } from '../core/errors';
import type { LlmGateway } from './gateway';
import { stringifyToolOutput } from './messages';
import { type LoopTool, methodForToolName } from './tools';
import { type ChatMessage, type ChatToolCall, abortError, isAbortError } from './types';

export interface ToolLoopOptions {
  ctx: DaemonContext;
  ctl: RunController;
  model: string;
  /** Conversation so far (system prompt included). Not mutated; see result.messages. */
  messages: ChatMessage[];
  tools?: LoopTool[];
  /** Max model calls (default 20). The loop stops with stopReason "max_turns" after that. */
  maxTurns?: number;
  /**
   * Fail the run instead (RunStopError `turn_limit`) when the model wants more than
   * `maxTurns` calls. Runs use this (spec 20261029 §3.2); plain loop users get a result.
   */
  failOnTurnLimit?: boolean;
  /**
   * Stop with RunStopError `loop_detected` when the model makes the same tool calls (same
   * arguments) or writes the same text in `LOOP_REPEATS` consecutive replies. Default true.
   */
  detectLoops?: boolean;
  /**
   * Messages that arrived while the loop ran (a user writing to a busy session). Called at
   * each step boundary — after a turn's tool results, before the next model call — and once
   * after the model answered without tools; what it returns is added to the conversation
   * and the loop continues instead of ending (spec 20261029 §3.2).
   */
  inject?: () => ChatMessage[];
  temperature?: number;
  /**
   * Called before each tool execution. Return an ApprovalRequest to require a decision
   * (the run waits in awaiting_approval); null runs the tool directly.
   */
  approvalFor?: (call: { tool: LoopTool; input: unknown }) => ApprovalRequest | null;
  /** Defaults to ctx.service('llm'). */
  gateway?: LlmGateway;
  /** Budget reserved before each model call (default: settings.llmCallReserveUsd). */
  reserveUsd?: number;
}

export interface ToolLoopResult {
  /** Input messages plus everything the loop added. */
  messages: ChatMessage[];
  /** Text of the final assistant message. */
  text: string;
  turns: number;
  stopReason: 'done' | 'max_turns';
  /** Usage summed over all model calls of this loop. */
  usage: Usage;
}

export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    costUsd: a.costUsd + (b.costUsd ?? 0),
    costSource: b.costSource ?? a.costSource,
  };
}

/** Same tool calls or same text this many replies in a row → loop_detected. */
export const LOOP_REPEATS = 3;

const STOP_MESSAGES: Record<'turn_limit' | 'loop_detected', (n: number) => string> = {
  turn_limit: (n) => `モデルの呼び出しが 1 回の実行の上限（${n} 回）に達したため止めました`,
  loop_detected: () => '同じ操作か同じ返事を繰り返していたため止めました',
};

/**
 * Thrown when the daemon stops a run on its own (turn limit, loop). `code` becomes the run's
 * statusReason and error code (runs/manager.ts).
 */
export class RunStopError extends Error {
  constructor(
    readonly code: RunStopReason,
    message: string,
  ) {
    super(message);
    this.name = 'RunStopError';
  }
}

/** Counts how often the same value came in a row. */
class RepeatCounter {
  private last: string | null = null;
  private n = 0;

  /** Record a value (null breaks the streak) and return the length of the current streak. */
  push(value: string | null): number {
    if (value === null) {
      this.last = null;
      this.n = 0;
      return 0;
    }
    this.n = value === this.last ? this.n + 1 : 1;
    this.last = value;
    return this.n;
  }
}

function callSignature(calls: ChatToolCall[]): string | null {
  if (calls.length === 0) return null;
  const parts = calls.map((c) => {
    const parsed = parseArguments(c.arguments);
    return `${c.name}:${parsed.ok ? stableJson(parsed.value) : c.arguments}`;
  });
  return parts.sort().join('\n');
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function parseArguments(raw: string): { ok: true; value: unknown } | { ok: false } {
  if (raw.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

function errorOutput(err: unknown): { error: { code: string; message: string } } {
  if (err instanceof ApiError) return { error: { code: err.code, message: err.message } };
  const code =
    err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : 'internal';
  return { error: { code, message: err instanceof Error ? err.message : String(err) } };
}

/**
 * The agentic loop shared by chat runs and the orchestrator:
 * messages → model → tool calls → tools (Control API through the dispatcher, as the run's
 * actor) → tool results → model → ... until the model answers without tool calls.
 *
 * Everything is reported through the RunController: text deltas, the assistant / tool
 * messages (persisted), tool.called / tool.result events, usage, the activity line and
 * approvals. Tool failures are returned to the model as `{ error }` results instead of
 * failing the run; aborts (cancel / shutdown) propagate.
 */
export async function runToolLoop(opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const { ctx, ctl, model } = opts;
  const gateway = opts.gateway ?? ctx.service('llm');
  const tools = opts.tools ?? [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const specs = tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  const maxTurns = opts.maxTurns ?? 20;
  const messages = [...opts.messages];
  let usage: Usage = { ...EMPTY_USAGE };
  let text = '';
  const sameCalls = new RepeatCounter();
  const sameText = new RepeatCounter();
  const injected = (): boolean => {
    const more = opts.inject?.() ?? [];
    messages.push(...more);
    return more.length > 0;
  };

  for (let turn = 0; ; turn++) {
    if (turn >= maxTurns) {
      if (opts.failOnTurnLimit) {
        throw new RunStopError('turn_limit', STOP_MESSAGES.turn_limit(maxTurns));
      }
      return { messages, text, turns: turn, stopReason: 'max_turns', usage };
    }
    if (ctl.signal.aborted) throw abortError(ctl.signal);
    // Reserve before the call (throws budget_exceeded when it does not fit), settle after.
    const hold = ctl.reserveBudget(opts.reserveUsd);

    const messageId = ctx.ids.next('message');
    let partial = '';
    ctl.setActivity(turn === 0 ? '応答を生成しています' : 'ツールの結果をもとに考えています');
    let result;
    try {
      result = await gateway.complete(
        {
          model,
          messages,
          ...(specs.length > 0 ? { tools: specs } : {}),
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        },
        {
          signal: ctl.signal,
          onText: (t) => {
            partial += t;
            ctl.emitDelta(messageId, t);
          },
          onReasoning: (t) => ctl.emitDelta(messageId, t, 'reasoning'),
        },
      );
    } catch (err) {
      // No usage was reported for a failed call: free the reservation.
      hold.cancel();
      // Keep what the user already saw streaming (e.g. cancelled mid-reply).
      if (partial) {
        ctl.appendMessage({
          id: messageId,
          role: 'assistant',
          content: [{ type: 'text', text: partial }],
          model,
        });
      }
      throw err;
    }
    hold.settle(result.usage);
    usage = addUsage(usage, result.usage);
    text = result.text;

    const calls = result.toolCalls.map((tc) => ({
      tc,
      tool: byName.get(tc.name),
      args: parseArguments(tc.arguments),
    }));
    const content: ContentPart[] = [];
    if (result.reasoning) content.push({ type: 'reasoning', text: result.reasoning });
    if (result.text || calls.length === 0) content.push({ type: 'text', text: result.text });
    for (const c of calls) {
      content.push({
        type: 'tool_call',
        toolCallId: c.tc.id,
        name: c.tool?.method ?? methodForToolName(c.tc.name),
        input: c.args.ok ? c.args.value : c.tc.arguments,
      });
    }
    ctl.appendMessage({ id: messageId, role: 'assistant', content, model });
    messages.push({
      role: 'assistant',
      content: result.text || null,
      ...(calls.length > 0 ? { toolCalls: calls.map((c) => c.tc) } : {}),
      // Sent back with the tool results (Anthropic thinking requires it); not persisted.
      ...(result.thinkingBlocks.length > 0 ? { thinkingBlocks: result.thinkingBlocks } : {}),
    });
    if (opts.detectLoops !== false) {
      const callRepeats = sameCalls.push(callSignature(result.toolCalls));
      const textRepeats = sameText.push(result.text.trim() || null);
      if (callRepeats >= LOOP_REPEATS || textRepeats >= LOOP_REPEATS) {
        throw new RunStopError('loop_detected', STOP_MESSAGES.loop_detected(LOOP_REPEATS));
      }
    }
    if (calls.length === 0) {
      // About to end: a message that arrived meanwhile keeps the loop going.
      if (injected()) continue;
      return { messages, text, turns: turn + 1, stopReason: 'done', usage };
    }

    for (const c of calls) {
      const output = await executeTool(ctl, c, opts.approvalFor);
      messages.push({
        role: 'tool',
        toolCallId: c.tc.id,
        content: stringifyToolOutput(output.value),
      });
    }
    // Step boundary: every tool result of this turn is in; hand over what arrived.
    injected();
  }
}

async function executeTool(
  ctl: RunController,
  c: {
    tc: ChatToolCall;
    tool: LoopTool | undefined;
    args: { ok: true; value: unknown } | { ok: false };
  },
  approvalFor: ToolLoopOptions['approvalFor'],
): Promise<{ value: unknown; isError: boolean }> {
  const name = c.tool?.method ?? methodForToolName(c.tc.name);
  const input = c.args.ok ? c.args.value : c.tc.arguments;
  ctl.toolCalled({ toolCallId: c.tc.id, name, input });

  let out: { value: unknown; isError: boolean };
  if (!c.tool) {
    out = {
      value: { error: { code: 'unknown_tool', message: `Unknown tool: ${c.tc.name}` } },
      isError: true,
    };
  } else if (!c.args.ok) {
    out = {
      value: { error: { code: 'invalid_arguments', message: 'Arguments must be a JSON object.' } },
      isError: true,
    };
  } else {
    const tool = c.tool;
    const req = approvalFor?.({ tool, input });
    const decision = req ? await ctl.requestApproval(req) : null;
    if (decision?.decision === 'rejected') {
      out = {
        value: {
          error: {
            code: 'rejected',
            message: decision.note
              ? `Rejected by reviewer: ${decision.note}`
              : 'Rejected by reviewer.',
          },
        },
        isError: true,
      };
    } else {
      ctl.setActivity(`ツールを実行しています: ${name}`);
      try {
        out = { value: await tool.execute(input, { signal: ctl.signal }), isError: false };
      } catch (err) {
        if (ctl.signal.aborted || isAbortError(err)) throw err;
        out = { value: errorOutput(err), isError: true };
      }
    }
  }

  ctl.toolResult({ toolCallId: c.tc.id, name, output: out.value, isError: out.isError });
  ctl.appendMessage({
    role: 'tool',
    content: [
      {
        type: 'tool_result',
        toolCallId: c.tc.id,
        name,
        output: out.value,
        isError: out.isError,
      },
    ],
  });
  return out;
}
