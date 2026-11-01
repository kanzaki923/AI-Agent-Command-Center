import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '@acc/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  HUMAN,
  type TestDaemonNoServer,
  agentActor,
  createTestDaemon,
  insertTestTask,
} from '../testing';
import { createManualClock } from '../core/clock';
import { mergeStats, parseNameStatusZ, parseNumstatZ } from './diff';
import { GitError, git, gitOut } from './git';
import { type TempRepo, createTempRepo, isolateGitConfig } from './git-fixture';
import { SCRATCH_RETENTION_DAYS, checkFolder, slugify } from './service';

// Real git on Windows costs ~50 ms per call; leave headroom under parallel load.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let restoreGit: () => void;
beforeAll(() => {
  restoreGit = isolateGitConfig();
});
afterAll(() => restoreGit());

let d: TestDaemonNoServer | undefined;
let repo: TempRepo | undefined;
afterEach(async () => {
  await d?.cleanup();
  await repo?.cleanup();
  d = undefined;
  repo = undefined;
});

async function setup(files: Record<string, string> = {}): Promise<{
  d: TestDaemonNoServer;
  repo: TempRepo;
  project: Project;
}> {
  repo = await createTempRepo(files);
  d = await createTestDaemon();
  const project = await d.call(HUMAN, 'project.create', {
    name: 'demo',
    repoPath: repo.path,
    defaultBranch: 'main',
  });
  return { d, repo, project };
}

describe('git helpers', () => {
  it('reports failures with the command and git stderr', async () => {
    repo = await createTempRepo();
    const err = await git(repo.path, ['rev-parse', '--verify', 'no-such-ref']).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).message).toMatch(
      /git rev-parse --verify no-such-ref が失敗しました（終了コード 128）/,
    );
    expect((err as GitError).code).toBe(128);
  });

  it('parses -z numstat / name-status including renames and binary files', () => {
    const numstat = parseNumstatZ('3\t1\tsrc/a.ts\0-\t-\timg.png\0' + '0\t0\t\0old.txt\0new.txt\0');
    expect(numstat).toEqual([
      { path: 'src/a.ts', additions: 3, deletions: 1, binary: false },
      { path: 'img.png', additions: 0, deletions: 0, binary: true },
      { path: 'new.txt', oldPath: 'old.txt', additions: 0, deletions: 0, binary: false },
    ]);
    const ns = parseNameStatusZ('M\0src/a.ts\0A\0img.png\0R100\0old.txt\0new.txt\0D\0gone.md\0');
    expect(mergeStats(numstat, ns)).toEqual([
      { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
      { path: 'img.png', status: 'added', additions: 0, deletions: 0 },
      { path: 'new.txt', status: 'renamed', additions: 0, deletions: 0, oldPath: 'old.txt' },
      { path: 'gone.md', status: 'deleted', additions: 0, deletions: 0 },
    ]);
  });

  it('slugifies labels for branch names', () => {
    expect(slugify('Fix Login Bug!')).toBe('fix-login-bug');
    expect(slugify('ログイン修正')).toBe('ws');
    expect(slugify('a'.repeat(50))).toHaveLength(32);
  });
});

