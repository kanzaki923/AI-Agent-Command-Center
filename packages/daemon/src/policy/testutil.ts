/** Test helpers shared by policy/tasks tests (not used at runtime). */
import type { AgentActor, Run, RunStatus } from '@acc/protocol';
import { EMPTY_USAGE, isTerminalRunStatus } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { HUMAN } from '../testing';

/** Insert a run row directly (the runs module owns run creation; tests only need the row). */
export function insertRun(
  ctx: DaemonContext,
  input: {
    sessionId: string;
    status?: RunStatus;
    parentRunId?: string | null;
    taskId?: string | null;
    projectId?: string | null;
    budgetId?: string | null;
  },
): Run {
  const now = ctx.clock.iso();
  return ctx.repos.runs.insert({
    id: ctx.ids.next('run'),
    sessionId: input.sessionId,
    projectId: input.projectId ?? null,
    taskId: input.taskId ?? null,
    kind: 'agent',
    status: input.status ?? 'running',
    statusReason: null,
    model: null,
    runtime: null,
    workspaceId: null,
    parentRunId: input.parentRunId ?? null,
    retryOfRunId: null,
    attempt: 1,
    budgetId: input.budgetId ?? null,
    triggerMessageId: null,
    usage: EMPTY_USAGE,
    error: null,
    createdBy: HUMAN,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    endedAt: null,
  });
}

/** Change a run's status and emit run.status_changed the way the runs module does. */
export function setRunStatus(ctx: DaemonContext, runId: string, to: RunStatus): Run {
  return ctx.db.transaction(() => {
    const cur = ctx.repos.runs.require(runId);
    const now = ctx.clock.iso();
    const run = ctx.repos.runs.update(runId, (r) => ({
      ...r,
      status: to,
      updatedAt: now,
      endedAt: isTerminalRunStatus(to) ? now : null,
    }));
    ctx.bus.emit({
      type: 'run.status_changed',
      actor: { kind: 'system', component: 'test' },
      payload: { runId, from: cur.status, to, reason: null },
      refs: { sessionId: run.sessionId, runId, projectId: run.projectId, taskId: run.taskId },
    });
    return run;
  });
}

export function actorOf(run: Run): AgentActor {
  return { kind: 'agent', sessionId: run.sessionId, runId: run.id };
}
