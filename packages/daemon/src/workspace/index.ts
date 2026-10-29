import { defineMethod } from '../api/registry';
import { invalidParams } from '../core/errors';
import { defineModule } from '../module';
import { WorkspaceService } from './service';

export {
  WorkspaceService,
  DEFAULT_COMMIT_AUTHOR,
  SCRATCH_RETENTION_DAYS,
  checkFolder,
  samePath,
  slugify,
  shortId,
} from './service';
export type { WorkspaceDiffResult, CreateWorktreeInput } from './service';
export { GitError, git, gitOut } from './git';

declare module '../core/context' {
  interface Services {
    /** Concrete workspace service (superset of `workspaces`) for modules that need more. */
    workspaceManager: WorkspaceService;
  }
}

/**
 * Git worktree management (architecture.md §2.8).
 *
 * Methods: workspace.create, workspace.list, workspace.get, workspace.remove, workspace.diff.
 * Services: `workspaces` (contracts.ts WorkspacesService) and `workspaceManager` (the same
 * object typed as WorkspaceService: list / remove / ensureMain / hold / identityEnv …).
 */
export const workspaceModule = defineModule({
  name: 'workspace',
  register(ctx) {
    const service = new WorkspaceService(ctx);
    ctx.provide('workspaces', service);
    ctx.provide('workspaceManager', service);

    const wsScope = (workspaceId: string) => {
      const ws = ctx.repos.workspaces.get(workspaceId);
      return { projectIds: ws?.projectId ? [ws.projectId] : [] };
    };

    ctx.methods.register(
      defineMethod('workspace.create', {
        scope: (p) => ({ projectIds: [p.projectId] }),
        handler: async (p, call) => {
          if (p.kind === 'main') return service.ensureMain(p.projectId, call.actor);
          if (p.kind === 'directory') {
            throw invalidParams('kind "directory" のワークスペースにはまだ対応していません');
          }
          return service.createWorktree({
            projectId: p.projectId,
            ...(p.branch ? { branch: p.branch } : {}),
            ...(p.baseRef ? { baseRef: p.baseRef } : {}),
            ...(p.label ? { label: p.label } : {}),
            taskId: p.taskId ?? null,
            actor: call.actor,
          });
        },
      }),

      defineMethod('workspace.list', {
        scope: (p) => ({ projectIds: p.projectId ? [p.projectId] : [] }),
        handler: async (p, call) => {
          if (p.projectId) {
            // Register the repository checkout itself on first sight (best effort: a project
            // whose repoPath is missing or not a git repo simply has no main workspace).
            const project = ctx.repos.projects.require(p.projectId);
            if (project.repoPath) {
              await service.ensureMain(project.id, call.actor).catch((err: unknown) => {
                ctx.log.debug('main workspace not registered', { projectId: project.id, err });
              });
            }
          }
          return {
            items: service.list({
              ...(p.projectId ? { projectId: p.projectId } : {}),
              ...(p.taskId ? { taskId: p.taskId } : {}),
              includeRemoved: p.includeRemoved,
            }),
          };
        },
      }),

      defineMethod('workspace.get', {
        scope: (p) => wsScope(p.workspaceId),
        handler: async (p, call) => {
          const ws = service.get(p.workspaceId);
          if (ws.kind === 'main' && ws.status === 'ready' && ws.projectId) {
            return service.ensureMain(ws.projectId, call.actor).catch(() => ws);
          }
          return ws;
        },
      }),

      defineMethod('workspace.remove', {
        scope: (p) => wsScope(p.workspaceId),
        handler: async (p, call) => {
          await service.remove(p.workspaceId, { force: p.force, actor: call.actor });
          return { ok: true as const };
        },
      }),

      defineMethod('workspace.diff', {
        scope: (p) => wsScope(p.workspaceId),
        handler: async (p) => {
          const d = await service.diff(p.workspaceId, p.baseRef);
          return {
            workspaceId: d.workspaceId,
            baseRef: d.baseRef,
            patch: d.patch,
            stats: d.stats,
            files: d.files,
          };
        },
      }),
    );

    // Scratch folders of long-archived sessions go away (spec 20261029 §3.3): at startup and
    // once a day.
    let sweepTimer: NodeJS.Timeout | null = null;
    const sweep = () => {
      void service
        .sweepScratch()
        .then((removed) => {
          if (removed.length > 0) ctx.log.info('old scratch folders removed', { removed });
        })
        .catch((err: unknown) => ctx.log.warn('scratch sweep failed', { err }));
    };

    return {
      start() {
        const cleared = service.clearStaleLocks();
        if (cleared.length > 0) ctx.log.warn('cleared stale workspace locks', { cleared });
        sweep();
        sweepTimer = setInterval(sweep, 24 * 60 * 60 * 1000);
        sweepTimer.unref?.();
      },
      stop() {
        if (sweepTimer) clearInterval(sweepTimer);
      },
    };
  },
});
