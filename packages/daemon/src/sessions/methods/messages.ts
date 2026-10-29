import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';
import { sessionScope } from './shared';

/** session.messages: latest page, oldest first, plus the text being streamed (T7: streams). */
export function sessionMessages(ctx: DaemonContext) {
  const { repos } = ctx;
  return defineMethod('session.messages', {
    scope: (p) => sessionScope(ctx, p.sessionId),
    handler: (p) => {
      repos.sessions.require(p.sessionId);
      const rows = repos.messages.find({
        where: { session_id: p.sessionId },
        ...(p.before ? { sql: { clause: 'id < ?', params: [p.before] } } : {}),
        orderBy: 'id',
        direction: 'desc',
        limit: p.limit + 1,
      });
      const hasMore = rows.length > p.limit;
      const streaming =
        !p.before && ctx.hasService('streams')
          ? ctx.service('streams').snapshot(p.sessionId)
          : null;
      return { items: rows.slice(0, p.limit).reverse(), hasMore, streaming };
    },
  });
}
