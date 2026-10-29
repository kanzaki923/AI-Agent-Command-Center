import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';
import { subtreeIds } from '../../home/tree';

/**
 * session.list: most recently active first; `rootsOnly` / `parentSessionId` walk the tree.
 * An agent lists only its own session and its descendants (spec 20261029 §1.8).
 */
export function sessionList(ctx: DaemonContext) {
  return defineMethod('session.list', {
    scope: (p) => ({
      projectIds: p.projectId ? [p.projectId] : [],
      ...(p.parentSessionId ? { sessionIds: [p.parentSessionId] } : {}),
    }),
    handler: (p, call) => {
      const own = call.actor.kind === 'agent' ? subtreeIds(ctx, call.actor.sessionId) : null;
      return ctx.repos.sessions.page({
        where: {
          project_id: p.projectId,
          kind: p.kind,
          ...(p.rootsOnly ? { parent_session_id: null } : {}),
          ...(p.parentSessionId !== undefined ? { parent_session_id: p.parentSessionId } : {}),
          ...(p.includeArchived ? {} : { archived_at: null }),
          ...(own ? { id: own } : {}),
        },
        orderBy: 'last_activity_at',
        direction: 'desc',
        limit: p.limit,
        cursor: p.cursor,
      });
    },
  });
}
