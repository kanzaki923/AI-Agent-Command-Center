import type { StepHandler } from './types';

/** Report usage as a runtime would (plan.ts `usage`; spec 20261029 §3.12, T5). */
export const usageStep: StepHandler<'usage'> = async function* (_ctx, step) {
  yield {
    type: 'usage',
    phase: step.phase,
    ...(step.component ? { component: step.component } : {}),
    usage: {
      inputTokens: step.inputTokens,
      outputTokens: step.outputTokens,
      costUsd: step.costUsd,
      costSource: step.source,
    },
  };
  return 'next';
};
