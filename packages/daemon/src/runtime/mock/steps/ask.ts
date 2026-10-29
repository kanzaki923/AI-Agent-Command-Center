import type { StepHandler } from './types';

/**
 * Ask a human (the approval flow). T4 turns this into `human.ask` (a question, not an
 * approval; spec 20261029 §3.6).
 */
export const askStep: StepHandler<'ask'> = async function* (ctx, step) {
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
