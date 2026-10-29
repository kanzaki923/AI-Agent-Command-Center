import type { Actor, Session, Supervision } from '@acc/protocol';
import type { DaemonContext } from '../core/context';

/**
 * Whether a session leads children (spec 20261029 §1.1: the role is derived from the
 * delegation grant). Its user messages run as `orchestrator` runs and it is woken by its
 * inbox.
 */
export function isSupervisor(ctx: DaemonContext, sessionId: string): boolean {
  return (
    ctx.hasService('policy') && ctx.service('policy').sessionAllows(sessionId, 'session.spawn')
  );
}

/**
 * Sessions holding the older orchestrator preset (`session.grantOrchestration`: tasks,
 * task.spawnWorker and the blocking waits). They still run as orchestrators but supervise
 * with task.wait instead of being woken (kept until the code flow moves to session.spawn).
 */
export function isLegacyOrchestrator(ctx: DaemonContext, sessionId: string): boolean {
  return (
    ctx.hasService('policy') &&
    !isSupervisor(ctx, sessionId) &&
    ctx.service('policy').sessionAllows(sessionId, 'task.spawnWorker')
  );
}

/** Run kind of a session's next run. */
export function runKindFor(
  ctx: DaemonContext,
  session: Session,
): 'agent' | 'orchestrator' | 'chat' {
  if (session.kind === 'agent') return 'agent';
  return isSupervisor(ctx, session.id) || isLegacyOrchestrator(ctx, session.id)
    ? 'orchestrator'
    : 'chat';
}

/**
 * Set whether the session may be woken (`paused`: stopped, or the wake limit was hit).
 * Emits session.updated `["supervision"]` and lets the state service re-derive the state.
 */
export function setSupervision(
  ctx: DaemonContext,
  sessionId: string,
  value: Supervision,
  actor: Actor,
): Session {
  const updated = ctx.db.transaction(() => {
    const cur = ctx.repos.sessions.require(sessionId);
    if (cur.supervision === value) return cur;
    const session = ctx.repos.sessions.update(sessionId, (s) => ({
      ...s,
      supervision: value,
      updatedAt: ctx.clock.iso(),
    }));
    ctx.bus.emit({
      type: 'session.updated',
      actor,
      payload: { session, changes: ['supervision'] },
    });
    return session;
  });
  if (ctx.hasService('sessionState')) ctx.service('sessionState').recompute(sessionId);
  return updated;
}
