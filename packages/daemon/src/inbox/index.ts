import { type Event, isTerminalRunStatus } from '@acc/protocol';
import { defineModule } from '../module';
import { Inbox } from './service';

export {
  Inbox,
  INBOX_SYSTEM,
  TRANSIENT_RETRY_DELAYS_MS,
  isMessageItem,
  isTransientRunError,
  type InboxOptions,
} from './service';
export { CHILD_UPDATE_STATES, INJECTED_PREFIX, WAKE_MARKER, currentState } from './wake';
export { isLegacyOrchestrator, isSupervisor, runKindFor, setSupervision } from './supervision';

/** Session whose (child) state an event may have moved, for the parent's child_update. */
function sessionTouchedBy(e: Event): string | null {
  switch (e.type) {
    case 'task.updated':
      return e.payload.task.assigneeSessionId;
    case 'attention.opened':
    case 'attention.resolved':
      return e.payload.attention.sessionId;
    case 'session.state_changed':
      return e.payload.sessionId;
    default:
      return null;
  }
}

/**
 * Inbox and wakes (T1, spec 20261029 §1.7, §3.2; architecture.md §2.13): the only way a
 * session is woken. Service `inbox` (contracts.ts InboxService, plus the Inbox class's own
 * helpers for session.stop / resume and the executors' step-boundary injection).
 *
 * Follows run ends (next queued message, wakes, runaway / transient-error handling) and every
 * change that can move a child's state (its runs, its task, its attention items, state
 * events) to report it to a supervising parent.
 */
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
    const inbox = new Inbox(ctx);
    ctx.provide('inbox', inbox);
    ctx.provide('supervisorInbox', inbox);

    const offRuns = ctx.bus.subscribe({ types: ['run.status_changed'] }, (e) => {
      if (e.type !== 'run.status_changed' || !isTerminalRunStatus(e.payload.to)) return;
      const run = ctx.repos.runs.get(e.payload.runId);
      if (run) inbox.onRunEnded(run);
    });
    const offChildren = ctx.bus.subscribe(
      {
        types: ['task.updated', 'attention.opened', 'attention.resolved', 'session.state_changed'],
      },
      (e) => {
        const sessionId = sessionTouchedBy(e);
        if (sessionId) inbox.evaluateChild(sessionId);
      },
    );
    ctx.onClose(() => {
      offRuns();
      offChildren();
      inbox.stop();
    });

    return {
      stop() {
        inbox.stop();
      },
    };
  },
});

declare module '../core/context' {
  interface Services {
    /** The concrete inbox (session.stop / resume and the executors use its helpers too). */
    supervisorInbox: Inbox;
  }
}
