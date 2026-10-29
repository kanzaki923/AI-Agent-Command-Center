import type { Attention } from '@acc/protocol';
import { stubMethod } from '../api/registry';
import type { AttentionResolutionInput, AttentionService, OpenAttentionInput } from '../contracts';
import { runOnce } from '../core/backfills';
import { ApiError } from '../core/errors';
import { defineModule } from '../module';
import { backfillAttention } from './backfill';

export { ATTENTION_KIND_PRIORITY, attentionPriority } from './priority';
export { backfillAttention } from './backfill';

/**
 * Placeholder of the attention service (T4, architecture.md §2.16) until the Attention track
 * lands: opens and resolves nothing.
 */
export class StubAttention implements AttentionService {
  open(_input: OpenAttentionInput): Attention | null {
    return null;
  }

  resolveWhere(_refs: Attention['refs'], _resolution: AttentionResolutionInput): Attention[] {
    return [];
  }

  respond(): Promise<Attention> {
    return Promise.reject(
      new ApiError('not_found', 'Method not implemented yet: attention.respond', {
        reason: 'not_implemented',
      }),
    );
  }
}

/**
 * Attention ("your turn") items and questions to humans (T4, spec 20261029 §1.6, §3.6).
 * Core ships the table, the startup backfill and stubs.
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
    ctx.provide('attention', new StubAttention());
    ctx.methods.register(
      stubMethod('human.ask'),
      stubMethod('attention.list'),
      stubMethod('attention.respond'),
      stubMethod('attention.dismiss'),
    );
    return {
      start() {
        // Once: items for what already waited on a human before attention existed.
        let created = 0;
        runOnce(ctx.db, 'backfill/attention/0001_initial', ctx.clock.iso(), () => {
          created = backfillAttention(ctx);
        });
        if (created > 0) ctx.log.info('attention backfilled', { items: created });
      },
    };
  },
});
