import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';
import { sessionScope } from './shared';

export function sessionGet(ctx: DaemonContext) {
  return defineMethod('session.get', {
    scope: (p) => sessionScope(ctx, p.sessionId),
    handler: (p) => ctx.repos.sessions.require(p.sessionId),
  });
}
