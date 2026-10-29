import type { StepHandler } from './types';

export const sayStep: StepHandler<'say'> = async function* (ctx, step) {
  yield* ctx.say(step.text);
  return 'next';
};
