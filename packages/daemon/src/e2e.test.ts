/**
 * Cross-module flow with every real module (no fakes): the seams between runs, runtime,
 * workspace, integration, tasks and policy that unit tests of each module cannot see.
 */
import type { Run } from '@acc/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockAgentRuntime } from './runtime/mock/runtime';
import { HUMAN, type TestDaemonNoServer, createTestDaemon } from './testing';
import { type TempRepo, createTempRepo, isolateGitConfig } from './workspace/git-fixture';

// Real git + child processes on Windows are slow; leave headroom under parallel load.
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

async function setup() {
  repo = await createTempRepo();
  d = await createTestDaemon();
  // The offline mock runtime without its human-like pauses.
  const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
  vi.spyOn(d.ctx.service('runtimes').get('mock'), 'run').mockImplementation((input) =>
    fast.run(input),
  );
  const project = await d.call(HUMAN, 'project.create', {
    name: 'demo',
    repoPath: repo.path,
    defaultBranch: 'main',
    testCommand: 'node -e "process.exit(0)"',
  });
  return { d, repo, project };
}

async function agentOnTask(daemon: TestDaemonNoServer, projectId: string, title: string) {
  const task = await daemon.call(HUMAN, 'task.create', { projectId, title });
  const ws = await daemon.call(HUMAN, 'workspace.create', { projectId, taskId: task.id });
  const session = await daemon.call(HUMAN, 'session.create', {
    projectId,
    kind: 'agent',
    runtime: 'mock',
    workspaceId: ws.id,
    taskId: task.id,
  });
  return { task, ws, session };
}

describe('vertical slice', () => {
  it('agent run on a worktree → commit + diff artifact → integration → applied to main', async () => {
    const { d, repo, project } = await setup();
    const { task, ws, session } = await agentOnTask(d, project.id, 'Write notes');

    const { runId } = await d.call(HUMAN, 'session.send', {
      sessionId: session.id,
      content: 'ノートを書いて',
    });
    const run: Run = await d.ctx.service('runs').waitForEnd(runId!);
    expect(run).toMatchObject({ status: 'completed', workspaceId: ws.id, taskId: task.id });
    expect(d.ctx.service('workspaces').isLocked(ws.id)).toBe(false);

    // The executor committed and recorded the diff through the artifacts service.
    const branchLog = await repo.git('log', '--format=%s', `main..${ws.branch}`);
    expect(branchLog).toBe('Write notes');
    const arts = await d.call(HUMAN, 'artifact.list', { runId: runId! });
    expect(arts.items).toHaveLength(1);
    expect(arts.items[0]).toMatchObject({
      kind: 'diff',
      runId,
      taskId: task.id,
      workspaceId: ws.id,
      projectId: project.id,
    });

    await d.call(HUMAN, 'task.update', { taskId: task.id, status: 'review' });
    const integ = await d.call(HUMAN, 'integration.create', {
      projectId: project.id,
      taskIds: [task.id],
    });
    await d.call(HUMAN, 'integration.run', { integrationId: integ.id });
    const settled = await d.ctx.service('integrations').settled(integ.id);
    expect(settled.status).toBe('awaiting_approval');
    const applied = await d.call(HUMAN, 'integration.approve', { integrationId: integ.id });
    expect(applied.status).toBe('applied');
    expect(await repo.git('ls-tree', '-r', '--name-only', 'main')).toContain(
      'notes/write-notes.md',
    );
  });

  it('task.cancel stops the active agent run and frees its workspace lock', async () => {
    const { d, project } = await setup();
    const { task, ws, session } = await agentOnTask(d, project.id, 'Long job');
    const plan = [
      '```acc-mock',
      JSON.stringify({ steps: [{ type: 'sleep', ms: 60_000 }], delayScale: 1 }),
      '```',
    ].join('\n');
    const { runId } = await d.call(HUMAN, 'session.send', { sessionId: session.id, content: plan });
    const runs = d.ctx.service('runs');
    for (let i = 0; i < 400 && d.ctx.repos.runs.require(runId!).status !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(d.ctx.service('workspaces').isLocked(ws.id)).toBe(true);

    await d.call(HUMAN, 'task.cancel', { taskId: task.id });
    await expect(runs.waitForEnd(runId!)).resolves.toMatchObject({
      status: 'cancelled',
      statusReason: 'task_cancelled',
    });
    for (let i = 0; i < 400 && d.ctx.service('workspaces').isLocked(ws.id); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(d.ctx.service('workspaces').isLocked(ws.id)).toBe(false);
    expect(d.ctx.repos.sessions.require(session.id).activeRunId).toBeNull();
  });
});
