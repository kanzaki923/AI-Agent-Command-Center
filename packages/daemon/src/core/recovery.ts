import { RECOVERABLE_RUN_STATUSES, type SystemActor } from '@acc/protocol';
import type { DaemonContext } from './context';

/**
 * Withdraw the open attention items of a cancelled approval (spec 20261029 §3.10-2). Runs
 * before the modules register, so it writes the rows itself (the attention module's own
 * startup check catches any it could not see).
 */
function resolveApprovalAttention(
  ctx: DaemonContext,
  approvalId: string,
  actor: SystemActor,
  now: string,
): string[] {
  const out: string[] = [];
  for (const att of ctx.repos.attention.find({
    where: { status: 'open', kind: 'approval' },
    sql: { clause: "json_extract(data, '$.refs.approvalId') = ?", params: [approvalId] },
  })) {
    const attention = ctx.repos.attention.update(att.id, (a) => ({
      ...a,
      status: 'resolved',
      resolution: { choiceId: null, text: null, by: actor },
      resolvedAt: now,
    }));
    ctx.bus.emit({
      type: 'attention.resolved',
      actor,
      payload: { attention },
      refs: { sessionId: attention.sessionId, runId: null, taskId: null },
    });
    out.push(att.id);
  }
  return out;
}

export interface RecoveryReport {
  interruptedRuns: string[];
  cancelledApprovals: string[];
  /** Approval attention items withdrawn with their approvals (questions are kept). */
  resolvedAttention: string[];
  releasedWorkspaces: string[];
  clearedSessions: string[];
}

/**
 * Reconcile persisted state after a (re)start. No run can still be executing when the
 * daemon starts, so:
 * - runs in running/queued/awaiting_approval -> interrupted (run.status_changed, reason "daemon_restart")
 * - pending approvals of those runs -> cancelled (approval.resolved), and their attention
 *   items resolved (attention.resolved; the resumed agent asks again if it still needs to).
 *   Questions stay open: they belong to the session, and the answer starts a new run.
 * - workspace locks held by those runs -> released (workspace.updated)
 * - session.activeRunId pointing at those runs -> null (session.updated)
 * Whether an interrupted run can be resumed is decided later by the runtime (run.retry).
 */
export function recoverOnStartup(ctx: DaemonContext): RecoveryReport {
  const actor: SystemActor = { kind: 'system', component: 'recovery' };
  const report: RecoveryReport = {
    interruptedRuns: [],
    cancelledApprovals: [],
    resolvedAttention: [],
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
        report.resolvedAttention.push(...resolveApprovalAttention(ctx, ap.id, actor, now));
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
