import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';
import { conflict } from '../../core/errors';
import { sessionScope } from './shared';

export function sessionArchive(ctx: DaemonContext) {
  const { repos, db, bus } = ctx;
  return defineMethod('session.archive', {
    scope: (p) => sessionScope(ctx, p.sessionId),
    handler: (p, call) =>
      db.transaction(() => {
        const cur = repos.sessions.require(p.sessionId);
        if (p.archived === (cur.archivedAt !== null)) return cur;
        if (p.archived && ctx.hasService('assistant') && ctx.service('assistant').isAssistant(cur.id)) {
          throw conflict('右腕はアーカイブできません');
        }
        const now = ctx.clock.iso();
        const session = repos.sessions.update(p.sessionId, (s) => ({
          ...s,
          archivedAt: p.archived ? now : null,
          updatedAt: now,
        }));
        bus.emit({
          type: 'session.archived',
          actor: call.actor,
          payload: { sessionId: session.id, archived: p.archived },
          refs: { projectId: session.projectId, sessionId: session.id },
        });
        return session;
      }),
  });
}
