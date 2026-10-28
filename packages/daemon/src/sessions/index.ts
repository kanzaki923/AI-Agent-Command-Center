import type { ContentPart, Session } from '@acc/protocol';
import { defineMethod } from '../api/registry';
import { conflict, invalidParams } from '../core/errors';
import { defineModule } from '../module';
import { createChatExecutor, resolveChatModel } from './chat';
import { searchMessages, sessionsMigrations } from './search';
import { SessionService } from './service';

export { SessionService } from './service';
export { createChatExecutor, resolveChatModel, OFFLINE_FALLBACK_MODEL } from './chat';
export { searchMessages, makeSnippet } from './search';

/**
 * Sessions and messages: session.create/list/get/update/archive/messages/send/search.
 *
 * `session.send` appends the user message and starts a run through `runs` (kind `chat`
 * for chat sessions, `agent` for agent sessions). This module registers the `chat`
 * executor (sessions/chat.ts); the `agent` executor belongs to the runtime module.
 */
export const sessionsModule = defineModule({
  name: 'sessions',
  migrations: sessionsMigrations,
  register(ctx) {
    const { repos, bus, db } = ctx;
    const service = new SessionService(ctx);
    ctx.provide('sessions', service);

    const sessionScope = (sessionId: string) => {
      const s = repos.sessions.get(sessionId);
      return { projectIds: s?.projectId ? [s.projectId] : [] };
    };

    ctx.methods.register(
      defineMethod('session.create', {
        scope: (p) => ({ projectIds: p.projectId ? [p.projectId] : [] }),
        handler: (p, call) =>
          db.transaction(() => {
            const project = p.projectId ? repos.projects.require(p.projectId) : null;
            if (p.workspaceId) {
              const ws = repos.workspaces.require(p.workspaceId);
              if (project && ws.projectId !== project.id) {
                throw invalidParams('workspace belongs to a different project');
              }
            }
            if (p.taskId) repos.tasks.require(p.taskId);
            if (p.parentSessionId) repos.sessions.require(p.parentSessionId);
            const now = ctx.clock.iso();
            const session = repos.sessions.insert({
              id: ctx.ids.next('session'),
              projectId: project?.id ?? null,
              kind: p.kind,
              title: p.title?.trim() ?? '',
              model: p.model ?? project?.defaultModel ?? ctx.settings.get().defaultModel,
              runtime: p.runtime ?? null,
              systemPrompt: p.systemPrompt ?? null,
              workspaceId: p.workspaceId ?? null,
              taskId: p.taskId ?? null,
              parentSessionId: p.parentSessionId ?? null,
              activeRunId: null,
              pinned: false,
              createdBy: call.actor,
              createdAt: now,
              updatedAt: now,
              lastActivityAt: now,
              archivedAt: null,
            });
            bus.emit({ type: 'session.created', actor: call.actor, payload: { session } });
            return session;
          }),
      }),

      defineMethod('session.list', {
        scope: (p) => ({ projectIds: p.projectId ? [p.projectId] : [] }),
        handler: (p) =>
          repos.sessions.page({
            where: {
              project_id: p.projectId,
              kind: p.kind,
              ...(p.includeArchived ? {} : { archived_at: null }),
            },
            orderBy: 'last_activity_at',
            direction: 'desc',
            limit: p.limit,
            cursor: p.cursor,
          }),
      }),

      defineMethod('session.get', {
        scope: (p) => sessionScope(p.sessionId),
        handler: (p) => repos.sessions.require(p.sessionId),
      }),

      defineMethod('session.update', {
        scope: (p) => {
          const s = sessionScope(p.sessionId);
          // Moving a session into another project touches that project too.
          if (p.projectId) s.projectIds.push(p.projectId);
          return s;
        },
        handler: (p, call) =>
          db.transaction(() => {
            if (p.projectId) repos.projects.require(p.projectId);
            if (p.workspaceId) repos.workspaces.require(p.workspaceId);
            const changes: string[] = [];
            const session = repos.sessions.update(p.sessionId, (cur) => {
              const next: Session = { ...cur };
              const assign = <K extends keyof Session>(key: K, value: Session[K] | undefined) => {
                if (value === undefined || cur[key] === value) return;
                next[key] = value;
                changes.push(key);
              };
              assign('title', p.title?.trim());
              assign('model', p.model);
              assign('systemPrompt', p.systemPrompt);
              assign('pinned', p.pinned);
              assign('projectId', p.projectId);
              assign('workspaceId', p.workspaceId);
              if (changes.length > 0) next.updatedAt = ctx.clock.iso();
              return next;
            });
            if (changes.length > 0) {
              bus.emit({
                type: 'session.updated',
                actor: call.actor,
                payload: { session, changes },
              });
            }
            return session;
          }),
      }),

      defineMethod('session.archive', {
        scope: (p) => sessionScope(p.sessionId),
        handler: (p, call) =>
          db.transaction(() => {
            const cur = repos.sessions.require(p.sessionId);
            if (p.archived === (cur.archivedAt !== null)) return cur;
            const now = ctx.clock.iso();
            const session = repos.sessions.update(p.sessionId, (s) => ({
              ...s,
              archivedAt: p.archived ? now : null,
              updatedAt: now,
            }));
            bus.emit({
              type: 'session.archived',
              actor: call.actor,
              payload: { sessionId: session.id, archived: p.archived },
              refs: { projectId: session.projectId, sessionId: session.id },
            });
            return session;
          }),
      }),

      defineMethod('session.messages', {
        scope: (p) => sessionScope(p.sessionId),
        handler: (p) => {
          repos.sessions.require(p.sessionId);
          const rows = repos.messages.find({
            where: { session_id: p.sessionId },
            ...(p.before ? { sql: { clause: 'id < ?', params: [p.before] } } : {}),
            orderBy: 'id',
            direction: 'desc',
            limit: p.limit + 1,
          });
          const hasMore = rows.length > p.limit;
          return { items: rows.slice(0, p.limit).reverse(), hasMore };
        },
      }),

      defineMethod('session.send', {
        scope: (p) => sessionScope(p.sessionId),
        handler: (p, call) =>
          db.transaction(() => {
            const session = repos.sessions.require(p.sessionId);
            if (session.archivedAt) {
              throw conflict('アーカイブ済みのセッションには送信できません');
            }
            const content: ContentPart[] =
              typeof p.content === 'string' ? [{ type: 'text', text: p.content }] : p.content;
            if (content.some((c) => c.type === 'tool_result' || c.type === 'tool_call')) {
              throw invalidParams('User messages may only contain text parts');
            }
            const kind = session.kind === 'agent' ? 'agent' : 'chat';
            const message = service.appendMessage({
              sessionId: session.id,
              role: 'user',
              content,
              author: call.actor,
            });
            // Rolls back the message too if the session is busy (conflict).
            const run = ctx.service('runs').start({
              sessionId: session.id,
              kind,
              createdBy: call.actor,
              triggerMessageId: message.id,
              model:
                kind === 'chat'
                  ? resolveChatModel(ctx, session.model, p.model)
                  : (p.model ?? session.model),
              runtime: session.runtime,
              workspaceId: kind === 'agent' ? session.workspaceId : null,
            });
            return { messageId: message.id, runId: run.id };
          }),
      }),

      defineMethod('session.search', {
        scope: (p) => ({ projectIds: p.projectId ? [p.projectId] : [] }),
        handler: (p) => ({ items: searchMessages(ctx, p) }),
      }),
    );

    return {
      start() {
        // Executors are registered once every module provided its services.
        if (ctx.hasService('runs'))
          ctx.service('runs').registerExecutor('chat', createChatExecutor(ctx));
      },
    };
  },
});
