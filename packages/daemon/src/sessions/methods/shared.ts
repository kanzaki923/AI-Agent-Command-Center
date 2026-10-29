import type { CallScope } from '../../api/registry';
import type { DaemonContext } from '../../core/context';

/**
 * Scope of a call on one session: its project (project-limited grants) and the session itself
 * (agents may only touch their own session tree).
 */
export function sessionScope(ctx: DaemonContext, sessionId: string): CallScope {
  const s = ctx.repos.sessions.get(sessionId);
  return { projectIds: s?.projectId ? [s.projectId] : [], sessionIds: [sessionId] };
}

/** The session's own active budget (e.g. from session.grantOrchestration), applied to its runs. */
export function sessionBudgetId(ctx: DaemonContext, sessionId: string): string | null {
  const budget = ctx.repos.budgets.findOne({
    where: { subject_kind: 'session', subject_id: sessionId, status: 'active' },
    direction: 'desc',
  });
  return budget?.id ?? null;
}
