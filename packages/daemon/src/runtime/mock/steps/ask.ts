import type { AgentEvent, AgentTool } from '../../../contracts';
import { throwIfAborted } from '../../async';
import type { StepContext, StepHandler, StepOf, StepOutcome } from './types';

/**
 * Ask a human. With the `human.ask` tool (spec 20261029 §3.6) it is a question: the mock asks
 * it, ends the run there (`wait`) and continues when the answer arrives. Without the tool
 * (a run whose grant does not offer it) it is the explicit approval scenario: it asks the
 * approval flow and follows `onReject`.
 */
export const askStep: StepHandler<'ask'> = async function* (ctx, step) {
  const humanAsk = ctx.input.tools?.find((t) => t.method === 'human.ask');
  if (humanAsk) return yield* askQuestion(ctx, step, humanAsk);

  yield* ctx.say(`確認が必要です: ${step.title}`);
  const askInput = { title: step.title, ...(step.detail ? { detail: step.detail } : {}) };
  ctx.gate.asked({ toolName: step.toolName, input: askInput, reason: step.title });
  const decision = await ctx.input.canUseTool({
    toolName: step.toolName,
    input: { title: step.title, ...(step.detail ? { detail: step.detail } : {}) },
    title: step.title,
  });
  if (decision.decision === 'approved') {
    yield* ctx.say('承認されました。続けます。');
    return 'next';
  }
  return yield* ctx.rejected(step.onReject, decision);
};

async function* askQuestion(
  ctx: StepContext,
  step: StepOf<'ask'>,
  tool: AgentTool,
): AsyncGenerator<AgentEvent, StepOutcome, undefined> {
  const toolInput = {
    question: step.title,
    ...(step.choices ? { choices: step.choices } : {}),
    ...(step.allowText !== undefined ? { allowText: step.allowText } : {}),
    ...(step.detail ? { detail: step.detail } : {}),
  };
  const id = yield* ctx.toolCall(
    `確認したいことがあるので質問します: ${step.title}`,
    'human.ask',
    toolInput,
  );
  try {
    const out = await tool.execute(toolInput, { signal: ctx.input.signal });
    yield ctx.result(id, 'human.ask', JSON.stringify(out));
  } catch (err) {
    throwIfAborted(ctx.input.signal);
    yield ctx.result(id, 'human.ask', (err as Error).message, true);
    yield* ctx.say('質問を送れなかったため、確認せずに進めます。');
    return 'next';
  }
  yield* ctx.say('回答が届いたら続きから作業します。ここでいったん区切ります。');
  return 'wait';
}
