import type { InboxDeliverInput, InboxDeliverResult, InboxService } from '../contracts';
import { defineModule } from '../module';

/**
 * Placeholder of the inbox (T1, architecture.md §2.13) until the Supervisor track lands:
 * stores nothing and starts nothing. `session.send` still starts runs directly.
 */
export class StubInbox implements InboxService {
  deliver(_sessionId: string, _input: InboxDeliverInput): InboxDeliverResult {
    return { item: null, delivery: 'queued', runId: null };
  }

  drain(_runId: string) {
    return [];
  }
}

/** Inbox and wakes (T1): the only way a session is woken (spec 20261029 §3.2). */
export const inboxModule = defineModule({
  name: 'inbox',
  migrations: [
    {
      id: 'inbox/0001_init',
      sql: `
CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  consumed_by_run_id TEXT,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX inbox_items_session ON inbox_items(session_id, status);
`,
    },
  ],
  register(ctx) {
    ctx.provide('inbox', new StubInbox());
  },
});
