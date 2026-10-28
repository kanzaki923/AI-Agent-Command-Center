import { RECOVERABLE_RUN_STATUSES, type SystemActor } from '@acc/protocol';
import type { DaemonContext } from './context';

export interface RecoveryReport {
  interruptedRuns: string[];
  cancelledApprovals: string[];
  releasedWorkspaces: string[];
  clearedSessions: string[];
}

/**
 * Reconcile persisted state after a (re)start. No run can still be executing when the
 * daemon starts, so:
 * - runs in running/queued/awaiting_approval -> interrupted (run.status_changed, reason "daemon_restart")
 * - pending approvals of those runs -> cancelled (approval.resolved)
 * - workspace locks held by those runs -> released (workspace.updated)
 * - session.activeRunId pointing at those runs -> null (session.updated)
 * Whether an interrupted run can be resumed is decided later by the runtime (run.retry).
 */
export function recoverOnStartup(ctx: DaemonContext): RecoveryReport {
  const actor: SystemActor = { kind: 'system', component: 'recovery' };
  const report: RecoveryReport = {
    interruptedRuns: [],
    cancelledApprovals: [],
    releasedWorkspaces: [],
    clearedSessions: [],
  };
  const reason = 'daemon_restart';

  ctx.db.transaction(() => {
    const stale = ctx.repos.runs.find({
      where: { status: [...RECOVERABLE_RUN_STATUSES] },
      direction: 'asc',
    });
    for (const run of stale) {
      const now = ctx.clock.iso();
      const next = ctx.repos.runs.update(run.id, (r) => ({
        ...r,
        status: 'interrupted',
        statusReason: reason,
        updatedAt: now,
        endedAt: r.endedAt ?? now,
      }));
      ctx.bus.emit({
        type: 'run.status_changed',
        actor,
        payload: { runId: run.id, from: run.status, to: 'interrupted', reason },
        refs: {
          projectId: next.projectId,
          sessionId: next.sessionId,
          runId: next.id,
          taskId: next.taskId,
        },
      });
      report.interruptedRuns.push(run.id);

      for (const ap of ctx.repos.approvals.find({ where: { run_id: run.id, status: 'pending' } })) {
        const approval = ctx.repos.approvals.update(ap.id, (a) => ({
          ...a,
          status: 'cancelled',
          resolvedBy: actor,
          resolutionNote: 'Run was interrupted by a daemon restart',
          resolvedAt: now,
        }));
        ctx.bus.emit({ type: 'approval.resolved', actor, payload: { approval } });
        report.cancelledApprovals.push(ap.id);
      }

      for (const w of ctx.repos.workspaces.find({ where: { locked_by_run_id: run.id } })) {
        const workspace = ctx.repos.workspaces.update(w.id, (x) => ({
          ...x,
          lockedByRunId: null,
          updatedAt: now,
        }));
        ctx.bus.emit({
          type: 'workspace.updated',
          actor,
          payload: { workspace, changes: ['lockedByRunId'] },
        });
        report.releasedWorkspaces.push(w.id);
      }

      const session = ctx.repos.sessions.get(run.sessionId);
      if (session?.activeRunId === run.id) {
        const updated = ctx.repos.sessions.update(session.id, (s) => ({
          ...s,
          activeRunId: null,
          updatedAt: now,
        }));
        ctx.bus.emit({
          type: 'session.updated',
          actor,
          payload: { session: updated, changes: ['activeRunId'] },
        });
        report.clearedSessions.push(session.id);
      }
    }
  });

  return report;
}
