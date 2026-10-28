import type { Actor, ContentPart, Message, MessageRole, Session } from '@acc/protocol';
import type { DaemonContext } from '../core/context';

export interface AppendMessageInput {
  sessionId: string;
  role: MessageRole;
  content: ContentPart[];
  author: Actor;
  runId?: string | null;
  model?: string | null;
  /** Use a pre-generated id (e.g. the id deltas were streamed under). */
  id?: string;
}

/**
 * Session operations shared with other modules (runs, llm, runtime, orchestrator).
 * Available as `ctx.service('sessions')`.
 */
export class SessionService {
  constructor(private readonly ctx: DaemonContext) {}

  /** Persist a message, bump session activity, emit `message.created`. */
  appendMessage(input: AppendMessageInput): Message {
    const { ctx } = this;
    return ctx.db.transaction(() => {
      ctx.repos.sessions.require(input.sessionId);
      const now = ctx.clock.iso();
      const message = ctx.repos.messages.insert({
        id: input.id ?? ctx.ids.next('message'),
        sessionId: input.sessionId,
        runId: input.runId ?? null,
        role: input.role,
        content: input.content,
        author: input.author,
        model: input.model ?? null,
        createdAt: now,
      });
      this.touch(input.sessionId);
      ctx.bus.emit({ type: 'message.created', actor: input.author, payload: { message } });
      return message;
    });
  }

  /** Update lastActivityAt without emitting session.updated (activity is implied by other events). */
  touch(sessionId: string): Session {
    const now = this.ctx.clock.iso();
    return this.ctx.repos.sessions.update(sessionId, (s) => ({ ...s, lastActivityAt: now }));
  }

  /**
   * Set or clear the session's active run. Emits session.updated so lists can show the
   * running indicator without subscribing to run events.
   */
  setActiveRun(sessionId: string, runId: string | null, actor: Actor): Session {
    const { ctx } = this;
    return ctx.db.transaction(() => {
      const now = ctx.clock.iso();
      const session = ctx.repos.sessions.update(sessionId, (s) => ({
        ...s,
        activeRunId: runId,
        lastActivityAt: now,
        updatedAt: now,
      }));
      ctx.bus.emit({
        type: 'session.updated',
        actor,
        payload: { session, changes: ['activeRunId'] },
      });
      return session;
    });
  }
}

declare module '../core/context' {
  interface Services {
    sessions: SessionService;
  }
}
