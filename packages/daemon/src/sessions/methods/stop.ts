import type { Actor } from '@acc/protocol';
import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';
import { subtreeIds } from '../../home/tree';
import { INBOX_SYSTEM, isSupervisor, setSupervision } from '../../inbox';
import { ACTIVE_RUN_STATUSES } from '../../runs/manager';
import { sessionScope } from './shared';

/** statusReason of runs and tasks stopped with session.stop. */
export const STOPPED_BY_USER = 'stopped_by_user';

/**
 * Task states a stop pauses: work not finished yet. `review` (done, waiting for a person's
 * decision) and the terminal states are left alone: pausing a reviewed change made resume
 * run the finished work again.
 */
const UNFINISHED_TASK_STATUSES = ['pending', 'ready', 'running', 'blocked'] as const;

/**
 * A descendant a tree stop has to touch: it runs, has unfinished work, or supervises (it
 * could be woken). Finished children keep their state (done / review / failed) instead of
 * showing "stopped" for work that already ended.
 */
function hasWorkToStop(ctx: DaemonContext, sessionId: string): boolean {
  const { repos } = ctx;
  if (
    repos.runs.count({ where: { session_id: sessionId, status: [...ACTIVE_RUN_STATUSES] } }) > 0
  ) {
    return true;
  }
  if (
    repos.tasks.count({
      where: { assignee_session_id: sessionId, status: [...UNFINISHED_TASK_STATUSES] },
    }) > 0
  ) {
    return true;
  }
  return isSupervisor(ctx, sessionId);
}

/**
 * session.stop (spec 20261029 §2.2, D10): stop a session and, by default, its whole subtree.
 * Each stopped session gets `supervision: paused` (not woken; its inbox keeps what arrives),
 * its unfinished tasks become `paused` and its active runs are cancelled (`stopped_by_user`).
 * Descendants whose work already ended (done, waiting for review, failed) are not touched.
 * Stopped is not terminal: session.resume continues. The parent is told (child_update) unless
 * the parent itself did the stopping.
 */
export function sessionStop(ctx: DaemonContext) {
  return defineMethod('session.stop', {
    scope: (p) => sessionScope(ctx, p.sessionId),
    handler: (p, call) => stopSessions(ctx, p.sessionId, { tree: p.tree }, call.actor),
  });
}

export function stopSessions(
  ctx: DaemonContext,
  sessionId: string,
  opts: { tree: boolean },
  actor: Actor,
): { stoppedSessionIds: string[]; cancelledRunIds: string[] } {
  const { repos } = ctx;
  const inbox = ctx.service('supervisorInbox');
  return ctx.db.transaction(() => {
    const root = repos.sessions.require(sessionId);
    // The session asked for always stops; below it, only what still has work to stop.
    const ids = (opts.tree ? subtreeIds(ctx, root.id) : [root.id]).filter(
      (id) => id === root.id || hasWorkToStop(ctx, id),
    );
    const cancelledRunIds: string[] = [];
    for (const id of ids) {
      inbox.markStopped(id);
      setSupervision(ctx, id, 'paused', actor);
      // Paused before the runs are cancelled, so whoever follows run ends (workers, T2's
      // completion) sees a paused task instead of a failed one.
      for (const task of repos.tasks.find({ where: { assignee_session_id: id } })) {
        if (!(UNFINISHED_TASK_STATUSES as readonly string[]).includes(task.status)) continue;
        ctx.service('tasks').setStatus(task.id, 'paused', actor, STOPPED_BY_USER);
      }
    }
    for (const id of ids) {
      for (const run of repos.runs.find({
        where: { session_id: id, status: [...ACTIVE_RUN_STATUSES] },
      })) {
        ctx.service('runs').cancel(run.id, actor, STOPPED_BY_USER);
        cancelledRunIds.push(run.id);
      }
    }
    // Tell the parent, unless it stopped its own child (it already knows).
    const parentId = root.parentSessionId;
    const byParent = actor.kind === 'agent' && actor.sessionId === parentId;
    if (parentId && !byParent && !ids.includes(parentId) && isSupervisor(ctx, parentId)) {
      const lastRun = repos.runs.findOne({ where: { session_id: root.id } });
      ctx.service('inbox').deliver(parentId, {
        kind: 'child_update',
        refs: { childSessionId: root.id, ...(lastRun ? { runId: lastRun.id } : {}) },
        actor: INBOX_SYSTEM,
      });
    }
    return { stoppedSessionIds: ids, cancelledRunIds };
  });
}
