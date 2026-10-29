import type { SystemActor } from '@acc/protocol';
import { runOnce } from '../core/backfills';
import type { DaemonContext } from '../core/context';
import { defineModule } from '../module';
import { backfillAttention } from './backfill';
import { attentionMethods } from './methods';
import { AttentionManager } from './service';
import { syncAttention } from './sync';

export { ATTENTION_KIND_PRIORITY, attentionPriority } from './priority';
export { backfillAttention } from './backfill';
export { AttentionManager } from './service';
export { answerText } from './answer';
export { approvalAttentionTitle } from './approvals';

/**
 * Approval items whose approval is no longer pending (cancelled while the daemon was down,
 * or by a module's own startup reconciliation before it subscribed): resolve them.
 */
function resolveStaleApprovals(ctx: DaemonContext, manager: AttentionManager): number {
  const actor: SystemActor = { kind: 'system', component: 'attention' };
  let resolved = 0;
  for (const att of ctx.repos.attention.find({ where: { status: 'open', kind: 'approval' } })) {
    const ap = att.refs.approvalId ? ctx.repos.approvals.get(att.refs.approvalId) : undefined;
    if (ap?.status === 'pending') continue;
    manager.close(att.id, 'resolved', { by: actor });
    resolved += 1;
  }
  return resolved;
}

/**
 * Attention ("your turn") items and questions to humans (T4, spec 20261029 §1.6, §3.6,
 * architecture.md §2.16). Provides `ctx.service('attention')` and the methods human.ask /
 * attention.list / attention.respond / attention.dismiss; keeps items in step with
 * approvals, runs, tasks, outputs, integrations and budgets (sync.ts).
 */
export const attentionModule = defineModule({
  name: 'attention',
  migrations: [
    {
      id: 'attention/0001_init',
      sql: `
CREATE TABLE attention (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  session_id TEXT NOT NULL,
  root_session_id TEXT NOT NULL,
  priority REAL NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX attention_status_root ON attention(status, root_session_id);
CREATE INDEX attention_session ON attention(session_id, status);
`,
    },
  ],
  register(ctx) {
    const manager = new AttentionManager(ctx);
    ctx.provide('attention', manager);
    ctx.methods.register(...attentionMethods(ctx, manager));
    const off = syncAttention(ctx, manager);
    return {
      start() {
        // Once: items for what already waited on a human before attention existed.
        let created = 0;
        runOnce(ctx.db, 'backfill/attention/0001_initial', ctx.clock.iso(), () => {
          created = backfillAttention(ctx);
        });
        if (created > 0) ctx.log.info('attention backfilled', { items: created });
        const stale = ctx.db.transaction(() => resolveStaleApprovals(ctx, manager));
        if (stale > 0) ctx.log.info('stale approval items resolved', { items: stale });
      },
      stop() {
        off();
      },
    };
  },
});
