import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';
import { buildSessionTree } from '../../home/home';
import { sessionScope } from './shared';

/**
 * session.tree: the session's tree as cards (state, what it is doing, spend, outputs), depth
 * first. Agents see their own subtree only (architecture.md §2.19).
 */
export function sessionTree(ctx: DaemonContext) {
  return defineMethod('session.tree', {
    scope: (p) => sessionScope(ctx, p.sessionId),
    handler: (p, call) => buildSessionTree(ctx, p.sessionId, call.actor),
  });
}
