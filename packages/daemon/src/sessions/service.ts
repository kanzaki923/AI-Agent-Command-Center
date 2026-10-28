import type { Actor, ContentPart, Message, MessageRole, Session, SessionKind } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { invalidParams } from '../core/errors';

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

  /**
   * Create a session (validates references, emits session.created). Used by
   * `session.create` and by daemon-internal callers such as task.spawnWorker, which must not
   * need the caller to hold `session.create` itself.
   */
  create(input: CreateSessionInput, actor: Actor): Session {
    const { ctx } = this;
    const { repos } = ctx;
    return ctx.db.transaction(() => {
      const project = input.projectId ? repos.projects.require(input.projectId) : null;
      if (input.workspaceId) {
        const ws = repos.workspaces.require(input.workspaceId);
        if (project && ws.projectId !== project.id) {
          throw invalidParams('workspace belongs to a different project');
        }
      }
      if (input.taskId) repos.tasks.require(input.taskId);
      if (input.parentSessionId) repos.sessions.require(input.parentSessionId);
      const now = ctx.clock.iso();
      const session = repos.sessions.insert({
        id: ctx.ids.next('session'),
        projectId: project?.id ?? null,
        kind: input.kind,
        title: input.title?.trim() ?? '',
        model: input.model ?? project?.defaultModel ?? ctx.settings.get().defaultModel,
        runtime: input.runtime ?? null,
        systemPrompt: input.systemPrompt ?? null,
        workspaceId: input.workspaceId ?? null,
        taskId: input.taskId ?? null,
        parentSessionId: input.parentSessionId ?? null,
        activeRunId: null,
        pinned: false,
        createdBy: actor,
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        archivedAt: null,
      });
      ctx.bus.emit({ type: 'session.created', actor, payload: { session } });
      return session;
    });
  }
}

export interface CreateSessionInput {
  kind: SessionKind;
  projectId?: string | null | undefined;
  title?: string | undefined;
  model?: string | null | undefined;
  runtime?: string | null | undefined;
  systemPrompt?: string | null | undefined;
  workspaceId?: string | null | undefined;
  taskId?: string | null | undefined;
  parentSessionId?: string | null | undefined;
}

declare module '../core/context' {
  interface Services {
    sessions: SessionService;
  }
}