describe('workspace worktrees', () => {
  it('creates a worktree on a fresh branch under ACC_HOME/worktrees/<project>/<workspace>', async () => {
    const { d, repo, project } = await setup();
    const ws = await d.call(HUMAN, 'workspace.create', {
      projectId: project.id,
      label: 'Fix Login',
    });
    expect(ws).toMatchObject({
      kind: 'worktree',
      status: 'ready',
      baseRef: 'main',
      lockedByRunId: null,
    });
    expect(ws.path).toBe(join(d.home, 'worktrees', project.id, ws.id));
    expect(ws.branch).toMatch(/^acc\/fix-login-[0-9a-z]{8}$/);
    expect(existsSync(join(ws.path, 'README.md'))).toBe(true);
    expect(await repo.git('branch', '--list', ws.branch!)).toContain(ws.branch);

    const generated = await d.call(HUMAN, 'workspace.create', { projectId: project.id });
    expect(generated.branch).toMatch(/^acc\/ws-[0-9a-z]{8}$/);

    const types = d.ctx.bus.list({ types: ['workspace.*'] }).events.map((e) => e.type);
    expect(types).toEqual([
      'workspace.created',
      'workspace.updated',
      'workspace.created',
      'workspace.updated',
    ]);
    expect(await d.call(HUMAN, 'workspace.get', { workspaceId: ws.id })).toEqual(ws);
  });

  it('rejects bad input with clear errors', async () => {
    const { d, project } = await setup();
    const chatOnly = await d.call(HUMAN, 'project.create', { name: 'chat only' });
    await expect(
      d.call(HUMAN, 'workspace.create', { projectId: chatOnly.id }),
    ).rejects.toMatchObject({
      code: 'invalid_params',
      message: expect.stringContaining('リポジトリ') as unknown,
    });
    await expect(
      d.call(HUMAN, 'workspace.create', { projectId: project.id, baseRef: 'nope' }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(
      d.call(HUMAN, 'workspace.create', { projectId: project.id, branch: 'main' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      d.call(HUMAN, 'workspace.create', { projectId: project.id, branch: 'bad..name' }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('diffs committed, unstaged and untracked changes against the merge-base without touching the index', async () => {
    const { d, repo, project } = await setup({
      'src/a.txt': 'one\ntwo\n',
      'old.txt': 'rename me\n',
    });
    const ws = await d.call(HUMAN, 'workspace.create', { projectId: project.id });
    // Committed rename + binary file, then unstaged edit, untracked file and deletion.
    await git(ws.path, ['mv', 'old.txt', 'new.txt']);
    writeFileSync(join(ws.path, 'logo.bin'), Buffer.from([0, 1, 2, 3, 255, 0, 10]));
    await repo.commit('rename', ws.path);
    repo.write('src/a.txt', 'one\nTWO\nthree\n', ws.path);
    repo.write('notes/new.md', 'hello\n', ws.path);
    await git(ws.path, ['rm', '-q', 'README.md']);
    // The base branch moving on must not show up in the workspace diff (merge-base).
    repo.write('main-only.txt', 'x\n');
    await repo.commit('main moves');

    const statusBefore = await gitOut(ws.path, ['status', '--porcelain']);
    const diff = await d.call(HUMAN, 'workspace.diff', { workspaceId: ws.id });
    expect(diff.baseRef).toBe('main');
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]));
    expect(byPath['src/a.txt']).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
    expect(byPath['notes/new.md']).toMatchObject({ status: 'added', additions: 1 });
    expect(byPath['README.md']).toMatchObject({ status: 'deleted', deletions: 1 });
    expect(byPath['new.txt']).toMatchObject({ status: 'renamed', oldPath: 'old.txt' });
    expect(byPath['logo.bin']).toMatchObject({ status: 'added', additions: 0, deletions: 0 });
    expect(byPath['main-only.txt']).toBeUndefined();
    expect(diff.stats.files).toBe(diff.files.length);
    expect(diff.patch).toContain('+TWO');
    expect(diff.patch).toContain('+hello');
    // The agent's index is untouched: the untracked file is still untracked.
    expect(await gitOut(ws.path, ['status', '--porcelain'])).toBe(statusBefore);
    expect(statusBefore).toContain('?? notes/');
  });

  it('commits everything with the daemon identity (or the project setting) and no-ops when clean', async () => {
    const { d, repo, project } = await setup();
    const ws = await d.call(HUMAN, 'workspace.create', { projectId: project.id });
    const svc = d.ctx.service('workspaces');
    expect(await svc.commitAll(ws.id, 'nothing', HUMAN)).toBeNull();

    repo.write('feature.txt', 'feature\n', ws.path);
    const sha = await svc.commitAll(ws.id, 'Add feature', HUMAN);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await gitOut(ws.path, ['log', '-1', '--format=%an <%ae>|%cn|%s'])).toBe(
      'AI Agent Command Center <acc@localhost>|AI Agent Command Center|Add feature',
    );
    expect(await svc.commitAll(ws.id, 'again', HUMAN)).toBeNull();

    await d.call(HUMAN, 'project.update', {
      projectId: project.id,
      commitAuthor: { name: 'Bot', email: 'bot@example.com' },
    });
    repo.write('feature.txt', 'feature 2\n', ws.path);
    await svc.commitAll(ws.id, 'Update feature', HUMAN);
    expect(await gitOut(ws.path, ['log', '-1', '--format=%an <%ae>'])).toBe(
      'Bot <bot@example.com>',
    );

    const diff = await svc.diff(ws.id);
    expect(diff.files.map((f) => f.path)).toEqual(['feature.txt']);
  });

  it('never runs repository-controlled programs or leaks the environment from its own git calls', async () => {
    const { d, repo, project } = await setup();
    const ws = await d.call(HUMAN, 'workspace.create', { projectId: project.id });
    const svc = d.ctx.service('workspaces');
    const marker = join(repo.path, '..', `pwned-${ws.id}`);
    const script = `node -e "require('fs').writeFileSync(process.argv[1], process.env.ACC_SECRET_PROBE || 'ran')" "${marker.replace(/\\/g, '/')}"`;

    // 1. husky-style relative hooksPath in the shared config + a hook written in the tree.
    await repo.git('config', 'core.hooksPath', '.hooks');
    // post-commit runs even with --no-verify.
    repo.write('.hooks/post-commit', `#!/bin/sh\n${script}\n`, ws.path);
    process.env.ACC_SECRET_PROBE = 'secret';
    try {
      expect(await svc.commitAll(ws.id, 'With hook', HUMAN)).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(marker)).toBe(false);

      // 2. `.git` redirected to a gitdir the agent made, whose config sets core.fsmonitor.
      repo.write('evil/HEAD', 'ref: refs/heads/main\n', ws.path);
      repo.write('evil/objects/.keep', '', ws.path);
      repo.write('evil/refs/.keep', '', ws.path);
      repo.write(
        'evil/config',
        `[core]\n\tfsmonitor = "${script.replace(/"/g, '\\"')}"\n`,
        ws.path,
      );
      // git marks `.git` hidden on Windows, where only an in-place rewrite (r+) is allowed.
      const dotGit = join(ws.path, '.git');
      truncateSync(dotGit);
      writeFileSync(dotGit, 'gitdir: evil\n', { flag: 'r+' });
      repo.write('more.txt', 'x', ws.path);
      await expect(svc.commitAll(ws.id, 'Redirected', HUMAN)).rejects.toThrow(/\.git/);
      expect(existsSync(marker)).toBe(false);

      // 3. Whatever git does run sees only the allowlisted environment.
      const seen = await gitOut(repo.path, [
        '-c',
        `alias.probe=!node -p "process.env.ACC_SECRET_PROBE || 'none'"`,
        'probe',
      ]);
      expect(seen).toBe('none');
    } finally {
      delete process.env.ACC_SECRET_PROBE;
    }
  });

  it('locks a workspace for one run at a time and refuses removal while locked', async () => {
    const { d, repo, project } = await setup();
    const ws = await d.call(HUMAN, 'workspace.create', { projectId: project.id });
    const svc = d.ctx.service('workspaces');
    const runA = d.ctx.ids.next('run');
    const runB = d.ctx.ids.next('run');

    const lock = svc.acquire(ws.id, runA);
    expect(svc.isLocked(ws.id)).toBe(true);
    expect(d.ctx.repos.workspaces.require(ws.id).lockedByRunId).toBe(runA);
    expect(() => svc.acquire(ws.id, runB)).toThrow(expect.objectContaining({ code: 'conflict' }));
    // Re-acquiring by the holder is fine.
    svc.acquire(ws.id, runA);

    // Another run's agent cannot commit into a workspace it does not hold.
    repo.write('x.txt', 'x\n', ws.path);
    await expect(
      svc.commitAll(ws.id, 'sneaky', agentActor(d.ctx.ids.next('session'), runB)),
    ).rejects.toMatchObject({ code: 'conflict' });

    await expect(
      d.call(HUMAN, 'workspace.remove', { workspaceId: ws.id, force: true }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('ロック中') as unknown,
    });

    lock.release();
    expect(svc.isLocked(ws.id)).toBe(false);
    expect(d.ctx.repos.workspaces.require(ws.id).lockedByRunId).toBeNull();
    const lockB = svc.acquire(ws.id, runB);
    lockB.release();
    lockB.release(); // idempotent
  });

  it('removes a worktree but keeps its branch; refuses uncommitted changes unless forced', async () => {
    const { d, repo, project } = await setup();
    const ws = await d.call(HUMAN, 'workspace.create', { projectId: project.id });
    repo.write('work.txt', 'precious\n', ws.path);
    await expect(d.call(HUMAN, 'workspace.remove', { workspaceId: ws.id })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('未コミット') as unknown,
    });
    await d.ctx.service('workspaces').commitAll(ws.id, 'Keep work', HUMAN);
    await d.call(HUMAN, 'workspace.remove', { workspaceId: ws.id });

    expect(existsSync(ws.path)).toBe(false);
    expect(await repo.git('show', `${ws.branch}:work.txt`)).toBe('precious');
    expect(await repo.git('worktree', 'list')).not.toContain(ws.id);
    expect((await d.call(HUMAN, 'workspace.get', { workspaceId: ws.id })).status).toBe('removed');
    const listed = await d.call(HUMAN, 'workspace.list', { projectId: project.id });
    expect(listed.items.map((w) => w.id)).not.toContain(ws.id);
    const all = await d.call(HUMAN, 'workspace.list', {
      projectId: project.id,
      includeRemoved: true,
    });
    expect(all.items.map((w) => w.id)).toContain(ws.id);
    expect(d.ctx.bus.list({ types: ['workspace.removed'] }).events).toHaveLength(1);

    const dirty = await d.call(HUMAN, 'workspace.create', { projectId: project.id });
    repo.write('scratch.txt', 'tmp\n', dirty.path);
    await d.call(HUMAN, 'workspace.remove', { workspaceId: dirty.id, force: true });
    expect(existsSync(dirty.path)).toBe(false);
  });

  it('registers the repository itself as the main workspace lazily and never removes it', async () => {
    const { d, repo, project } = await setup();
    const listed = await d.call(HUMAN, 'workspace.list', { projectId: project.id });
    expect(listed.items).toHaveLength(1);
    const main = listed.items[0]!;
    expect(main).toMatchObject({ kind: 'main', path: repo.path, branch: 'main', baseRef: null });
    // Idempotent and refreshed from git.
    await repo.git('switch', '-q', '-c', 'feature');
    const again = await d.call(HUMAN, 'workspace.create', { projectId: project.id, kind: 'main' });
    expect(again).toMatchObject({ id: main.id, branch: 'feature' });
    expect((await d.call(HUMAN, 'workspace.list', { projectId: project.id })).items).toHaveLength(
      1,
    );
    await expect(d.call(HUMAN, 'workspace.remove', { workspaceId: main.id })).rejects.toMatchObject(
      {
        code: 'invalid_params',
      },
    );
    const lock = d.ctx.service('workspaces').acquire(main.id, d.ctx.ids.next('run'));
    lock.release();
  });

  it('links a worktree to its task and names the branch after it', async () => {
    const { d, project } = await setup();
    const task = insertTestTask(d.ctx, { projectId: project.id, title: 'Add search API' });
    const ws = await d.call(HUMAN, 'workspace.create', { projectId: project.id, taskId: task.id });
    expect(ws.taskId).toBe(task.id);
    expect(ws.branch).toMatch(/^acc\/add-search-api-[0-9a-z]{8}$/);
    const events = d.ctx.bus.list({ taskId: task.id, types: ['workspace.*'] }).events;
    expect(events.length).toBeGreaterThan(0);
    expect(
      (await d.call(HUMAN, 'workspace.list', { taskId: task.id })).items.map((w) => w.id),
    ).toEqual([ws.id]);
  });

  it('applies capability scope for agents', async () => {
    const { d, project } = await setup();
    const other = await d.call(HUMAN, 'project.create', { name: 'other' });
    const run = d.ctx.ids.next('run');
    const session = d.ctx.ids.next('session');
    d.ctx.repos.grants.insert({
      id: d.ctx.ids.next('grant'),
      subject: { kind: 'run', runId: run },
      parentGrantId: null,
      permissions: ['workspace.*'],
      scope: { projectIds: [project.id] },
      limits: {},
      depth: 0,
      lifetime: 'run',
      expiresAt: null,
      revokedAt: null,
      reason: null,
      grantedBy: HUMAN,
      createdAt: d.ctx.clock.iso(),
    });
    const agent = agentActor(session, run);
    const ws = await d.call(agent, 'workspace.create', { projectId: project.id });
    expect(ws.status).toBe('ready');
    await expect(d.call(agent, 'workspace.create', { projectId: other.id })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(d.call(agent, 'workspace.list', {})).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('clears persisted locks of runs that no longer run when the daemon restarts', async () => {
    const { d: first, project } = await setup();
    const ws = await first.call(HUMAN, 'workspace.create', { projectId: project.id });
    first.ctx.service('workspaces').acquire(ws.id, first.ctx.ids.next('run'));
    expect(first.ctx.repos.workspaces.require(ws.id).lockedByRunId).not.toBeNull();
    const home = first.home;
    await first.close();

    const second = await createTestDaemon({ home });
    try {
      expect(second.ctx.repos.workspaces.require(ws.id).lockedByRunId).toBeNull();
      expect(second.ctx.service('workspaces').isLocked(ws.id)).toBe(false);
      const ev = second.ctx.bus.list({ types: ['workspace.updated'] }).events.at(-1);
      expect(ev?.actor).toEqual({ kind: 'system', component: 'workspace' });
    } finally {
      await second.close();
    }
  });

  it('keeps files byte-for-byte (no CRLF conversion) in worktrees', async () => {
    const { d, project } = await setup({ 'lf.txt': 'a\nb\n' });
    const ws = await d.call(HUMAN, 'workspace.create', { projectId: project.id });
    expect(readFileSync(join(ws.path, 'lf.txt'), 'utf8')).toBe('a\nb\n');
  });
});

describe('scratch and folder workspaces (no git)', () => {
  it('scratch folders live under ACC_HOME/scratch and go 30 days after the session is archived', async () => {
    const clock = createManualClock(Date.UTC(2026, 9, 1));
    d = await createTestDaemon({ clock });
    const manager = d.ctx.service('workspaceManager');
    const keep = await d.call(HUMAN, 'session.create', {
      kind: 'agent',
      workspace: { kind: 'none' },
    });
    const old = await d.call(HUMAN, 'session.create', {
      kind: 'agent',
      workspace: { kind: 'none' },
    });
    const wsOld = d.ctx.repos.workspaces.require(old.workspaceId!);
    expect(wsOld.path).toBe(join(manager.scratchRoot, old.id));
    expect(existsSync(wsOld.path)).toBe(true);
    // A deleted folder comes back before a run uses it.
    rmSync(wsOld.path, { recursive: true });
    manager.ensureScratchDir(wsOld);
    expect(existsSync(wsOld.path)).toBe(true);

    await d.call(HUMAN, 'session.archive', { sessionId: old.id });
    clock.advance((SCRATCH_RETENTION_DAYS - 1) * 86_400_000);
    expect(await manager.sweepScratch()).toEqual([]);
    clock.advance(2 * 86_400_000);
    expect(await manager.sweepScratch()).toEqual([wsOld.id]);
    expect(existsSync(wsOld.path)).toBe(false);
    expect(d.ctx.repos.workspaces.require(wsOld.id).status).toBe('removed');
    expect(d.ctx.repos.workspaces.require(keep.workspaceId!).status).toBe('ready');
  });

  it("a folder of the user's is one workspace per folder and is never deleted", async () => {
    d = await createTestDaemon();
    const dir = mkdtempSync(join(tmpdir(), 'acc-userdir-'));
    try {
      const manager = d.ctx.service('workspaceManager');
      const a = manager.ensureDirectory({ path: dir, projectId: null, actor: HUMAN });
      const b = manager.ensureDirectory({ path: `${dir}/`, projectId: null, actor: HUMAN });
      expect(b.id).toBe(a.id);
      expect(a).toMatchObject({ kind: 'directory', status: 'ready', branch: null });
      await d.call(HUMAN, 'workspace.remove', { workspaceId: a.id });
      expect(existsSync(dir)).toBe(true);
      expect(d.ctx.repos.workspaces.require(a.id).status).toBe('removed');
      expect(() => checkFolder('relative', d!.home)).toThrow(/絶対パス/);
      expect(() => checkFolder(join(dir, 'missing'), d!.home)).toThrow(/見つかりません/);
      expect(() => checkFolder(d!.home, d!.home)).toThrow(/データフォルダ/);
      expect(() => checkFolder(join(d!.home, '..'), d!.home)).toThrow(/データフォルダ/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
