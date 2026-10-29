import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';
import { searchMessages } from '../search';

export function sessionSearch(ctx: DaemonContext) {
  return defineMethod('session.search', {
    scope: (p) => ({ projectIds: p.projectId ? [p.projectId] : [] }),
    handler: (p) => ({ items: searchMessages(ctx, p) }),
  });
}
