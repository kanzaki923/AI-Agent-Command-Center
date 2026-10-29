import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';
import { invalidParams } from '../../core/errors';
import { SPAWNER_SYSTEM, attachWorkspace, prepareWorkspace } from '../spawn';

/**
 * session.create. `workspace` (spec 20261029 §2.2) gives an agent session its place to work:
 * `none` (a scratch folder), `folder` (a folder of the user's) or `worktree` (a git worktree of
 * a code project). Without it the session is created as before (`workspaceId`, or none).
 */
export function sessionCreate(ctx: DaemonContext) {
  return defineMethod('session.create', {
    scope: (p) => {
      const projectIds = new Set<string>();
      if (p.projectId) projectIds.add(p.projectId);
      if (p.workspace?.kind === 'worktree') projectIds.add(p.workspace.projectId);
      return {
        projectIds: [...projectIds],
        ...(p.parentSessionId ? { sessionIds: [p.parentSessionId] } : {}),
      };
    },
    handler: async (p, call) => {
      const { workspace, ...input } = p;
      const sessions = ctx.service('sessions');
      if (!workspace) return sessions.create(input, call.actor);
      if (p.workspaceId) {
        throw invalidParams('workspace と workspaceId は同時に指定できません');
      }
      if (workspace.kind === 'worktree' && p.projectId && workspace.projectId !== p.projectId) {
        throw invalidParams('projectId と作業場所（worktree）のプロジェクトが違います');
      }
      const projectId =
        p.projectId ?? (workspace.kind === 'worktree' ? workspace.projectId : undefined);
      const prepared = await prepareWorkspace(ctx, {
        mode: p.kind,
        spec: workspace,
        projectId: projectId ?? null,
        label: p.title?.trim() || 'session',
        actor: call.actor,
      });
      try {
        return ctx.db.transaction(() => {
          const session = sessions.create(
            {
              ...input,
              projectId,
              workspaceId: prepared.kind === 'ready' ? prepared.workspace.id : undefined,
            },
            call.actor,
          );
          return attachWorkspace(ctx, session, prepared, call.actor);
        });
      } catch (err) {
        if (prepared.kind === 'ready' && prepared.created) {
          await ctx
            .service('workspaceManager')
            .remove(prepared.workspace.id, { force: true, actor: SPAWNER_SYSTEM })
            .catch(() => undefined);
        }
        throw err;
      }
    },
  });
}
