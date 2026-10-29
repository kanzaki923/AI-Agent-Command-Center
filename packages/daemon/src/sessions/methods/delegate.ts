import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';
import { delegateSession, undelegateSession } from '../../orchestrator/grant';

/**
 * session.delegate / session.undelegate (humans only, spec 20261029 §2.2): let a session
 * lead children with the supervisor preset (orchestrator/grant.ts), or take that back.
 */
export function sessionDelegate(ctx: DaemonContext) {
  return defineMethod('session.delegate', {
    scope: (p) => {
      const s = ctx.repos.sessions.get(p.sessionId);
      const projectId = p.projectId === undefined ? s?.projectId : p.projectId;
      return { projectIds: projectId ? [projectId] : [], sessionIds: [p.sessionId] };
    },
    handler: (p, call) => delegateSession(ctx, p, call.actor),
  });
}

export function sessionUndelegate(ctx: DaemonContext) {
  return defineMethod('session.undelegate', {
    scope: (p) => {
      const s = ctx.repos.sessions.get(p.sessionId);
      return { projectIds: s?.projectId ? [s.projectId] : [], sessionIds: [p.sessionId] };
    },
    handler: (p, call) => undelegateSession(ctx, p.sessionId, call.actor),
  });
}
