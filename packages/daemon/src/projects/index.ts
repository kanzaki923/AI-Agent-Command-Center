import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Actor, Project, Schedule } from '@acc/protocol';
import { defineMethod } from '../api/registry';
import { forbidden, invalidParams } from '../core/errors';
import type { DaemonContext } from '../core/context';
import { subtreeIds } from '../home/tree';
import { defineModule } from '../module';
import { disableSchedules } from '../sessions/methods/archive';
import { hasWorkToStop, stopSessions } from '../sessions/methods/stop';
import { isInside } from '../runtime/policy';
import { inspectFolder, inspectRepo } from './inspect';

export { detectTestCommand, inspectFolder, inspectRepo } from './inspect';

function checkRepoPath(path: string | null | undefined, field = 'repoPath'): void {
  if (path == null) return;
  if (!isAbsolute(path)) throw invalidParams(`${field} must be an absolute path: ${path}`);
  if (!existsSync(path)) throw invalidParams(`${field} does not exist: ${path}`);
}

/**
 * A project's folder bounds where its agents may write: it must not hold the daemon's data
 * (a home folder or a drive root would hand them the database, tokens and other worktrees).
 */
function checkProjectFolder(path: string | null | undefined, home: string): void {
  checkRepoPath(path, 'folderPath');
  if (path != null && isInside(home, path)) {
    throw invalidParams('アプリのデータフォルダを含む場所はプロジェクトのフォルダにできません');
  }
}

/**
 * How much agents may do without asking is a human's call: an agent with project.update
 * must not move its own project to a looser profile.
 */
/**
 * What bounds the agents of a project is the human's to set: its tool permissions, the
 * folders they may work in (an agent's folder must lie in `folderPath`), and the test
 * command the daemon runs in a shell.
 */
function checkHumanOnly(
  p: {
    permissionProfile?: unknown;
    repoPath?: unknown;
    folderPath?: unknown;
    testCommand?: unknown;
  },
  actor: Actor,
): void {
  if (actor.kind !== 'agent') return;
  if (p.permissionProfile !== undefined) {
    throw forbidden('権限プロファイルを変えられるのは人間だけです');
  }
  if (p.repoPath !== undefined || p.folderPath !== undefined || p.testCommand !== undefined) {
    throw forbidden(
      'プロジェクトのリポジトリ・フォルダ・テストコマンドを決められるのは人間だけです',
    );
  }
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
      // Any folder, git or not (spec 20261029 §2.2).
      defineMethod('project.inspectFolder', {
        handler: (p) => inspectFolder(ctx, p.path),
      }),

      defineMethod('project.create', {
        handler: (p, call) =>
          db.transaction(() => {
            // Who may set it comes before whether it is valid.
            checkHumanOnly(p, call.actor);
            checkRepoPath(p.repoPath);
            checkProjectFolder(p.folderPath, ctx.paths.home);
            const now = ctx.clock.iso();
            const project = repos.projects.insert({
              id: ctx.ids.next('project'),
              name: p.name.trim(),
              description: p.description ?? null,
              repoPath: p.repoPath ?? null,
              folderPath: p.folderPath ?? null,
              defaultBranch: p.defaultBranch ?? null,
              defaultModel: p.defaultModel ?? null,
              testCommand: p.testCommand?.trim() ?? null,
              commitAuthor: p.commitAuthor ?? null,
              permissionProfile: p.permissionProfile ?? null,
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
        handler: (p, call) => {
          const disabled: Schedule[] = [];
          const updated = db.transaction(() => {
            // Who may set it comes before whether it is valid.
            checkHumanOnly(p, call.actor);
            checkRepoPath(p.repoPath);
            checkProjectFolder(p.folderPath, ctx.paths.home);
            const cur = repos.projects.require(p.projectId);
            if (p.archived === true && cur.archivedAt === null) {
              disabled.push(...stopProjectWork(ctx, cur.id, call.actor));
            }
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
              assign('folderPath', p.folderPath);
              assign('defaultBranch', p.defaultBranch);
              assign('defaultModel', p.defaultModel);
              assign('permissionProfile', p.permissionProfile);
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
          });
          if (disabled.length > 0 && ctx.hasService('scheduler')) ctx.service('scheduler').rearm();
          return updated;
        },
      }),
    );
  },
});

/**
 * Removing (archiving) a project hides it from every list and place picker, so nothing in it
 * may go on working out of sight: what still runs in its conversations is stopped and their
 * repeats are turned off, as when a conversation is archived. The conversations, their outputs
 * and the folder itself stay as they are; bringing the project back restarts nothing.
 */
function stopProjectWork(ctx: DaemonContext, projectId: string, actor: Actor): Schedule[] {
  const ids = new Set<string>();
  for (const s of ctx.repos.sessions.find({ where: { project_id: projectId } })) {
    for (const id of subtreeIds(ctx, s.id)) ids.add(id);
  }
  for (const id of ids) {
    if (hasWorkToStop(ctx, id)) stopSessions(ctx, id, { tree: false }, actor);
  }
  const off = disableSchedules(ctx, [...ids], actor);
  // A repeat owned elsewhere (the assistant's) that starts its work in this project's code
  // would fail at every firing now: it is turned off as well.
  for (const sch of ctx.repos.schedules.find({ where: { enabled: true } })) {
    const ws = sch.run.workspace;
    if (ws?.kind !== 'worktree' || ws.projectId !== projectId) continue;
    const next = ctx.repos.schedules.update(sch.id, (cur) => ({
      ...cur,
      enabled: false,
      nextRunAt: null,
      updatedAt: ctx.clock.iso(),
    }));
    if (ctx.hasService('scheduler')) {
      ctx.service('scheduler').emitUpdated(next, ['enabled', 'nextRunAt'], actor);
    }
    off.push(next);
  }
  return off;
}
