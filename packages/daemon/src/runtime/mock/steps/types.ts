import type { AgentEvent, AgentRunInput, ApprovalDecision } from '../../../contracts';
import type { ToolGate } from '../../gate';
import type { DenyAction, MockStep } from '../plan';

/**
 * `next`: go on; `stop`: end the plan here (the summary says it stopped); `wait`: end the run
 * here waiting for an answer — the rest of the plan runs when the answer resumes the session.
 */
export type StepOutcome = 'next' | 'stop' | 'wait';

/** What the gate said about a tool use. */
export type Permit =
  | { kind: 'allowed' }
  | { kind: 'denied'; message: string }
  | { kind: 'answered'; decision: ApprovalDecision };

/** Options of the mock runtime that steps read. */
export interface StepOptions {
  /** Environment commands are run with (filtered by the allowlist). Default: process.env. */
  parentEnv?: NodeJS.ProcessEnv;
}

/**
 * The primitives of one mock run that step handlers use (implemented by the run itself):
 * narrate, announce a tool call, ask the gate, report results. Every tool use goes through
 * `permit` (the same gate as real agents).
 */
export interface StepContext {
  readonly input: AgentRunInput;
  readonly opts: StepOptions;
  readonly gate: ToolGate;
  /** Files changed so far (workspace-relative, posix). */
  readonly changed: Map<string, 'created' | 'updated'>;
  say(text: string): AsyncGenerator<AgentEvent, void, undefined>;
  /** Narrate, then announce a tool call; returns its tool call id. */
  toolCall(
    text: string,
    name: string,
    toolInput: unknown,
  ): AsyncGenerator<AgentEvent, string, undefined>;
  result(toolCallId: string, name: string, output: string, isError?: boolean): AgentEvent;
  /** The gate's answer; asks a human only when the gate says so. */
  permit(toolName: string, toolInput: unknown, toolCallId: string): Promise<Permit>;
  /** A denied tool use: the reason goes back as the tool's error, then the agent adapts. */
  denied(
    toolCallId: string,
    toolName: string,
    permit: Extract<Permit, { kind: 'denied' }>,
    action: DenyAction,
  ): AsyncGenerator<AgentEvent, StepOutcome, undefined>;
  rejected(
    action: 'stop' | 'continue' | 'fail',
    decision: ApprovalDecision,
  ): AsyncGenerator<AgentEvent, StepOutcome, undefined>;
  /** Absolute path of a workspace-relative path. */
  abs(relPath: string): string;
}

export type MockStepType = MockStep['type'];
export type StepOf<T extends MockStepType> = Extract<MockStep, { type: T }>;

/** Runs one plan step. Add a step: a schema entry in plan.ts + a handler in steps/. */
export type StepHandler<T extends MockStepType> = (
  ctx: StepContext,
  step: StepOf<T>,
) => AsyncGenerator<AgentEvent, StepOutcome, undefined>;

export function toPosix(p: string): string {
  return p.split('\\').join('/');
}
