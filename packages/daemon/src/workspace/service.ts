import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Actor,
  type DiffFileStat,
  type DiffStats,
  type Project,
  type Workspace,
  isTerminalRunStatus,
} from '@acc/protocol';
import type { WorkspaceLock, WorkspacesService } from '../contracts';
import type { DaemonContext } from '../core/context';
import { conflict, invalidParams } from '../core/errors';
import { computeDiff } from './diff';
import {
  GitError,
  branchExists,
  currentBranch,
  git,
  gitOut,
  isValidBranchName,
  repoRoot,
  resolveCommit,
  statusLines,
} from './git';
import { KeyedMutex } from './mutex';

export const DEFAULT_COMMIT_AUTHOR = { name: 'AI Agent Command Center', email: 'acc@localhost' };

export interface WorkspaceDiffResult {
  workspaceId: string;
  baseRef: string | null;
  baseSha: string | null;
  headSha: string | null;
  patch: string;
  truncated: boolean;
  stats: DiffStats;
  files: DiffFileStat[];
}

export interface CreateWorktreeInput {
  projectId: string;
  branch?: string;
  baseRef?: string;
  label?: string;
  taskId?: string | null;
  actor: Actor;
}

/** Lowercase ASCII slug for branch names; non-ASCII labels (e.g. Japanese) fall back to "ws". */
export function slugify(text: string | null | undefined, fallback = 'ws'): string {
  const slug = (text ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return slug || fallback;
}

/** Last characters of an id (random part): short, unique enough for branch names. */
export function shortId(id: string): string {
  return id.slice(-8);
}

/**
 * Workspaces = places where agents write: git worktrees under
 * `<ACC_HOME>/worktrees/<projectId>/<workspaceId>`, plus one lazily registered `main`
 * workspace per project (the repository checkout itself).
 *
 * Locks: one writer per workspace. A run lock is kept in memory and persisted in
 * `Workspace.lockedByRunId` (so restart recovery can clear it); internal holders (e.g. an
 * integration working in its worktree) are in-memory only.
 */
export class WorkspaceService implements WorkspacesService {
  /** workspaceId -> holder (runId or an internal owner like "integration:<id>"). */
  private readonly locks = new Map<string, string>();
  /** Serializes worktree add/remove and main-workspace registration per project. */
  readonly repoMutex = new KeyedMutex();

  constructor(private readonly ctx: DaemonContext) {}

  // -------------------------------------------------------------------------
  // lookup
  // -------------------------------------------------------------------------

  get(workspaceId: string): Workspace {
    return this.ctx.repos.workspaces.require(workspaceId);
  }

  list(q: { projectId?: string; taskId?: string; includeRemoved?: boolean }): Workspace[] {
    return this.ctx.repos.workspaces.find({
      where: {
        project_id: q.projectId,
        task_id: q.taskId,
        ...(q.includeRemoved ? {} : { status: ['creating', 'ready', 'removing', 'error'] }),
      },
      direction: 'asc',
    });
  }

  requireRepo(project: Project): string {
    if (!project.repoPath) {
      throw invalidParams(
        `プロジェクト「${project.name}」にリポジトリ（repoPath）が設定されていません`,
      );
    }
    if (!existsSync(project.repoPath)) {
      throw invalidParams(`リポジトリが見つかりません: ${project.repoPath}`);
    }
    return project.repoPath;
  }

  /** The project's default branch: `project.defaultBranch`, else the branch checked out in the repo. */
  async defaultBranch(project: Project): Promise<string> {
    if (project.defaultBranch) return project.defaultBranch;
    const repo = this.requireRepo(project);
    const b = await currentBranch(repo);
    if (!b) {
      throw invalidParams(
        'リポジトリが detached HEAD のため既定ブランチを決められません。プロジェクトの defaultBranch を設定してください',
      );
    }
    return b;
  }

  /**
   * Get (registering on first use) the project's `main` workspace: the repository checkout
   * itself. Its branch is refreshed from git on every call.
   */
  async ensureMain(projectId: string, actor: Actor): Promise<Workspace> {
    const project = this.ctx.repos.projects.require(projectId);
    const repo = this.requireRepo(project);
    const root = await repoRoot(repo);
    if (!root) throw invalidParams(`git リポジトリではありません: ${repo}`);
    const branch = await currentBranch(repo);
    return this.repoMutex.run(projectId, async () =>
      this.ctx.db.transaction(() => {
        const existing = this.ctx.repos.workspaces.findOne({
          where: { project_id: projectId, status: 'ready' },
          sql: { clause: "json_extract(data, '$.kind') = 'main'" },
        });
        const now = this.ctx.clock.iso();
        if (existing) {
          const changes: string[] = [];
          if (existing.branch !== branch) changes.push('branch');
          if (existing.path !== repo) changes.push('path');
          if (changes.length === 0) return existing;
          const workspace = this.ctx.repos.workspaces.update(existing.id, (w) => ({
            ...w,
            branch,
            path: repo,
            updatedAt: now,
          }));
          this.ctx.bus.emit({ type: 'workspace.updated', actor, payload: { workspace, changes } });
          return workspace;
        }
        const workspace = this.ctx.repos.workspaces.insert({
          id: this.ctx.ids.next('workspace'),
          projectId,
          kind: 'main',
          status: 'ready',
          path: repo,
          branch,
          baseRef: null,
          taskId: null,
          lockedByRunId: null,
          error: null,
          createdAt: now,
          updatedAt: now,
        });
        this.ctx.bus.emit({ type: 'workspace.created', actor, payload: { workspace } });
        return workspace;
      }),
    );
  }

  // -------------------------------------------------------------------------
  // create / remove
  // -------------------------------------------------------------------------

  async createWorktree(input: CreateWorktreeInput): Promise<Workspace> {
    const { ctx } = this;
    const project = ctx.repos.projects.require(input.projectId);
    const repo = this.requireRepo(project);
    if (!(await repoRoot(repo))) throw invalidParams(`git リポジトリではありません: ${repo}`);
    const task = input.taskId ? ctx.repos.tasks.require(input.taskId) : null;
    if (task && task.projectId !== project.id) {
      throw invalidParams('タスクが別のプロジェクトに属しています');
    }

    const baseRef = input.baseRef ?? (await this.defaultBranch(project));
    const baseSha = await resolveCommit(repo, baseRef);
    if (!baseSha) throw invalidParams(`作成元の ref「${baseRef}」が見つかりません`);

    const id = ctx.ids.next('workspace');
    const branch = input.branch ?? `acc/${slugify(input.label ?? task?.title)}-${shortId(id)}`;
    if (!(await isValidBranchName(repo, branch))) {
      throw invalidParams(`ブランチ名として使えません: ${branch}`);
    }
    const path = join(ctx.paths.worktrees, project.id, id);

    return this.repoMutex.run(project.id, async () => {
      if (await branchExists(repo, branch)) {
        throw conflict(`ブランチ「${branch}」は既に存在します`, { branch });
      }
      const now = ctx.clock.iso();
      ctx.db.transaction(() => {
        const workspace = ctx.repos.workspaces.insert({
          id,
          projectId: project.id,
          kind: 'worktree',
          status: 'creating',
          path,
          branch,
          baseRef,
          taskId: task?.id ?? null,
          lockedByRunId: null,
          error: null,
          createdAt: now,
          updatedAt: now,
        });
        ctx.bus.emit({ type: 'workspace.created', actor: input.actor, payload: { workspace } });
      });
      try {
        await mkdir(join(ctx.paths.worktrees, project.id), { recursive: true });
        await git(repo, ['worktree', 'add', '-b', branch, path, baseSha]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.setStatus(id, 'error', input.actor, message);
        throw err;
      }
      return this.setStatus(id, 'ready', input.actor, null);
    });
  }

  private setStatus(
    id: string,
    status: Workspace['status'],
    actor: Actor,
    error: string | null,
  ): Workspace {
    return this.ctx.db.transaction(() => {
      const workspace = this.ctx.repos.workspaces.update(id, (w) => ({
        ...w,
        status,
        error,
        updatedAt: this.ctx.clock.iso(),
      }));
      this.ctx.bus.emit({
        type: 'workspace.updated',
        actor,
        payload: { workspace, changes: error === null ? ['status'] : ['status', 'error'] },
      });
      return workspace;
    });
  }

  /**
   * Remove a worktree. The branch is always kept, so committed work is never lost
   * (concept §6.3). Refused while locked, and with uncommitted changes unless `force`.
   */
  async remove(workspaceId: string, opts: { force: boolean; actor: Actor }): Promise<void> {
    const ws = this.get(workspaceId);
    if (ws.kind === 'main') {
      throw invalidParams('プロジェクトのメインワークスペース（リポジトリ本体）は削除できません');
    }
    if (ws.status === 'removed') return;
    if (this.isLocked(workspaceId)) {
      throw conflict('このワークスペースは使用中（ロック中）のため削除できません', {
        workspaceId,
        lockedBy: this.locks.get(workspaceId) ?? ws.lockedByRunId,
      });
    }
    // Hold the lock from the check on (no await in between): a queued run must not start an
    // agent in this directory while the removal waits for git, then lose it to --force.
    const release = this.hold(workspaceId, `remove:${workspaceId}`);
    try {
      await this.removeHeld(ws, opts);
    } finally {
      release();
      // Queued runs waiting on this workspace now fail (removed) or may start (kept).
      if (this.ctx.hasService('runs')) this.ctx.service('runs').pump();
    }
  }

  private async removeHeld(ws: Workspace, opts: { force: boolean; actor: Actor }): Promise<void> {
    const workspaceId = ws.id;
    if (!ws.projectId)
      throw invalidParams('プロジェクトに属さないワークスペースは git で削除できません');
    const project = this.ctx.repos.projects.require(ws.projectId);
    const repo = this.requireRepo(project);
    const exists = existsSync(ws.path);
    if (exists && !opts.force && ws.status === 'ready') {
      const dirty = await statusLines(ws.path);
      if (dirty.length > 0) {
        throw conflict(
          `未コミットの変更が ${dirty.length} 件あります。コミットするか force: true を指定してください`,
          { workspaceId, files: dirty.length },
        );
      }
    }
    await this.repoMutex.run(project.id, async () => {
      this.setStatus(workspaceId, 'removing', opts.actor, null);
      try {
        if (exists) {
          await removeWorktreeDir(repo, ws.path);
        }
        await git(repo, ['worktree', 'prune']);
      } catch (err) {
        this.setStatus(
          workspaceId,
          'error',
          opts.actor,
          err instanceof Error ? err.message : String(err),
        );
        throw err;
      }
      this.ctx.db.transaction(() => {
        this.ctx.repos.workspaces.update(workspaceId, (w) => ({
          ...w,
          status: 'removed',
          error: null,
          updatedAt: this.ctx.clock.iso(),
        }));
        this.ctx.bus.emit({
          type: 'workspace.removed',
          actor: opts.actor,
          payload: { workspaceId },
          refs: { projectId: ws.projectId, taskId: ws.taskId },
        });
      });
    });
  }

  // -------------------------------------------------------------------------
  // locks
  // -------------------------------------------------------------------------

  acquire(workspaceId: string, runId: string): WorkspaceLock {
    const ws = this.get(workspaceId);
    if (ws.status !== 'ready') {
      throw conflict(`ワークスペースが利用できる状態ではありません（${ws.status}）`, {
        workspaceId,
      });
    }
    const holder = this.locks.get(workspaceId);
    if (holder !== undefined && holder !== runId) {
      throw conflict('このワークスペースは別の実行が使用中です', { workspaceId, lockedBy: holder });
    }
    if (
      ws.lockedByRunId &&
      ws.lockedByRunId !== runId &&
      !this.isStaleRunLock(workspaceId, ws.lockedByRunId)
    ) {
      throw conflict('このワークスペースは別の実行が使用中です', {
        workspaceId,
        lockedBy: ws.lockedByRunId,
      });
    }
    this.locks.set(workspaceId, runId);
    if (ws.lockedByRunId !== runId) this.persistLock(workspaceId, runId);
    let released = false;
    return {
      workspaceId,
      runId,
      release: () => {
        if (released) return;
        released = true;
        if (this.locks.get(workspaceId) === runId) this.locks.delete(workspaceId);
        const cur = this.ctx.repos.workspaces.get(workspaceId);
        if (cur?.lockedByRunId === runId) this.persistLock(workspaceId, null);
      },
    };
  }

  /**
   * In-memory lock for daemon-internal work (not tied to a run, so not persisted). Returns a
   * release function. Throws `conflict` when the workspace is held by someone else.
   */
  hold(workspaceId: string, owner: string): () => void {
    const ws = this.get(workspaceId);
    const holder = this.locks.get(workspaceId);
    if (
      (holder !== undefined && holder !== owner) ||
      (ws.lockedByRunId && !this.isStaleRunLock(workspaceId, ws.lockedByRunId))
    ) {
      throw conflict('このワークスペースは別の実行が使用中です', {
        workspaceId,
        lockedBy: holder ?? ws.lockedByRunId,
      });
    }
    this.locks.set(workspaceId, owner);
    return () => {
      if (this.locks.get(workspaceId) === owner) this.locks.delete(workspaceId);
    };
  }

  isLocked(workspaceId: string): boolean {
    if (this.locks.has(workspaceId)) return true;
    const ws = this.ctx.repos.workspaces.get(workspaceId);
    return !!ws?.lockedByRunId && !this.isStaleRunLock(workspaceId, ws.lockedByRunId);
  }

  /** Holder of the lock (run id or internal owner), or null. */
  lockHolder(workspaceId: string): string | null {
    return (
      this.locks.get(workspaceId) ??
      this.ctx.repos.workspaces.get(workspaceId)?.lockedByRunId ??
      null
    );
  }

  /** A persisted lock whose run no longer exists or already ended. */
  private isStaleRunLock(workspaceId: string, runId: string): boolean {
    if (this.locks.get(workspaceId) === runId) return false;
    const run = this.ctx.repos.runs.get(runId);
    return !run || isTerminalRunStatus(run.status);
  }

  private persistLock(workspaceId: string, runId: string | null): void {
    const actor: Actor = { kind: 'system', component: 'workspace' };
    this.ctx.db.transaction(() => {
      const workspace = this.ctx.repos.workspaces.update(workspaceId, (w) => ({
        ...w,
        lockedByRunId: runId,
        updatedAt: this.ctx.clock.iso(),
      }));
      this.ctx.bus.emit({
        type: 'workspace.updated',
        actor,
        payload: { workspace, changes: ['lockedByRunId'] },
      });
    });
  }

  /** Clear persisted locks whose run is gone or finished (startup safety net beside core recovery). */
  clearStaleLocks(): string[] {
    const cleared: string[] = [];
    for (const ws of this.ctx.repos.workspaces.find({
      where: { locked_by_run_id: { not: null } },
    })) {
      if (
        ws.lockedByRunId &&
        !this.locks.has(ws.id) &&
        this.isStaleRunLock(ws.id, ws.lockedByRunId)
      ) {
        this.persistLock(ws.id, null);
        cleared.push(ws.id);
      }
    }
    return cleared;
  }

  // -------------------------------------------------------------------------
  // git content
  // -------------------------------------------------------------------------

  commitAuthor(projectId: string | null): { name: string; email: string } {
    return (
      (projectId ? this.ctx.repos.projects.get(projectId)?.commitAuthor : null) ??
      DEFAULT_COMMIT_AUTHOR
    );
  }

  /** Author/committer environment for commits and merges made by the daemon. */
  identityEnv(projectId: string | null): Record<string, string> {
    const a = this.commitAuthor(projectId);
    return {
      GIT_AUTHOR_NAME: a.name,
      GIT_AUTHOR_EMAIL: a.email,
      GIT_COMMITTER_NAME: a.name,
      GIT_COMMITTER_EMAIL: a.email,
    };
  }

  async commitAll(workspaceId: string, message: string, actor: Actor): Promise<string | null> {
    const ws = this.requireReady(workspaceId);
    if (actor.kind === 'agent') {
      const holder = this.lockHolder(workspaceId);
      if (holder && holder !== actor.runId) {
        throw conflict('このワークスペースは別の実行が使用中のためコミットできません', {
          workspaceId,
          lockedBy: holder,
        });
      }
    }
    if (!message.trim()) throw invalidParams('コミットメッセージが空です');
    await git(ws.path, ['add', '-A']);
    const hasChanges = !(await git(ws.path, ['diff', '--cached', '--quiet'], {
      okCodes: [0, 1],
    }).then((r) => r.code === 0));
    if (!hasChanges) return null;
    await git(ws.path, ['commit', '--quiet', '--no-verify', '-m', message], {
      env: this.identityEnv(ws.projectId),
    });
    const sha = await gitOut(ws.path, ['rev-parse', 'HEAD']);
    if (ws.kind === 'main' && ws.projectId) {
      // The main checkout may have switched branches; keep the record fresh.
      await this.ensureMain(ws.projectId, actor);
    }
    return sha;
  }

  async diff(workspaceId: string, baseRef?: string): Promise<WorkspaceDiffResult> {
    const ws = this.requireReady(workspaceId);
    const ref = baseRef ?? ws.baseRef;
    const d = await computeDiff(ws.path, ref);
    return {
      workspaceId,
      baseRef: ref,
      baseSha: d.baseSha,
      headSha: d.headSha,
      patch: d.patch,
      truncated: d.truncated,
      stats: d.stats,
      files: d.files,
    };
  }

  private requireReady(workspaceId: string): Workspace {
    const ws = this.get(workspaceId);
    if (ws.status !== 'ready') {
      throw conflict(`ワークスペースが利用できる状態ではありません（${ws.status}）`, {
        workspaceId,
      });
    }
    if (!existsSync(ws.path)) {
      throw conflict(`ワークスペースのディレクトリが見つかりません: ${ws.path}`, { workspaceId });
    }
    return ws;
  }
}

/**
 * `git worktree remove --force`, retrying for Windows file locks (antivirus, editors,
 * just-exited processes). Falls back to deleting the directory; the caller prunes.
 */
async function removeWorktreeDir(repo: string, path: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await git(repo, ['worktree', 'remove', '--force', path]);
      return;
    } catch (err) {
      lastErr = err;
      if (!(err instanceof GitError) || !existsSync(path)) break;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  if (existsSync(path)) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }
  }
}
