/**
 * Integrator on conflict (concept §6.1 step 5): integration.resolveWithAgent re-creates the
 * conflicting merge, an agent resolves it in the integration worktree, and the integration
 * resumes (remaining merges + tests) — or returns to `conflict` with the reason.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Integration, Project, Workspace } from '@acc/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentRunInput } from '../contracts';
import { ApiError } from '../core/errors';
import { MockAgentRuntime } from '../runtime/mock/runtime';
import {
  HUMAN,
  type TestDaemonNoServer,
  agentActor,
  approveIntegrationTests,
  createTestDaemon,
} from '../testing';
import { gitOut, resolveCommit } from '../workspace/git';
import { type TempRepo, createTempRepo, isolateGitConfig } from '../workspace/git-fixture';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

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

async function setup(): Promise<Setup> {
  repo = await createTempRepo({ 'shared.txt': 'base\n' });
  d = await createTestDaemon();
  // The integrator's code is tested only once a human allows it.
  approveIntegrationTests(d.ctx);
  // The offline mock agent without its human-like pauses.
  const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
  vi.spyOn(d.ctx.service('runtimes').get('mock'), 'run').mockImplementation(
    (input: AgentRunInput) => fast.run(input),
  );
  const project = await d.call(HUMAN, 'project.create', {
    name: 'demo',
    repoPath: repo.path,
    defaultBranch: 'main',
    testCommand: 'node -e "process.exit(0)"',
  });
  return { d, repo, project };
}

async function workOn(s: Setup, files: Record<string, string>, label: string): Promise<Workspace> {
  const ws = await s.d.call(HUMAN, 'workspace.create', { projectId: s.project.id, label });
  for (const [f, c] of Object.entries(files)) s.repo.write(f, c, ws.path);
  await s.d.ctx.service('workspaces').commitAll(ws.id, `Work on ${label}`, HUMAN);
  return ws;
}

/** Two branches editing the same line of shared.txt, integrated until the conflict. */
async function conflicted(s: Setup): Promise<Integration> {
  const a = await workOn(s, { 'shared.txt': 'from api\n' }, 'api');
  const b = await workOn(s, { 'shared.txt': 'from ui\n', 'ui.txt': 'ui\n' }, 'ui');
  const integ = await s.d.call(HUMAN, 'integration.create', {
    projectId: s.project.id,
    workspaceIds: [a.id, b.id],
  });
  await s.d.call(HUMAN, 'integration.run', { integrationId: integ.id });
  const done = await s.d.ctx.service('integrations').settled(integ.id);
  expect(done.status).toBe('conflict');
  return done;
}

async function waitSettled(s: Setup, integrationId: string): Promise<Integration> {
  const r = await s.d.call(HUMAN, 'integration.wait', { integrationId, timeoutMs: 60_000 });
  expect(r.timedOut).toBe(false);
  return r.integration;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof ApiError ? err.code : String(err);
  }
}

describe('integration.resolveWithAgent', () => {
  it('an integrator agent resolves the conflict, commits the merge and the integration resumes to approval', async () => {
    const s = await setup();
    const integ = await conflicted(s);

    const r = await s.d.call(HUMAN, 'integration.resolveWithAgent', { integrationId: integ.id });
    expect(r.integration.status).toBe('running');
    expect(r.integration.resolverRunId).toBe(r.runId);
    expect(r.integration.steps.map((st) => st.kind)).toEqual([
      'merge',
      'merge',
      'fix',
      'verify',
      'apply',
    ]);
    const run = s.d.ctx.repos.runs.require(r.runId!);
    expect(run).toMatchObject({ kind: 'agent', workspaceId: integ.workspaceId, taskId: null });
    expect(s.d.ctx.repos.sessions.require(r.sessionId!).title).toContain('Integrator');

    const done = await waitSettled(s, integ.id);
    expect(done.status).toBe('awaiting_approval');
    expect(done.steps.map((st) => [st.kind, st.status])).toEqual([
      ['merge', 'succeeded'],
      ['merge', 'succeeded'],
      ['fix', 'succeeded'],
      ['verify', 'succeeded'],
      ['apply', 'pending'],
    ]);
    expect(done.steps[1]!.conflictFiles).toEqual(['shared.txt']);

    // The mock resolved ours + theirs; the merge commit has both branches as parents.
    const wsPath = s.d.ctx.repos.workspaces.require(integ.workspaceId!).path;
    expect(readFileSync(join(wsPath, 'shared.txt'), 'utf8')).toBe('from api\nfrom ui\n');
    const parents = (await gitOut(wsPath, ['log', '-1', '--format=%P'])).split(' ');
    expect(parents).toHaveLength(2);
    expect(await resolveCommit(wsPath, 'MERGE_HEAD')).toBeNull();

    // A fresh run starts over from main: the fix is dropped and the merge conflicts again.
    await s.d.call(HUMAN, 'integration.run', { integrationId: integ.id });
    const again = await s.d.ctx.service('integrations').settled(integ.id);
    expect(again.status).toBe('conflict');
    expect(again.steps.some((st) => st.kind === 'fix')).toBe(false);
  });

  it('an integrator that does not commit a resolution puts the integration back to conflict', async () => {
    const s = await setup();
    const integ = await conflicted(s);
    const wsPath = s.d.ctx.repos.workspaces.require(integ.workspaceId!).path;
    const before = await gitOut(wsPath, ['rev-parse', 'HEAD']);
    // An "agent" that leaves the conflict as it is.
    s.d.ctx.service('runs').registerExecutor('agent', async () => {});

    await s.d.call(HUMAN, 'integration.resolveWithAgent', { integrationId: integ.id });
    const done = await waitSettled(s, integ.id);
    expect(done.status).toBe('conflict');
    expect(done.error).toMatchObject({ code: 'resolution_failed' });
    expect(done.error!.message).toContain('マージがコミットされていません');
    expect(done.steps.find((st) => st.kind === 'fix')).toMatchObject({ status: 'failed' });
    // The re-created merge was aborted: nothing half-merged is left behind.
    expect(await resolveCommit(wsPath, 'MERGE_HEAD')).toBeNull();
    expect(await gitOut(wsPath, ['rev-parse', 'HEAD'])).toBe(before);
    expect(await gitOut(wsPath, ['status', '--porcelain'])).toBe('');
  });

  it('only integrations in conflict, and only agents allowed to start workers', async () => {
    const s = await setup();
    const a = await workOn(s, { 'a.txt': 'a\n' }, 'api');
    const integ = await s.d.call(HUMAN, 'integration.create', {
      projectId: s.project.id,
      workspaceIds: [a.id],
    });
    expect(
      await codeOf(s.d.call(HUMAN, 'integration.resolveWithAgent', { integrationId: integ.id })),
    ).toBe('conflict');

    const chat = await s.d.call(HUMAN, 'session.create', { projectId: s.project.id });
    const run = s.d.ctx.service('runs').start({
      sessionId: chat.id,
      kind: 'chat',
      createdBy: HUMAN,
    });
    expect(
      await codeOf(
        s.d.call(agentActor(chat.id, run.id), 'integration.resolveWithAgent', {
          integrationId: integ.id,
        }),
      ),
    ).toBe('forbidden');
  });
});
