import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';
import { setSessionBudget } from '../../cost/sessionBudget';
import { sessionScope } from './shared';

/** session.setBudget: set or remove the budget of a session tree (humans only, T5 Cost). */
export function sessionSetBudget(ctx: DaemonContext) {
  return defineMethod('session.setBudget', {
    scope: (p) => sessionScope(ctx, p.sessionId),
    handler: (p, call) => ({
      budget: setSessionBudget(ctx, p.sessionId, p.limitUsd, call.actor),
    }),
  });
}
