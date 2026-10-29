import type { Session } from '@acc/protocol';
import { stubMethod } from '../api/registry';
import type { SessionStateService } from '../contracts';
import { runOnce } from '../core/backfills';
import type { DaemonContext } from '../core/context';
import { defineModule } from '../module';
import { backfillSessionStates } from './state';
import { StubStreams } from './streams';
import { isWorkSettled } from './tree';

export {
  deriveSessionState,
  readStateFacts,
  backfillSessionStates,
  type StateFacts,
} from './state';
export { isWorkSettled, subtreeIds } from './tree';
export { StubStreams } from './streams';

/**
 * Placeholder of the session state service (T7, architecture.md §2.19): states are derived
 * once at startup (backfill) and not kept current yet. `isWorkSettled` is real: grants with
 * lifetime `work` depend on it.
 */
export class StubSessionState implements SessionStateService {
  constructor(private readonly ctx: DaemonContext) {}

  recompute(sessionId: string): Session | null {
    return this.ctx.repos.sessions.get(sessionId) ?? null;
  }

  isWorkSettled(sessionId: string): boolean {
    return isWorkSettled(this.ctx, sessionId);
  }
}

/** Session states, "what is it doing now" and the home screen (T7, spec 20261029 §3.7). */
export const homeModule = defineModule({
  name: 'home',
  register(ctx) {
    ctx.provide('sessionState', new StubSessionState(ctx));
    ctx.provide('streams', new StubStreams());
    ctx.methods.register(stubMethod('home.get'));
    return {
      start() {
        // After the attention backfill (module order): open items decide needs_you / failed.
        let changed = 0;
        runOnce(ctx.db, 'backfill/home/0001_session_state', ctx.clock.iso(), () => {
          changed = backfillSessionStates(ctx);
        });
        if (changed > 0) ctx.log.info('session states backfilled', { sessions: changed });
      },
    };
  },
});
