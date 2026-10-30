import type { Message } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { subtreeIds } from '../home/tree';
import { WAKE_MARKER } from '../inbox/wake';
import { ASSISTANT_SYSTEM } from './permissions';
import type { AssistantService } from './service';

/** Notices per hour at most (a runaway tree cannot make the assistant talk nonstop). */
export const NOTICES_PER_HOUR = 20;
/** A root that settles and moves again within this time sends one notice, for the final state. */
export const NOTICE_DEBOUNCE_MS = 1500;
/** Outputs named in a notice at most. */
const NOTICE_OUTPUTS = 5;

const HOUR_MS = 3_600_000;

/** Root states the assistant speaks up about. */
export type Settled = 'done' | 'failed';

/**
 * The assistant speaks up on its own (right-hand spec §4 の 3): when a root tree ends
 * (`done`) or fails (`failed`), the daemon posts a notice into its conversation — a `system`
 * message with `meta.wake` like the ones that wake a supervisor — and starts its run, so it
 * tells the person in its own words what came out or what went wrong. Only roots (a
 * schedule firing is a child), never the assistant itself, debounced per root, at most
 * `NOTICES_PER_HOUR`.
 */
export class AssistantNotifier {
  debounceMs = NOTICE_DEBOUNCE_MS;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private sentAt: number[] = [];

  constructor(
    private readonly ctx: DaemonContext,
    private readonly assistant: AssistantService,
  ) {}

  /** Subscribe to state changes. Returns the unsubscribe. */
  start(): () => void {
    const unsubscribe = this.ctx.bus.subscribe({ types: ['session.state_changed'] }, (e) => {
      if (e.type !== 'session.state_changed') return;
      const p = e.payload;
      if (p.sessionId !== p.rootSessionId || p.parentSessionId) return;
      if ((p.to !== 'done' && p.to !== 'failed') || p.from === p.to) return;
      const id = this.assistant.currentId();
      if (!id || id === p.sessionId) return;
      this.schedule(p.sessionId, p.to);
    });
    return () => {
      unsubscribe();
      for (const t of this.timers.values()) clearTimeout(t);
      this.timers.clear();
    };
  }

  private schedule(rootId: string, to: Settled): void {
    const prev = this.timers.get(rootId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.timers.delete(rootId);
      try {
        this.notify(rootId, to);
      } catch (err) {
        this.ctx.log.warn('assistant notice failed', { rootId, err });
      }
    }, this.debounceMs);
    t.unref?.();
    this.timers.set(rootId, t);
  }

  /**
   * Post the notice for a root that is still in `to`, and start the assistant on it. Returns
   * the notice, or null when nothing was sent (the root moved on, the limit, no assistant).
   */
  notify(rootId: string, to: Settled): Message | null {
    const { ctx } = this;
    const id = this.assistant.currentId();
    const root = ctx.repos.sessions.get(rootId);
    if (!id || !root || root.archivedAt || root.state !== to) return null;
    const now = ctx.clock.now();
    this.sentAt = this.sentAt.filter((t) => now - t < HOUR_MS);
    if (this.sentAt.length >= NOTICES_PER_HOUR) return null;
    this.sentAt.push(now);

    const ids = subtreeIds(ctx, rootId);
    const artifacts = ctx.repos.artifacts
      .find({ where: { session_id: ids }, direction: 'desc', limit: 40 })
      .filter((a) => a.role === 'output')
      .slice(0, NOTICE_OUTPUTS);
    const outputs = [...new Set(artifacts.map((a) => a.title))];
    const title = root.title || '無題';
    const what =
      to === 'done'
        ? `「${title}」が終わりました。${outputs.length > 0 ? `できたもの: ${outputs.join('、')}` : 'できたものはありません。'}`
        : `「${title}」が失敗しました。`;
    return ctx.db.transaction(() => {
      const message = ctx.service('sessions').appendMessage({
        sessionId: id,
        role: 'system',
        content: [{ type: 'text', text: `${WAKE_MARKER}\n${what}` }],
        author: ASSISTANT_SYSTEM,
        meta: {
          kind: 'wake',
          items: [
            { sessionId: rootId, title, change: to, artifactIds: artifacts.map((a) => a.id) },
          ],
        },
      });
      ctx.service('inbox').deliver(id, {
        kind: 'user_message',
        refs: { messageId: message.id },
        actor: ASSISTANT_SYSTEM,
      });
      return message;
    });
  }
}
