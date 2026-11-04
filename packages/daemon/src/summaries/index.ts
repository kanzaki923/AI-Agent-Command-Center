import { defineMethod } from '../api/registry';
import { defineModule } from '../module';
import { SessionSummaries } from './service';

export {
  MOCK_SUMMARY_MODEL,
  SUMMARY_FOLD_AT,
  SUMMARY_KEEP,
  SessionSummaries,
  mockSummary,
  summaryPrompt,
} from './service';

declare module '../core/context' {
  interface Services {
    /** Running summaries of long conversations. */
    summaries: SessionSummaries;
  }
}

/**
 * Conversation summaries (architecture.md §2.23): a running summary beside every long
 * conversation, for a member called in with @name and for search. Nothing in the
 * conversation reads it.
 */
export const summariesModule = defineModule({
  name: 'summaries',
  migrations: [
    {
      id: 'summaries/0001_init',
      sql: `
CREATE TABLE session_summaries (
  session_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  up_to_message_id TEXT NOT NULL,
  messages INTEGER NOT NULL,
  model TEXT,
  updated_at TEXT NOT NULL
);
`,
    },
  ],
  register(ctx) {
    const summaries = new SessionSummaries(ctx);
    ctx.provide('summaries', summaries);
    ctx.methods.register(
      defineMethod('session.summary', {
        scope: (p) => {
          const s = ctx.repos.sessions.get(p.sessionId);
          return { projectIds: s?.projectId ? [s.projectId] : [], sessionIds: [p.sessionId] };
        },
        handler: (p) => {
          ctx.repos.sessions.require(p.sessionId);
          return { summary: summaries.get(p.sessionId) };
        },
      }),
    );
    return { start: () => summaries.start(), stop: () => summaries.stop() };
  },
});
