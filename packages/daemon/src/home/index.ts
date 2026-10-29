import { isTerminalRunStatus } from '@acc/protocol';
import { defineMethod } from '../api/registry';
import { runOnce } from '../core/backfills';
import type { DaemonContext } from '../core/context';
import { defineModule } from '../module';
import { buildHomeSnapshot } from './home';
import { NOW_THINKING, NOW_WRITING, controlMethodOf, nowForActivity, nowForTool } from './now';
import { SessionStateTracker, backfillSessionStates } from './state';
import { LiveStreams } from './streams';

export {
  deriveSessionState,
  readStateFacts,
  backfillSessionStates,
  SessionStateTracker,
  type StateFacts,
} from './state';
export { isWorkSettled, subtreeIds } from './tree';
export { LiveStreams } from './streams';
export { buildHomeSnapshot, buildSessionTree, countKey } from './home';
export { readCardFacts, toCard, depthFirst, startedBy } from './cards';
export {
  NOW_MAX_CHARS,
  NOW_PREPARING,
  NOW_THINKING,
  NOW_WRITING,
  clip,
  nowForActivity,
  nowForTool,
} from './now';

/**
 * Keep session states and "what is it doing now" current from the events that change their
 * inputs (spec 20261029 §3.7): runs, tasks, attention, approvals, the inbox and the tree.
 */
function subscribe(ctx: DaemonContext, state: SessionStateTracker, streams: LiveStreams) {
  const recompute = (sessionId: string | null | undefined) => {
    if (sessionId) state.recompute(sessionId);
  };
  return ctx.bus.subscribe(undefined, (e) => {
    switch (e.type) {
      case 'run.status_changed':
        if (e.sessionId && isTerminalRunStatus(e.payload.to)) {
          streams.runEnded(e.payload.runId);
          state.runEnded(e.sessionId, e.payload.runId);
        }
        recompute(e.sessionId);
        return;
      case 'run.updated':
        if (e.payload.changes.includes('activity') && e.payload.run.activity) {
          state.noteActivity(e.payload.run.sessionId, nowForActivity(e.payload.run.activity));
        }
        return;
      case 'tool.called': {
        if (!e.sessionId) return;
        const spawned =
          controlMethodOf(e.payload.name) === 'session.spawn'
            ? state.countSpawn(e.payload.runId)
            : undefined;
        state.noteActivity(
          e.sessionId,
          nowForTool(e.payload.name, e.payload.input, spawned ? { spawned } : {}),
        );
        return;
      }
      case 'message.created': {
        const m = e.payload.message;
        if (m.role === 'assistant' && m.runId) streams.messagePersisted(m.runId);
        return;
      }
      case 'task.created':
      case 'task.updated':
        recompute(e.payload.task.assigneeSessionId);
        return;
      case 'attention.opened':
      case 'attention.resolved':
        recompute(e.payload.attention.sessionId);
        return;
      case 'approval.requested':
      case 'approval.resolved':
        recompute(e.payload.approval.sessionId);
        return;
      case 'inbox.added':
        recompute(e.payload.item.sessionId);
        return;
      case 'session.created':
        recompute(e.payload.session.id);
        return;
      case 'session.updated':
        if (e.payload.changes.some((c) => c === 'supervision' || c === 'parentSessionId')) {
          recompute(e.payload.session.id);
        }
        return;
      default:
        return;
    }
  });
}

/** Session states, "what is it doing now" and the home screen (T7, spec 20261029 §3.7). */
export const homeModule = defineModule({
  name: 'home',
  register(ctx) {
    const state = new SessionStateTracker(ctx);
    const streams = new LiveStreams(ctx, (sessionId, kind) =>
      state.noteActivity(sessionId, kind === 'text' ? NOW_WRITING : NOW_THINKING),
    );
    ctx.provide('sessionState', state);
    ctx.provide('streams', streams);
    ctx.methods.register(defineMethod('home.get', { handler: (p) => buildHomeSnapshot(ctx, p) }));
    const unsubscribe = subscribe(ctx, state, streams);
    return {
      start() {
        // After the attention backfill (module order): open items decide needs_you / failed.
        let backfilled = 0;
        runOnce(ctx.db, 'backfill/home/0001_session_state', ctx.clock.iso(), () => {
          backfilled = backfillSessionStates(ctx);
        });
        if (backfilled > 0) ctx.log.info('session states backfilled', { sessions: backfilled });
        const reconciled = state.start();
        if (reconciled > 0) ctx.log.info('session states reconciled', { sessions: reconciled });
      },
      stop() {
        unsubscribe();
        state.stop();
      },
    };
  },
});
