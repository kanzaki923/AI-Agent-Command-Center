import type {
  Actor,
  ContentPart,
  Message,
  MessageDelivery,
  MessageMeta,
  MessageRole,
  Session,
  SessionBrief,
  SessionKind,
} from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { conflict, invalidParams } from '../core/errors';
import { agentDefaultModel, assertAgentModel, assertRosterModel } from '../llm/roster';
import { defaultRuntimeOf } from '../runtime/registry';

export interface AppendMessageInput {
  sessionId: string;
  role: MessageRole;
  content: ContentPart[];
  author: Actor;
  runId?: string | null;
  model?: string | null;
  /** Use a pre-generated id (e.g. the id deltas were streamed under). */
  id?: string;
  /** Default 'delivered'; a user message sent while the session is busy is 'queued'. */
  delivery?: MessageDelivery;
  meta?: MessageMeta | null;
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
        delivery: input.delivery ?? 'delivered',
        meta: input.meta ?? null,
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
    if (input.model) {
      const runtime = input.runtime ?? defaultRuntimeOf(ctx, input.model);
      assertRosterModel(ctx, actor, input.model);
      if (input.kind === 'agent') assertAgentModel(ctx, input.model, runtime);
    }
    const { repos } = ctx;
    return ctx.db.transaction(() => {
      const project = input.projectId ? repos.projects.require(input.projectId) : null;
      if (project?.archivedAt) throw conflict('外したプロジェクトでは会話を始められません');
      // The session's runs write to the workspace (or the task's): both must be in its project,
      // or a project-limited caller could reach another project's worktree through them.
      if (input.workspaceId) {
        const ws = repos.workspaces.require(input.workspaceId);
        if (project && ws.projectId !== project.id) {
          throw invalidParams('workspace belongs to a different project');
        }
      }
      if (input.taskId) {
        const task = repos.tasks.require(input.taskId);
        if (project && task.projectId !== project.id) {
          throw invalidParams('task belongs to a different project');
        }
      }
      const parent = input.parentSessionId ? repos.sessions.require(input.parentSessionId) : null;
      // A member on the roster: the conversation starts on its model unless one is named.
      const member = input.characterId
        ? ctx.service('characters').requireActive(input.characterId)
        : null;
      // The chat default is not the agent's: Claude Code cannot run a GPT model, so an agent
      // session takes it only when its runtime can (else Claude Code's own default answers).
      const inherited = () => {
        const fallback = member?.model ?? project?.defaultModel ?? ctx.settings.get().defaultModel;
        if (input.kind !== 'agent') return fallback;
        return agentDefaultModel(ctx, fallback, input.runtime ?? defaultRuntimeOf(ctx, fallback));
      };
      const now = ctx.clock.iso();
      const id = ctx.ids.next('session');
      const session = repos.sessions.insert({
        id,
        rootSessionId: parent?.rootSessionId ?? id,
        projectId: project?.id ?? null,
        kind: input.kind,
        title: input.title?.trim() ?? '',
        model: input.model ?? inherited(),
        runtime: input.runtime ?? null,
        systemPrompt: input.systemPrompt ?? null,
        workspaceId: input.workspaceId ?? null,
        taskId: input.taskId ?? null,
        parentSessionId: parent?.id ?? null,
        brief: input.brief ?? null,
        persona: input.persona?.trim() || null,
        characterId: member?.id ?? null,
        speaks: !!input.speaks,
        scheduleId: input.scheduleId ?? null,
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
  /** The request a child was given (session.spawn, schedule firings). */
  brief?: SessionBrief | null | undefined;
  /** The character a speaker plays (session.spawn `persona`). */
  persona?: string | null | undefined;
  /** The member this conversation is with (`character.*`). */
  characterId?: string | null | undefined;
  /** The member talks as a speaker (session.spawn `speaker`). */
  speaks?: boolean | undefined;
  /** Schedule whose firing created the session. */
  scheduleId?: string | null | undefined;
}

declare module '../core/context' {
  interface Services {
    sessions: SessionService;
  }
}
