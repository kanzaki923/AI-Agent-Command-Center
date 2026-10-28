import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Integration, Project, Task, Workspace } from '@acc/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { modules as defaultModules } from '../modules';
import { HUMAN, type TestDaemonNoServer, agentActor, createTestDaemon } from '../testing';
import { gitOut } from '../workspace/git';
import { type TempRepo, createTempRepo, isolateGitConfig } from '../workspace/git-fixture';
import { commandEnv, runShellCommand } from './command';
import { type IntegrationOptions, createIntegrationModule } from './index';

// Real git + child processes on Windows are slow; leave headroom under parallel load.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const PASS = 'node -e "process.exit(0)"';
const FAIL = `node -e "console.log('boom-output'); process.exit(3)"`;

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

interface Setup {
  d: TestDaemonNoServer;
  repo: TempRepo;
  project: Project;
}

async function setup(
  opts: {
    testCommand?: string;
    files?: Record<string, string>;
    integration?: Partial<IntegrationOptions>;
  } = {},
): Promise<Setup> {
  repo = await createTempRepo({ 'a.txt': 'a\n', 'shared.txt': 'base\n', ...opts.files });
  const modules = opts.integration
    ? defaultModules.map((m) =>
        m.name === 'integration' ? createIntegrationModule(opts.integration) : m,
      )
    : undefined;
  d = await createTestDaemon(modules ? { modules } : {});
  const project = await d.call(HUMAN, 'project.create', {
    name: 'demo',
    repoPath: repo.path,
    defaultBranch: 'main',
    testCommand: opts.testCommand ?? PASS,
  });
  return { d, repo, project };
}

/** A worktree with one commit writing `files`. */
async function workOn(s: Setup, files: Record<string, string>, label = 'work'): Promise<Workspace> {
  const ws = await s.d.call(HUMAN, 'workspace.create', { projectId: s.project.id, label });
  for (const [f, c] of Object.entries(files)) s.repo.write(f, c, ws.path);
  await s.d.ctx.service('workspaces').commitAll(ws.id, `Work on ${label}`, HUMAN);
  return ws;
}

async function runToEnd(s: Setup, integrationId: string): Promise<Integration> {
  const started = await s.d.call(HUMAN, 'integration.run', { integrationId });
  expect(started.status).toBe('running');
  return s.d.ctx.service('integrations').settled(integrationId);
}

function insertTask(s: Setup, title: string, workspaceId: string | null): Task {
  const now = s.d.ctx.clock.iso();
  return s.d.ctx.repos.tasks.insert({
    id: s.d.ctx.ids.next('task'),
    projectId: s.project.id,
    parentTaskId: null,
    title,
    description: '',
    acceptanceCriteria: [],
    status: 'review',
    priority: 'normal',
    dependsOn: [],
    assigneeSessionId: null,
    workspaceId,
    resultSummary: null,
    createdBy: HUMAN,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  });
}

function statusesOf(s: Setup, integrationId: string): string[] {
  const out: string[] = [];
  for (const e of s.d.ctx.bus.list({ types: ['integration.*'], limit: 1000 }).events) {
    if (e.type !== 'integration.created' && e.type !== 'integration.updated') continue;
    const i = e.payload.integration;
    if (i.id === integrationId && out.at(-1) !== i.status) out.push(i.status);
  }
  return out;
}

