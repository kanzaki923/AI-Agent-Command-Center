import { sleep } from '../../async';
import type { StepHandler } from './types';

export const sleepStep: StepHandler<'sleep'> = async function* (ctx, step) {
  yield { type: 'activity', text: '待機中' };
  await sleep(step.ms, ctx.input.signal);
  return 'next';
};

export const failStep: StepHandler<'fail'> = async function* (ctx, step) {
  yield* ctx.say(`問題が発生しました: ${step.message}`);
  throw new Error(step.message);
};
