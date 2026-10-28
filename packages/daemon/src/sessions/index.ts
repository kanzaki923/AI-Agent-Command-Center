import type { Session } from '@acc/protocol';
import { defineMethod } from '../api/registry';
import { invalidParams } from '../core/errors';
import { defineModule } from '../module';
import { SessionService } from './service';

export { SessionService } from './service';

/**
 * Sessions and messages.
 *
 * Implemented: session.create/list/get/update/archive/messages.
 * TODO(sessions): session.send (user message -> chat run via `runs` + `llm`; agent sessions
 *   go through `runtime`), session.search (add an FTS5 `messages_fts` table with the
 *   `trigram` tokenizer via a `sessions/0001_fts` migration so Japanese substrings match).
 */
export const sessionsModule = defineModule({
  name: 'sessions',
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
    );
  },
});
