/**
 * Daemon restart resilience (concept §8.4): a restart in the middle of an orchestration
 * leaves interrupted workers' tasks ready to resume on their worktree, tells the
 * orchestrator session what happened, and (by default) resumes the orchestrator, which
 * continues the plan from the persisted task states.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Approval, Run } from '@acc/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentRunInput } from '../contracts';
import { textOfParts } from '../llm/messages';
import { MockAgentRuntime } from '../runtime/mock/runtime';
import { HUMAN, type TestDaemon, startTestDaemon } from '../testing';
import { type TempRepo, createTempRepo, isolateGitConfig } from '../workspace/git-fixture';
import { ORCHESTRATOR_RESUME_NOTICE } from './executor';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const GOAL = '認証まわりのドキュメントとテストを並列で整備して';

let restoreGit: () => void;
beforeAll(() => {
  restoreGit = isolateGitConfig();
});
afterAll(() => restoreGit());

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 60_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A daemon on `home` whose mock agent has no pauses. */
async function boot(home: string): Promise<TestDaemon> {
  const d = await startTestDaemon({ home });
  d.ctx.service('llm').mock.chunkDelayMs = 0;
  const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
  vi.spyOn(d.ctx.service('runtimes').get('mock'), 'run').mockImplementation(
    (input: AgentRunInput) => fast.run(input),
  );
  return d;
}

const pending = (d: TestDaemon): Approval | undefined =>
  d.ctx.repos.approvals.find({ where: { status: 'pending' } })[0];

/**
 * Start an orchestration and stop the daemon while the test worker waits for approval of
 * its command (the docs worker already finished) and the orchestrator waits on task.wait.
 */
async function interruptedOrchestration(opts: { autoResume?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'acc-resume-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const repo: TempRepo = await createTempRepo({
    'test/basic.test.js': "require('node:test')('basic', () => {});\n",
  });
  cleanups.push(() => repo.cleanup());

  const d1 = await boot(home);
  let d1Closed = false;
  cleanups.push(() => (d1Closed ? undefined : d1.close()));
  const project = await d1.call(HUMAN, 'project.create', {
    name: 'auth-service',
    repoPath: repo.path,
    defaultBranch: 'main',
    testCommand: 'node --test',
  });
  const chat = await d1.call(HUMAN, 'session.create', {
    projectId: project.id,
    model: 'mock/orchestrator',
  });
  await d1.call(HUMAN, 'session.grantOrchestration', { sessionId: chat.id, lifetime: 'session' });
  if (opts.autoResume === false) {
    await d1.call(HUMAN, 'settings.update', { autoResumeOrchestrators: false });
  }
  const { runId: orchRunId } = await d1.call(HUMAN, 'session.send', {
    sessionId: chat.id,
    content: GOAL,
  });
  const approval = await until(() => pending(d1));
  const testTaskId = approval.taskId!;
  await until(() => {
    const tasks = d1.ctx.repos.tasks.find({ where: { project_id: project.id } });
    return tasks.length === 2 && tasks.some((t) => t.status === 'review');
  });
  await until(() =>
    d1.ctx.bus
      .list({ types: ['tool.called'], limit: 1000 })
      .events.some((e) => e.type === 'tool.called' && e.payload.name === 'task.wait'),
  );
  const workerRunId = approval.runId!;
  await d1.close();
  d1Closed = true;
  return { home, project, chatId: chat.id, orchRunId, testTaskId, workerRunId };
}

