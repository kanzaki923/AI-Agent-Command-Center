import type { Session } from '@acc/protocol';
import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';
import { invalidParams } from '../../core/errors';
import { sessionScope } from './shared';

export function sessionUpdate(ctx: DaemonContext) {
  const { repos, db, bus } = ctx;
  return defineMethod('session.update', {
    scope: (p) => {
      const s = sessionScope(ctx, p.sessionId);
      // Moving a session into another project touches that project too.
      if (p.projectId) s.projectIds.push(p.projectId);
      return s;
    },
    handler: (p, call) =>
      db.transaction(() => {
        if (p.projectId) repos.projects.require(p.projectId);
        if (p.workspaceId) repos.workspaces.require(p.workspaceId);
        if (p.workspaceId || p.projectId) {
          // Runs of the session write to its workspace (or its task's): they must stay in
          // the session's project, or a project-limited agent reaches another project.
          const cur = repos.sessions.require(p.sessionId);
          const projectId = p.projectId ?? cur.projectId;
          const wsId = p.workspaceId ?? cur.workspaceId;
          if (projectId && wsId && repos.workspaces.get(wsId)?.projectId !== projectId) {
            throw invalidParams('workspace belongs to a different project');
          }
          if (projectId && cur.taskId && repos.tasks.get(cur.taskId)?.projectId !== projectId) {
            throw invalidParams('task belongs to a different project');
          }
        }
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
  });
}
