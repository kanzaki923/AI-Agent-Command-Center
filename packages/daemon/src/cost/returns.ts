import { RunStatus, type TaskStatus, isTerminalRunStatus } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { ApiError } from '../core/errors';
import { COST_SYSTEM } from './service';

const ACTIVE_RUN = RunStatus.options.filter((s) => !isTerminalRunStatus(s));

/** Task states after which a child's unused budget goes back to its parent (spec §3.8-5). */
const ENDED: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'done',
  'failed',
  'cancelled',
  'review',
]);

/**
 * Returns a child's unused budget to its parent once its work ended: the task it works on is
 * done / failed / cancelled / review and no run of its session is still going (spec 20261029
 * §3.8-5), except a task that failed because this budget ran out (its budget item stays). Only carved budgets (with a parent) of the child's session are released; a
 * session's own root budget (set by a human) stays. A retry carves again
 * (`BudgetService.reallocate`).
 *
 * Checked after the run or task change has settled (the run manager frees reservations right
 * after the terminal status), and once at startup for children that ended before.
 */
export class BudgetReturns {
  private readonly pending = new Set<string>();
  private closed = false;

  constructor(private readonly ctx: DaemonContext) {}

  start(): void {
    const { ctx } = this;
    const off = ctx.bus.subscribe({ types: ['task.updated', 'run.status_changed'] }, (e) => {
      if (e.type === 'task.updated') {
        const t = e.payload.task;
        if (t.assigneeSessionId && ENDED.has(t.status)) this.schedule(t.assigneeSessionId);
      } else if (e.type === 'run.status_changed' && e.sessionId) {
        if (isTerminalRunStatus(e.payload.to)) this.schedule(e.sessionId);
      }
    });
    ctx.onClose(() => {
      this.closed = true;
      off();
    });
    this.sweep();
  }

  /** Every session with an active carved budget (startup). Returns how many were released. */
  sweep(): number {
    const sessions = new Set(
      this.ctx.repos.budgets
        .find({ where: { subject_kind: 'session', status: 'active' } })
        .filter((b) => b.parentId && b.subject.id)
        .map((b) => b.subject.id!),
    );
    let n = 0;
    for (const id of sessions) n += this.tryReturn(id);
    return n;
  }

  private schedule(sessionId: string): void {
    if (this.pending.has(sessionId)) return;
    this.pending.add(sessionId);
    setImmediate(() => {
      this.pending.delete(sessionId);
      if (!this.closed) this.tryReturn(sessionId);
    });
  }

  /** Release the session's carved budgets when its work ended. Returns how many. */
  tryReturn(sessionId: string): number {
    const { ctx } = this;
    const budgets = ctx.repos.budgets
      .find({ where: { subject_kind: 'session', subject_id: sessionId, status: 'active' } })
      .filter((b) => b.parentId);
    if (budgets.length === 0) return 0;
    const running = ctx.repos.runs.findOne({
      where: { session_id: sessionId, status: ACTIVE_RUN },
    });
    if (running) return 0;
    const session = ctx.repos.sessions.get(sessionId);
    const task =
      (session?.taskId ? ctx.repos.tasks.get(session.taskId) : undefined) ??
      ctx.repos.tasks.findOne({ where: { assignee_session_id: sessionId }, direction: 'desc' });
    if (!task || !ENDED.has(task.status)) return 0;
    // Stopped by this very budget: nothing is left to return, and releasing it would close the
    // budget item a person still has to answer (raise it, or give up).
    if (task.status === 'failed' && task.statusReason === 'budget_exhausted') return 0;
    let released = 0;
    for (const b of budgets) {
      try {
        ctx.service('budget').release(b.id, COST_SYSTEM);
        released += 1;
      } catch (err) {
        // Still in use (a reservation being cancelled, a run starting): the next change retries.
        if (!(err instanceof ApiError && err.code === 'conflict')) {
          ctx.log.error('failed to return a child budget', { budgetId: b.id, err });
        }
      }
    }
    return released;
  }
}
