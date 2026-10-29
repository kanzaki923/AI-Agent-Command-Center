/**
 * The mock agent's plan steps, one handler per step type (spec 20261029 §3.12). A track adds
 * a step by adding its schema to `plan.ts` (`MockStep`), a handler file here, and one line
 * below (e.g. T3 `publish`, T4 `ask` → human.ask, T5 per-step usage).
 */
import type { MockStepType, StepHandler } from './types';
import { askStep } from './ask';
import { checkStep } from './check';
import { failStep, sleepStep } from './control';
import { appendStep, writeStep } from './edit';
import { publishStep } from './publish';
import { resolveStep } from './resolve';
import { runStep } from './run';
import { sayStep } from './say';
import { usageStep } from './usage';

export const STEP_HANDLERS: { [T in MockStepType]: StepHandler<T> } = {
  say: sayStep,
  write: writeStep,
  append: appendStep,
  check: checkStep,
  run: runStep,
  resolve: resolveStep,
  ask: askStep,
  sleep: sleepStep,
  fail: failStep,
  publish: publishStep,
  usage: usageStep,
};

export { editFile } from './edit';
export { execCommand } from './run';
export type { MockStepType, Permit, StepContext, StepHandler, StepOutcome } from './types';
