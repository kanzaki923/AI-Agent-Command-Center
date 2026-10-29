import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';

/** session.create (T2 adds `workspace`: scratch / folder / worktree). */
export function sessionCreate(ctx: DaemonContext) {
  return defineMethod('session.create', {
    scope: (p) => ({
      projectIds: p.projectId ? [p.projectId] : [],
      ...(p.parentSessionId ? { sessionIds: [p.parentSessionId] } : {}),
    }),
    handler: (p, call) => ctx.service('sessions').create(p, call.actor),
  });
}
