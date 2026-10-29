import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';

/** session.list: most recently active first; `rootsOnly` / `parentSessionId` walk the tree (T7). */
export function sessionList(ctx: DaemonContext) {
  return defineMethod('session.list', {
    scope: (p) => ({
      projectIds: p.projectId ? [p.projectId] : [],
      ...(p.parentSessionId ? { sessionIds: [p.parentSessionId] } : {}),
    }),
    handler: (p) =>
      ctx.repos.sessions.page({
        where: {
          project_id: p.projectId,
          kind: p.kind,
          ...(p.rootsOnly ? { parent_session_id: null } : {}),
          ...(p.parentSessionId !== undefined ? { parent_session_id: p.parentSessionId } : {}),
          ...(p.includeArchived ? {} : { archived_at: null }),
        },
        orderBy: 'last_activity_at',
        direction: 'desc',
        limit: p.limit,
        cursor: p.cursor,
      }),
  });
}
