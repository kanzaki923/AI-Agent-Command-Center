import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';
import { spawnProjectId } from '../spawn';

/**
 * session.spawn: start a child below a session (the caller's own by default for agents) and
 * return at once (spec 20261029 §3.3). The `spawner` service (sessions/spawn.ts) does the
 * work; schedules call it too. Scope: the parent (agents only within their own tree) and the
 * child's project (project-limited grants).
 */
export function sessionSpawn(ctx: DaemonContext) {
  return defineMethod('session.spawn', {
    scope: (p, call) => {
      const parent =
        p.parentSessionId ?? (call.actor.kind === 'agent' ? call.actor.sessionId : null);
      const projectId = spawnProjectId(ctx, p, parent);
      return {
        projectIds: projectId ? [projectId] : [],
        ...(parent ? { sessionIds: [parent] } : {}),
      };
    },
    handler: (p, call) => ctx.service('spawner').spawn(p, call.actor),
  });
}
