import type { Actor, BudgetAllocation } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { forbidden } from '../core/errors';

/**
 * `session.setBudget` (humans only): the session's own active budget (subject `session`) gets
 * `limitUsd`, is created as a root budget when it has none, or is released with `null` (its
 * unused part goes back to a parent; a run still using it makes that a conflict). New runs of
 * the session use it (sessions/methods/send.ts reads the session's budget).
 */
export function setSessionBudget(
  ctx: DaemonContext,
  sessionId: string,
  limitUsd: number | null,
  actor: Actor,
): BudgetAllocation | null {
  if (actor.kind === 'agent') throw forbidden('予算を変えられるのは人間だけです');
  ctx.repos.sessions.require(sessionId);
  const budget = ctx.service('budget');
  const current = ctx.repos.budgets.findOne({
    where: { subject_kind: 'session', subject_id: sessionId, status: 'active' },
    direction: 'desc',
  });
  if (limitUsd === null) {
    if (!current) return null;
    budget.release(current.id, actor);
    return null;
  }
  if (!current) {
    return budget.createRoot({ subject: { kind: 'session', id: sessionId }, limitUsd, actor });
  }
  return budget.setLimit(current.id, limitUsd, actor);
}
