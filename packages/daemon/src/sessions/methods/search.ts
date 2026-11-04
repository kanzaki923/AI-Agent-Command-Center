import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';
import { searchMessages } from '../search';

export function sessionSearch(ctx: DaemonContext) {
  return defineMethod('session.search', {
    scope: (p) => ({ projectIds: p.projectId ? [p.projectId] : [] }),
    handler: (p) => {
      // Summaries first (one per conversation: it is about that), then the messages.
      const terms = p.query.trim().split(/\s+/).filter(Boolean);
      const summaries = ctx.hasService('summaries')
        ? ctx.service('summaries').search({ terms, projectId: p.projectId, limit: p.limit })
        : [];
      return { items: [...summaries, ...searchMessages(ctx, p)].slice(0, p.limit) };
    },
  });
}