describe('daemon restart in the middle of an orchestration', () => {
  it('resumes the orchestrator, which resumes the interrupted worker on its worktree and finishes the plan', async () => {
    const o = await interruptedOrchestration();

    const d2 = await boot(o.home);
    cleanups.push(() => d2.close());
    // The interrupted worker's task waits to be resumed (not failed), worktree and branch kept.
    const testTask = d2.ctx.repos.tasks.require(o.testTaskId);
    expect(testTask).toMatchObject({ status: 'ready', statusReason: 'interrupted' });
    expect(d2.ctx.repos.runs.require(o.workerRunId).status).toBe('interrupted');
    expect(d2.ctx.repos.runs.require(o.orchRunId)).toMatchObject({
      status: 'interrupted',
      statusReason: 'daemon_shutdown',
    });

    // A notice in the orchestrator chat, then a new orchestrator run.
    const resumed = await until(() =>
      d2.ctx.repos.runs
        .find({ where: { session_id: o.chatId, kind: 'orchestrator' } })
        .find((r) => r.id !== o.orchRunId),
    );
    const notice = d2.ctx.repos.messages.require(resumed.triggerMessageId!);
    expect(notice.role).toBe('system');
    const noticeText = textOfParts(notice.content);
    expect(noticeText.startsWith(ORCHESTRATOR_RESUME_NOTICE)).toBe(true);
    expect(noticeText).toContain(o.orchRunId);
    expect(noticeText).toContain(o.testTaskId);

    // It reads the task states and resumes the interrupted task with task.retry: the same
    // worker session and worktree, so its command asks for approval again.
    const approval = await until(() => pending(d2));
    expect(approval.taskId).toBe(o.testTaskId);
    const retryRun = d2.ctx.repos.runs.require(approval.runId!);
    expect(retryRun).toMatchObject({
      sessionId: testTask.assigneeSessionId,
      workspaceId: testTask.workspaceId,
      retryOfRunId: o.workerRunId,
      parentRunId: resumed.id,
    });
    await d2.call(HUMAN, 'approval.respond', { approvalId: approval.id, decision: 'approve' });

    const end: Run = await d2.ctx.service('runs').waitForEnd(resumed.id);
    expect(end.status).toBe('completed');
    const integ = (await d2.call(HUMAN, 'integration.list', { projectId: o.project.id })).items[0];
    expect(integ?.status).toBe('awaiting_approval');
    const msgs = await d2.call(HUMAN, 'session.messages', { sessionId: o.chatId });
    const report = msgs.items.filter((m) => m.role === 'assistant').at(-1)!;
    expect(textOfParts(report.content)).toContain('2件のTaskが完了し、統合候補ができました');
    // The docs worker was not re-run.
    const docTask = d2.ctx.repos.tasks
      .find({ where: { project_id: o.project.id } })
      .find((t) => t.id !== o.testTaskId)!;
    expect(d2.ctx.repos.runs.count({ where: { task_id: docTask.id } })).toBe(1);

    // Handled once: another restart does not notify or resume again.
    await d2.close();
    const d3 = await boot(o.home);
    cleanups.push(() => d3.close());
    await new Promise((r) => setTimeout(r, 50));
    expect(d3.ctx.repos.runs.count({ where: { session_id: o.chatId, kind: 'orchestrator' } })).toBe(
      2,
    );
  });

  it('with autoResumeOrchestrators off it only posts the notice; a human resumes the task with task.retry', async () => {
    const o = await interruptedOrchestration({ autoResume: false });
    const d2 = await boot(o.home);
    cleanups.push(() => d2.close());

    const notice = await until(() =>
      d2.ctx.repos.messages
        .find({ where: { session_id: o.chatId } })
        .find((m) => m.role === 'system'),
    );
    expect(textOfParts(notice.content)).toContain('自動では再開しません');
    expect(d2.ctx.repos.runs.count({ where: { session_id: o.chatId, kind: 'orchestrator' } })).toBe(
      1,
    );

    const r = await d2.call(HUMAN, 'task.retry', { taskId: o.testTaskId });
    const approval = await until(() => pending(d2));
    expect(approval.runId).toBe(r.runId);
    await d2.call(HUMAN, 'approval.respond', { approvalId: approval.id, decision: 'approve' });
    await d2.ctx.service('runs').waitForEnd(r.runId);
    expect(d2.ctx.repos.tasks.require(o.testTaskId).status).toBe('review');
  });
});