describe('integration', () => {
  it('merges two branches in order, runs the tests and fast-forwards main on approval', async () => {
    const s = await setup();
    const ws1 = await workOn(s, { 'a.txt': 'a changed\n' }, 'api');
    const ws2 = await workOn(s, { 'c.txt': 'new file\n' }, 'ui');

    const created = await s.d.call(HUMAN, 'integration.create', {
      projectId: s.project.id,
      workspaceIds: [ws1.id, ws2.id],
    });
    expect(created).toMatchObject({
      status: 'pending',
      targetRef: 'main',
      workspaceIds: [ws1.id, ws2.id],
    });
    expect(created.branch).toMatch(/^acc\/integration-[0-9a-z]{8}$/);
    expect(created.steps.map((st) => [st.kind, st.status])).toEqual([
      ['merge', 'pending'],
      ['merge', 'pending'],
      ['verify', 'pending'],
      ['apply', 'pending'],
    ]);
    const intWs = s.d.ctx.repos.workspaces.require(created.workspaceId!);
    expect(intWs.path).toBe(join(s.d.home, 'worktrees', s.project.id, intWs.id));

    const done = await runToEnd(s, created.id);
    expect(done.status).toBe('awaiting_approval');
    expect(done.error).toBeNull();
    expect(done.steps.map((st) => st.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'pending',
    ]);
    expect(done.steps[0]!.branch).toBe(ws1.branch);
    expect(done.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(statusesOf(s, created.id)).toEqual([
      'pending',
      'running',
      'verifying',
      'awaiting_approval',
    ]);

    // Merge commits (--no-ff) in order, with the daemon identity.
    const log = await gitOut(intWs.path, ['log', '--format=%s|%an', '--first-parent', '-3']);
    expect(log.split('\n')).toEqual([
      `Merge ${ws2.branch} into ${created.branch}|AI Agent Command Center`,
      `Merge ${ws1.branch} into ${created.branch}|AI Agent Command Center`,
      'initial|Test User',
    ]);

    const testArtifact = await s.d.call(HUMAN, 'artifact.get', {
      artifactId: done.steps[2]!.artifactId!,
    });
    expect(testArtifact).toMatchObject({
      kind: 'test_result',
      projectId: s.project.id,
      workspaceId: intWs.id,
      data: { command: PASS, passed: true, exitCode: 0 },
    });
    const byWs = await s.d.call(HUMAN, 'artifact.list', { workspaceId: intWs.id });
    expect(byWs.items.map((a) => a.kind).sort()).toEqual(['diff', 'test_result']);
    const diffArt = byWs.items.find((a) => a.kind === 'diff');
    expect(diffArt?.kind === 'diff' && diffArt.data.files.map((f) => f.path).sort()).toEqual([
      'a.txt',
      'c.txt',
    ]);

    // main is checked out in the repo with a clean tree → merge --ff-only there.
    const applied = await s.d.call(HUMAN, 'integration.approve', {
      integrationId: created.id,
      note: 'LGTM',
    });
    expect(applied).toMatchObject({ status: 'applied', decidedBy: HUMAN, decisionNote: 'LGTM' });
    expect(applied.steps[3]).toMatchObject({ kind: 'apply', status: 'succeeded' });
    expect(await s.repo.git('rev-parse', 'main')).toBe(done.headSha);
    expect(readFileSync(join(s.repo.path, 'c.txt'), 'utf8')).toBe('new file\n');
    expect(readFileSync(join(s.repo.path, 'a.txt'), 'utf8')).toBe('a changed\n');

    // Source worktrees and branches are untouched.
    expect(existsSync(ws1.path)).toBe(true);
    expect(await s.repo.git('branch', '--list', ws1.branch!)).toContain(ws1.branch);
  });

  it('resolves task ids to their workspaces and names the integration after them', async () => {
    const s = await setup();
    const ws1 = await workOn(s, { 'x.txt': 'x\n' });
    const ws2 = await workOn(s, { 'y.txt': 'y\n' });
    const t1 = insertTask(s, 'API を追加', ws1.id);
    const t2 = insertTask(s, 'UI を追加', ws2.id);
    const integ = await s.d.call(HUMAN, 'integration.create', {
      projectId: s.project.id,
      taskIds: [t2.id, t1.id],
    });
    expect(integ.taskIds).toEqual([t2.id, t1.id]);
    expect(integ.workspaceIds).toEqual([ws2.id, ws1.id]);
    expect(integ.title).toBe('統合: UI を追加、API を追加 → main');
    expect(integ.steps[0]).toMatchObject({ taskId: t2.id, title: '「UI を追加」をマージ' });

    const noWs = insertTask(s, 'まだ', null);
    await expect(
      s.d.call(HUMAN, 'integration.create', { projectId: s.project.id, taskIds: [noWs.id] }),
    ).rejects.toMatchObject({
      code: 'invalid_params',
      message: expect.stringContaining('ワークスペースがありません') as unknown,
    });
    await expect(
      s.d.call(HUMAN, 'integration.create', {
        projectId: s.project.id,
        taskIds: [t1.id],
        workspaceIds: [ws1.id],
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(
      s.d.call(HUMAN, 'integration.create', { projectId: s.project.id }),
    ).rejects.toMatchObject({
      code: 'invalid_params',
    });
    await expect(
      s.d.call(HUMAN, 'integration.create', {
        projectId: s.project.id,
        workspaceIds: [ws1.id],
        targetRef: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('stops at a conflict, aborts the merge cleanly and loses nothing', async () => {
    const s = await setup();
    const ws1 = await workOn(s, { 'shared.txt': 'from one\n' }, 'one');
    const ws2 = await workOn(s, { 'shared.txt': 'from two\n' }, 'two');
    const integ = await s.d.call(HUMAN, 'integration.create', {
      projectId: s.project.id,
      workspaceIds: [ws1.id, ws2.id],
    });
    const done = await runToEnd(s, integ.id);
    expect(done.status).toBe('conflict');
    expect(done.error).toMatchObject({ code: 'merge_conflict' });
    expect(done.steps.map((st) => st.status)).toEqual([
      'succeeded',
      'failed',
      'skipped',
      'skipped',
    ]);
    expect(done.steps[1]!.conflictFiles).toEqual(['shared.txt']);
    expect(done.steps[1]!.detail).toContain('コンフリクト');

    const intWs = s.d.ctx.repos.workspaces.require(integ.workspaceId!);
    expect(await gitOut(intWs.path, ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(intWs.path, '.git'))).toBe(true);
    expect(readFileSync(join(intWs.path, 'shared.txt'), 'utf8')).toBe('from one\n');
    expect(await gitOut(ws2.path, ['show', 'HEAD:shared.txt'])).toBe('from two');
    expect(await s.repo.git('rev-parse', 'main')).toBe(integ.baseSha);
    // No test artifact: verification never ran.
    expect((await s.d.call(HUMAN, 'artifact.list', { kind: 'test_result' })).items).toHaveLength(0);
    await expect(
      s.d.call(HUMAN, 'integration.approve', { integrationId: integ.id }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('fails when the tests fail, keeps the output tail, and can be re-run', async () => {
    const s = await setup({ testCommand: FAIL });
    const ws = await workOn(s, { 'b.txt': 'b\n' });
    const integ = await s.d.call(HUMAN, 'integration.create', {
      projectId: s.project.id,
      workspaceIds: [ws.id],
    });
    const failed = await runToEnd(s, integ.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ code: 'tests_failed' });
    expect(failed.steps.map((st) => st.status)).toEqual(['succeeded', 'failed', 'skipped']);
    const art = await s.d.call(HUMAN, 'artifact.get', { artifactId: failed.steps[1]!.artifactId! });
    expect(art.kind === 'test_result' && art.data).toMatchObject({ passed: false, exitCode: 3 });
    expect(art.kind === 'test_result' && art.data.output).toContain('boom-output');

    await s.d.call(HUMAN, 'project.update', { projectId: s.project.id, testCommand: PASS });
    const ok = await runToEnd(s, integ.id);
    expect(ok.status).toBe('awaiting_approval');
    expect(ok.steps[1]).toMatchObject({ status: 'succeeded', title: `テストを実行（${PASS}）` });
  });

  it('kills a test command that exceeds the timeout', async () => {
    const s = await setup({
      testCommand: 'node -e "setTimeout(() => {}, 60000)"',
      integration: { testTimeoutMs: 1500 },
    });
    const ws = await workOn(s, { 'b.txt': 'b\n' });
    const integ = await s.d.call(HUMAN, 'integration.create', {
      projectId: s.project.id,
      workspaceIds: [ws.id],
    });
    const started = Date.now();
    const done = await runToEnd(s, integ.id);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(done.status).toBe('failed');
    expect(done.error).toMatchObject({ code: 'tests_timed_out' });
  });

  it('skips verification when the project has no test command', async () => {
    const s = await setup();
    await s.d.call(HUMAN, 'project.update', { projectId: s.project.id, testCommand: null });
    const ws = await workOn(s, { 'b.txt': 'b\n' });
    const integ = await s.d.call(HUMAN, 'integration.create', {
      projectId: s.project.id,
      workspaceIds: [ws.id],
    });
    const done = await runToEnd(s, integ.id);
    expect(done.status).toBe('awaiting_approval');
    expect(done.steps[1]).toMatchObject({ kind: 'verify', status: 'skipped' });
  });

  it('refuses to apply onto a dirty checkout of the target, then applies once it is clean', async () => {
    const s = await setup();
    const ws = await workOn(s, { 'c.txt': 'c\n' });
    const integ = await s.d.call(HUMAN, 'integration.create', {
      projectId: s.project.id,
      workspaceIds: [ws.id],
    });
    const ready = await runToEnd(s, integ.id);
    const before = await s.repo.git('rev-parse', 'main');

    s.repo.write('a.txt', 'local edit\n');
    await expect(
      s.d.call(HUMAN, 'integration.approve', { integrationId: integ.id }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('未コミットの変更') as unknown,
    });
    const after = await s.d.call(HUMAN, 'integration.get', { integrationId: integ.id });
    expect(after.status).toBe('awaiting_approval');
    expect(after.steps.at(-1)).toMatchObject({ status: 'failed' });
    expect(await s.repo.git('rev-parse', 'main')).toBe(before);
    expect(readFileSync(join(s.repo.path, 'a.txt'), 'utf8')).toBe('local edit\n');

    await s.repo.git('checkout', '--', 'a.txt');
    const applied = await s.d.call(HUMAN, 'integration.approve', { integrationId: integ.id });
    expect(applied.status).toBe('applied');
    expect(await s.repo.git('rev-parse', 'main')).toBe(ready.headSha);
  });

  it('moves the target ref with update-ref when it is not checked out, only as a fast-forward', async () => {
    const s = await setup();
    const ws = await workOn(s, { 'c.txt': 'c\n' });
    await s.repo.git('switch', '-q', '-c', 'elsewhere');
    const integ = await s.d.call(HUMAN, 'integration.create', {
      projectId: s.project.id,
      workspaceIds: [ws.id],
    });
    const ready = await runToEnd(s, integ.id);

    // main moves on after verification → no longer a fast-forward → refused.
    await s.repo.git('switch', '-q', 'main');
    s.repo.write('late.txt', 'late\n');
    const moved = await s.repo.commit('late change');
    await s.repo.git('switch', '-q', 'elsewhere');
    await expect(
      s.d.call(HUMAN, 'integration.approve', { integrationId: integ.id }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('早送り') as unknown,
    });
    expect(await s.repo.git('rev-parse', 'main')).toBe(moved);

    // Re-running picks up the new tip; approval then fast-forwards the (not checked out) ref.
    const rerun = await runToEnd(s, integ.id);
    expect(rerun.status).toBe('awaiting_approval');
    expect(rerun.headSha).not.toBe(ready.headSha);
    const applied = await s.d.call(HUMAN, 'integration.approve', { integrationId: integ.id });
    expect(applied.status).toBe('applied');
    expect(await s.repo.git('rev-parse', 'main')).toBe(rerun.headSha);
    expect(await s.repo.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('elsewhere');
    expect(await s.repo.git('status', '--porcelain')).toBe('');
  });

  it('never lets an agent approve, even with a "*" grant', async () => {
    const s = await setup();
    const ws = await workOn(s, { 'c.txt': 'c\n' });
    const integ = await s.d.call(HUMAN, 'integration.create', {
      projectId: s.project.id,
      workspaceIds: [ws.id],
    });
    await runToEnd(s, integ.id);

    const run = s.d.ctx.ids.next('run');
    const agent = agentActor(s.d.ctx.ids.next('session'), run);
    await expect(
      s.d.call(agent, 'integration.approve', { integrationId: integ.id }),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
    s.d.ctx.repos.grants.insert({
      id: s.d.ctx.ids.next('grant'),
      subject: { kind: 'run', runId: run },
      parentGrantId: null,
      permissions: ['*'],
      scope: {},
      limits: {},
      depth: 0,
      lifetime: 'run',
      expiresAt: null,
      revokedAt: null,
      reason: null,
      grantedBy: HUMAN,
      createdAt: s.d.ctx.clock.iso(),
    });
    expect((await s.d.call(agent, 'integration.get', { integrationId: integ.id })).status).toBe(
      'awaiting_approval',
    );
    await expect(
      s.d.call(agent, 'integration.approve', { integrationId: integ.id }),
    ).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('人間の承認') as unknown,
    });
    await expect(
      s.d.ctx.service('integrations').approve(integ.id, { kind: 'system', component: 'test' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect((await s.d.call(HUMAN, 'integration.get', { integrationId: integ.id })).status).toBe(
      'awaiting_approval',
    );
    expect(await s.repo.git('rev-parse', 'main')).toBe(integ.baseSha);
  });

  it('rejects without deleting anything and refuses further runs', async () => {
    const s = await setup();
    const ws = await workOn(s, { 'c.txt': 'c\n' });
    const integ = await s.d.call(HUMAN, 'integration.create', {
      projectId: s.project.id,
      workspaceIds: [ws.id],
    });
    await runToEnd(s, integ.id);
    const rejected = await s.d.call(HUMAN, 'integration.reject', {
      integrationId: integ.id,
      note: '方針変更',
    });
    expect(rejected).toMatchObject({
      status: 'rejected',
      decidedBy: HUMAN,
      decisionNote: '方針変更',
    });
    expect(rejected.steps.at(-1)).toMatchObject({ status: 'skipped' });
    expect(await s.repo.git('branch', '--list', rejected.branch!)).toContain(rejected.branch);
    expect(existsSync(ws.path)).toBe(true);
    await expect(
      s.d.call(HUMAN, 'integration.run', { integrationId: integ.id }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      s.d.call(HUMAN, 'integration.reject', { integrationId: integ.id }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    const list = await s.d.call(HUMAN, 'integration.list', {
      projectId: s.project.id,
      status: ['rejected'],
    });
    expect(list.items.map((i) => i.id)).toEqual([integ.id]);
  });

  it('serializes integrations of the same project', async () => {
    const s = await setup({ testCommand: 'node -e "setTimeout(() => process.exit(0), 300)"' });
    const ws1 = await workOn(s, { 'x.txt': 'x\n' });
    const ws2 = await workOn(s, { 'y.txt': 'y\n' });
    const a = await s.d.call(HUMAN, 'integration.create', {
      projectId: s.project.id,
      workspaceIds: [ws1.id],
    });
    const b = await s.d.call(HUMAN, 'integration.create', {
      projectId: s.project.id,
      workspaceIds: [ws2.id],
    });
    await s.d.call(HUMAN, 'integration.run', { integrationId: a.id });
    await s.d.call(HUMAN, 'integration.run', { integrationId: b.id });
    await expect(s.d.call(HUMAN, 'integration.run', { integrationId: a.id })).rejects.toMatchObject(
      {
        code: 'conflict',
      },
    );
    const svc = s.d.ctx.service('integrations');
    expect((await svc.settled(a.id)).status).toBe('awaiting_approval');
    expect((await svc.settled(b.id)).status).toBe('awaiting_approval');

    const events = s.d.ctx.bus.list({ types: ['integration.updated'], limit: 1000 }).events;
    const seqOf = (pred: (i: Integration) => boolean) =>
      events
        .filter((e) => e.type === 'integration.updated' && pred(e.payload.integration))
        .map((e) => e.seq);
    const aDone = Math.min(...seqOf((i) => i.id === a.id && i.status === 'awaiting_approval'));
    const bFirstStep = Math.min(
      ...seqOf((i) => i.id === b.id && i.steps.some((st) => st.status !== 'pending')),
    );
    expect(bFirstStep).toBeGreaterThan(aDone);
  });

  it('marks attempts cut off by a restart as failed', async () => {
    const s = await setup();
    const ws = await workOn(s, { 'c.txt': 'c\n' });
    const integ = await s.d.call(HUMAN, 'integration.create', {
      projectId: s.project.id,
      workspaceIds: [ws.id],
    });
    // Simulate a crash mid-run.
    s.d.ctx.repos.integrations.update(integ.id, (i) => ({
      ...i,
      status: 'verifying',
      steps: i.steps.map((st, idx) =>
        idx === 0 ? { ...st, status: 'succeeded' } : idx === 1 ? { ...st, status: 'running' } : st,
      ),
    }));
    const home = s.d.home;
    await s.d.close();
    const second = await createTestDaemon({ home });
    try {
      const after = await second.call(HUMAN, 'integration.get', { integrationId: integ.id });
      expect(after.status).toBe('failed');
      expect(after.error).toMatchObject({ code: 'daemon_restart' });
      expect(after.steps.map((st) => st.status)).toEqual(['succeeded', 'failed', 'skipped']);
    } finally {
      await second.close();
    }
  });
});

describe('runShellCommand', () => {
  it('keeps only the tail of large output', async () => {
    const res = await runShellCommand(
      `node -e "for (let i = 0; i < 5000; i++) console.log('line ' + i)"`,
      { cwd: process.cwd(), timeoutMs: 30_000, maxOutputBytes: 1024 },
    );
    expect(res.exitCode).toBe(0);
    expect(res.outputTruncated).toBe(true);
    expect(res.output.length).toBeLessThanOrEqual(1024);
    expect(res.output).toContain('line 4999');
    expect(res.output).not.toContain('line 0\n');
  });

  it('strips ACC_* variables and sets CI for project commands', () => {
    const env = commandEnv({ PATH: '/bin', ACC_LITELLM_API_KEY: 'secret', acc_home: 'x' });
    expect(env).toEqual({ PATH: '/bin', CI: 'true' });
  });
});
