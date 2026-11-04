import type { Actor, Schedule } from '@acc/protocol';
import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';
import { conflict } from '../../core/errors';
import { subtreeIds } from '../../home/tree';
import { sessionScope } from './shared';
import { hasWorkToStop, stopSessions } from './stop';

/**
 * session.archive: put a conversation away (or bring it back). Archiving hides the whole tree
 * from the sidebar and home, so nothing in it may go on working out of sight: what still runs
 * or supervises below it is stopped (as session.stop with `tree: true`), and the tree's
 * repeats are turned off (they would start work nobody can see). Bringing it back does not
 * restart either: the tree shows as stopped, and resume / the repeat's switch are one press.
 */
export function sessionArchive(ctx: DaemonContext) {
  const { repos, db, bus } = ctx;
  return defineMethod('session.archive', {
    scope: (p) => sessionScope(ctx, p.sessionId),
    handler: (p, call) => {
      const disabled: Schedule[] = [];
      const session = db.transaction(() => {
        const cur = repos.sessions.require(p.sessionId);
        if (p.archived === (cur.archivedAt !== null)) return cur;
        if (p.archived && ctx.hasService('assistant') && ctx.service('assistant').isAssistant(cur.id)) {
          throw conflict('右腕はアーカイブできません');
        }
        if (p.archived) {
          const ids = subtreeIds(ctx, cur.id);
          if (ids.some((id) => hasWorkToStop(ctx, id))) stopSessions(ctx, cur.id, { tree: true }, call.actor);
          disabled.push(...disableSchedules(ctx, ids, call.actor));
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
      });
      if (disabled.length > 0 && ctx.hasService('scheduler')) ctx.service('scheduler').rearm();
      return session;
    },
  });
}

/** Turn off the enabled repeats owned by these sessions; returns the ones turned off. */
function disableSchedules(ctx: DaemonContext, sessionIds: readonly string[], actor: Actor): Schedule[] {
  const out: Schedule[] = [];
  for (const s of ctx.repos.schedules.find({ where: { session_id: [...sessionIds], enabled: true } })) {
    const next = ctx.repos.schedules.update(s.id, (cur) => ({
      ...cur,
      enabled: false,
      nextRunAt: null,
      updatedAt: ctx.clock.iso(),
    }));
    if (ctx.hasService('scheduler')) ctx.service('scheduler').emitUpdated(next, ['enabled', 'nextRunAt'], actor);
    out.push(next);
  }
  return out;
}
