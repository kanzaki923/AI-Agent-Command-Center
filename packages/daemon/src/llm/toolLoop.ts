import { type ContentPart, EMPTY_USAGE, type Usage } from '@acc/protocol';
import type { ApprovalRequest, RunController } from '../contracts';
import type { DaemonContext } from '../core/context';
import { ApiError, budgetExceeded } from '../core/errors';
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
  temperature?: number;
  /**
   * Called before each tool execution. Return an ApprovalRequest to require a decision
   * (the run waits in awaiting_approval); null runs the tool directly.
   */
  approvalFor?: (call: { tool: LoopTool; input: unknown }) => ApprovalRequest | null;
  /** Defaults to ctx.service('llm'). */
  gateway?: LlmGateway;
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

/** Fail fast before a model call when the run's budget is already used up. */
function assertBudgetLeft(ctx: DaemonContext, ctl: RunController): void {
  const budgetId = ctl.run.budgetId;
  if (!budgetId || !ctx.hasService('budget')) return;
  const b = ctx.service('budget').get(budgetId);
  if (b.limitUsd - b.allocatedUsd - b.reservedUsd - b.spentUsd <= 0) {
    throw budgetExceeded('予算の上限に達したため、LLM を呼び出せません', { budgetId });
  }
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

  for (let turn = 0; ; turn++) {
    if (turn >= maxTurns) {
      return { messages, text, turns: turn, stopReason: 'max_turns', usage };
    }
    if (ctl.signal.aborted) throw abortError(ctl.signal);
    assertBudgetLeft(ctx, ctl);

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
    ctl.reportUsage(result.usage);
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
    });
    if (calls.length === 0) {
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
