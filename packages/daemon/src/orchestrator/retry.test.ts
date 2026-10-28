/**
 * task.retry: send a task back to its original worker (same session, worktree and branch)
 * with feedback — here the tail of the integration tests that its change broke.
 */
import type { Project } from '@acc/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentRunInput } from '../contracts';
import { ApiError } from '../core/errors';
import { textOfParts } from '../llm/messages';
import { MockAgentRuntime } from '../runtime/mock/runtime';
import { HUMAN, type TestDaemonNoServer, createTestDaemon } from '../testing';
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

/** Passes only once fixed.txt exists (prints a hint the worker gets back). */
const TEST_COMMAND = `node -e "console.log('needs fixed.txt'); process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1)"`;

const plan = (path: string) =>
  [
    '```acc-mock',
    JSON.stringify({ steps: [{ type: 'write', path, content: `${path}\n` }] }),
    '```',
  ].join('\n');

async function setup(): Promise<{ d: TestDaemonNoServer; project: Project }> {
  repo = await createTempRepo();
  d = await createTestDaemon();
  const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
  vi.spyOn(d.ctx.service('runtimes').get('mock'), 'run').mockImplementation(
    (input: AgentRunInput) => fast.run(input),
  );
  const project = await d.call(HUMAN, 'project.create', {
    name: 'demo',
    repoPath: repo.path,
    defaultBranch: 'main',
    testCommand: TEST_COMMAND,
  });
  return { d, project };
}

describe('task.retry', () => {
  it('re-runs the original worker on its worktree with the failing integration output, then the integration passes', async () => {
    const { d, project } = await setup();
    const task = await d.call(HUMAN, 'task.create', { projectId: project.id, title: 'API を直す' });
    const first = await d.call(HUMAN, 'task.spawnWorker', {
      taskId: task.id,
      instructions: plan('work.txt'),
    });
    await d.ctx.service('runs').waitForEnd(first.runId);
    expect(d.ctx.repos.tasks.require(task.id).status).toBe('review');

    const integ = await d.call(HUMAN, 'integration.create', {
      projectId: project.id,
      taskIds: [task.id],
    });
    await d.call(HUMAN, 'integration.run', { integrationId: integ.id });
    const failed = await d.ctx.service('integrations').settled(integ.id);
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'tests_failed' } });

    const retried = await d.call(HUMAN, 'task.retry', {
      taskId: task.id,
      feedback: `fixed.txt を追加してください。\n${plan('fixed.txt')}`,
      integrationId: integ.id,
    });
    // A running task cannot be sent back again.
    await expect(d.call(HUMAN, 'task.retry', { taskId: task.id })).rejects.toBeInstanceOf(ApiError);

    // Same worker session and worktree; a new attempt of the previous run.
    expect(retried).toMatchObject({ sessionId: first.sessionId, workspaceId: first.workspaceId });
    const run = d.ctx.repos.runs.require(retried.runId);
    expect(run).toMatchObject({ retryOfRunId: first.runId, attempt: 2, taskId: task.id });
    expect(d.ctx.repos.tasks.require(task.id).status).toBe('running');
    const trigger = textOfParts(d.ctx.repos.messages.require(run.triggerMessageId!).content);
    expect(trigger).toContain('差し戻し');
    expect(trigger).toContain('fixed.txt を追加してください');
    expect(trigger).toContain('needs fixed.txt'); // the test output tail
    expect(trigger).toContain(integ.id);

    await d.ctx.service('runs').waitForEnd(retried.runId);
    expect(d.ctx.repos.tasks.require(task.id).status).toBe('review');
    await d.call(HUMAN, 'integration.run', { integrationId: integ.id });
    expect((await d.ctx.service('integrations').settled(integ.id)).status).toBe(
      'awaiting_approval',
    );
  });

  it('starts a fresh worker for a task that never had one', async () => {
    const { d, project } = await setup();
    const task = await d.call(HUMAN, 'task.create', { projectId: project.id, title: '新しい作業' });
    const r = await d.call(HUMAN, 'task.retry', { taskId: task.id, feedback: plan('x.txt') });
    expect(d.ctx.repos.runs.require(r.runId)).toMatchObject({ attempt: 1, retryOfRunId: null });
    await d.ctx.service('runs').waitForEnd(r.runId);
    expect(d.ctx.repos.tasks.require(task.id).status).toBe('review');
  });
});
