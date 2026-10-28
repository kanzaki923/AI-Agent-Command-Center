import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Project } from '@acc/protocol';
import { defineMethod } from '../api/registry';
import { invalidParams } from '../core/errors';
import { defineModule } from '../module';
import { inspectRepo } from './inspect';

export { detectTestCommand, inspectRepo } from './inspect';

function checkRepoPath(path: string | null | undefined): void {
  if (path == null) return;
  if (!isAbsolute(path)) throw invalidParams(`repoPath must be an absolute path: ${path}`);
  if (!existsSync(path)) throw invalidParams(`repoPath does not exist: ${path}`);
}

/** project.* — projects (a repository plus settings). project.inspectRepo validates a folder first. */
export const projectsModule = defineModule({
  name: 'projects',
  register(ctx) {
    const { repos, bus, db } = ctx;

    ctx.methods.register(
      defineMethod('project.inspectRepo', {
        handler: (p) => inspectRepo(ctx, p.path),
      }),

      defineMethod('project.create', {
        handler: (p, call) =>
          db.transaction(() => {
            checkRepoPath(p.repoPath);
            const now = ctx.clock.iso();
            const project = repos.projects.insert({
              id: ctx.ids.next('project'),
              name: p.name.trim(),
              description: p.description ?? null,
              repoPath: p.repoPath ?? null,
              defaultBranch: p.defaultBranch ?? null,
              defaultModel: p.defaultModel ?? null,
              testCommand: p.testCommand?.trim() ?? null,
              commitAuthor: p.commitAuthor ?? null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
            });
            bus.emit({ type: 'project.created', actor: call.actor, payload: { project } });
            return project;
          }),
      }),

      defineMethod('project.list', {
        // Listing is project-scoped but unnarrowed: project-restricted agents use project.get.
        scope: () => ({ projectIds: [] }),
        handler: (p) => ({
          items: repos.projects.find({
            where: p.includeArchived ? {} : { archived_at: null },
            orderBy: 'name',
            direction: 'asc',
          }),
        }),
      }),

      defineMethod('project.get', {
        scope: (p) => ({ projectIds: [p.projectId] }),
        handler: (p) => repos.projects.require(p.projectId),
      }),

      defineMethod('project.update', {
        scope: (p) => ({ projectIds: [p.projectId] }),
        handler: (p, call) =>
          db.transaction(() => {
            checkRepoPath(p.repoPath);
            const changes: string[] = [];
            const project = repos.projects.update(p.projectId, (cur) => {
              const next: Project = { ...cur };
              const assign = <K extends keyof Project>(key: K, value: Project[K] | undefined) => {
                if (value === undefined || cur[key] === value) return;
                next[key] = value;
                changes.push(key);
              };
              assign('name', p.name?.trim());
              assign('description', p.description);
              assign('repoPath', p.repoPath);
              assign('defaultBranch', p.defaultBranch);
              assign('defaultModel', p.defaultModel);
              assign(
                'testCommand',
                p.testCommand === undefined ? undefined : (p.testCommand?.trim() ?? null),
              );
              if (
                p.commitAuthor !== undefined &&
                JSON.stringify(p.commitAuthor) !== JSON.stringify(cur.commitAuthor)
              ) {
                next.commitAuthor = p.commitAuthor;
                changes.push('commitAuthor');
              }
              if (p.archived !== undefined && p.archived !== (cur.archivedAt !== null)) {
                next.archivedAt = p.archived ? ctx.clock.iso() : null;
                changes.push('archivedAt');
              }
              if (changes.length > 0) next.updatedAt = ctx.clock.iso();
              return next;
            });
            if (changes.length > 0) {
              bus.emit({
                type: 'project.updated',
                actor: call.actor,
                payload: { project, changes },
              });
            }
            return project;
          }),
      }),
    );
  },
});
