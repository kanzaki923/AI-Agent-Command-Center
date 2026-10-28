import {
  type Integration,
  type IntegrationStatus,
  type Params,
  type Result,
  SETTLED_INTEGRATION_STATUSES,
  SETTLED_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  type Task,
  type TaskSnapshot,
  type TaskStatus,
} from '@acc/protocol';
import type { DaemonContext } from '../core/context';

const REACHED: Record<Params<'task.wait'>['until'], readonly TaskStatus[]> = {
  settled: SETTLED_TASK_STATUSES,
  review_or_terminal: ['review', ...TERMINAL_TASK_STATUSES],
  terminal: TERMINAL_TASK_STATUSES,
};

/** Compact supervisor view of a task: status, its latest run, approvals and diff stats. */
export function taskSnapshot(ctx: DaemonContext, task: Task): TaskSnapshot {
  const { repos } = ctx;
  const run = repos.runs.findOne({ where: { task_id: task.id }, direction: 'desc' });
  const diff = repos.artifacts.findOne({
    where: { task_id: task.id, kind: 'diff' },
    direction: 'desc',
  });
  const ws = task.workspaceId ? repos.workspaces.get(task.workspaceId) : undefined;
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    statusReason: task.statusReason,
    assigneeSessionId: task.assigneeSessionId,
    workspaceId: task.workspaceId,
    branch: ws?.branch ?? null,
    run: run
      ? { id: run.id, status: run.status, activity: run.activity ?? null, error: run.error }
      : null,
    pendingApprovals: repos.approvals.count({ where: { task_id: task.id, status: 'pending' } }),
    diff: diff?.kind === 'diff' ? diff.data.stats : null,
    resultSummary: task.resultSummary,
    updatedAt: task.updatedAt,
  };
}

/**
 * task.wait: long poll over task.updated. Checks the current state first, then sleeps on the
 * event bus (no polling) until the condition holds, the timeout elapses or the call is
 * aborted (client disconnect / run cancelled / daemon shutdown).
 */
export async function waitForTasks(
  ctx: DaemonContext,
  p: Params<'task.wait'>,
  signal: AbortSignal,
): Promise<Result<'task.wait'>> {
  const ids = [...new Set(p.taskIds)];
  const reachedStatuses = REACHED[p.until];
  const deadline = Date.now() + p.timeoutMs;
  for (;;) {
    const tasks = ids.map((id) => ctx.repos.tasks.require(id));
    const reached = tasks.filter((t) => reachedStatuses.includes(t.status)).map((t) => t.id);
    const met = p.mode === 'all' ? reached.length === tasks.length : reached.length > 0;
    const remaining = deadline - Date.now();
    if (met || remaining <= 0 || signal.aborted) {
      return { reached, tasks: tasks.map((t) => taskSnapshot(ctx, t)), timedOut: !met };
    }
    const watched = new Set(ids);
    await ctx.bus.waitFor(
      { types: ['task.updated'] },
      (e) => e.type === 'task.updated' && watched.has(e.payload.task.id),
      { timeoutMs: remaining, signal },
    );
  }
}

/** integration.wait: like task.wait for one integration. */
export async function waitForIntegration(
  ctx: DaemonContext,
  p: Params<'integration.wait'>,
  signal: AbortSignal,
): Promise<{ integration: Integration; timedOut: boolean }> {
  const settled: readonly IntegrationStatus[] = SETTLED_INTEGRATION_STATUSES;
  const deadline = Date.now() + p.timeoutMs;
  for (;;) {
    const integration = ctx.repos.integrations.require(p.integrationId);
    const met = settled.includes(integration.status);
    const remaining = deadline - Date.now();
    if (met || remaining <= 0 || signal.aborted) return { integration, timedOut: !met };
    await ctx.bus.waitFor(
      { types: ['integration.updated'] },
      (e) => e.type === 'integration.updated' && e.payload.integration.id === p.integrationId,
      { timeoutMs: remaining, signal },
    );
  }
}
