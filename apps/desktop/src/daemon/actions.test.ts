import { AccClientError } from '@acc/client';
import { describe, expect, it } from 'vitest';
import { createFakeClient } from '../test/fakeClient';
import { id, run, session } from '../test/fixtures';
import { makeOrchestrator, retryRun, runTask } from './actions';
import { createRuntime } from './runtime';

describe('makeOrchestrator ("Orchestrator にする")', () => {
  it('grants the orchestrator preset for the next run of the chat', async () => {
    const fake = createFakeClient({ 'session.grantOrchestration': () => ({ grant: {}, budget: null }) });
    const s = session({ kind: 'chat', projectId: id('prj') });
    expect(await makeOrchestrator(createRuntime(fake.client), s)).toBe(true);
    expect(fake.calls).toEqual([
      { method: 'session.grantOrchestration', params: { sessionId: s.id, lifetime: 'run' } },
    ]);
  });
});

describe('runTask ("このTaskを実行")', () => {
  it('starts a worker through task.spawnWorker and returns its session', async () => {
    const sessionId = id('ses');
    const fake = createFakeClient({
      'task.spawnWorker': () => ({
        sessionId,
        runId: id('run'),
        workspaceId: id('wsp'),
        budgetId: null,
      }),
    });
    const taskId = id('tsk');
    expect(await runTask(createRuntime(fake.client), taskId)).toBe(sessionId);
    expect(fake.calls).toEqual([{ method: 'task.spawnWorker', params: { taskId } }]);
  });

  it('returns null (and toasts) when the daemon refuses', async () => {
    const fake = createFakeClient({
      'task.spawnWorker': () => {
        throw new AccClientError('conflict', 'すでに実行中です');
      },
    });
    expect(await runTask(createRuntime(fake.client), id('tsk'))).toBeNull();
  });
});

describe('retryRun ("再試行" / "再開")', () => {
  const ok = { sessionId: id('ses'), runId: id('run'), workspaceId: id('wsp'), budgetId: null };

  it("resumes a worker's run through its task, so the task follows the new run", async () => {
    const fake = createFakeClient({ 'task.retry': () => ok, 'run.retry': () => ({}) });
    const taskId = id('tsk');
    const worker = session({ kind: 'agent', taskId });
    await retryRun(createRuntime(fake.client), run(worker, { kind: 'agent', status: 'interrupted' }));
    expect(fake.calls).toEqual([{ method: 'task.retry', params: { taskId } }]);
  });

  it('retries other runs (chat, orchestrator, a task-less agent) with run.retry', async () => {
    const fake = createFakeClient({ 'run.retry': () => ({}) });
    const rt = createRuntime(fake.client);
    const chat = session({ kind: 'chat' });
    const r1 = run(chat, { kind: 'chat', status: 'failed' });
    const r2 = run(session({ kind: 'agent' }), { kind: 'agent', status: 'interrupted', taskId: null });
    await retryRun(rt, r1);
    await retryRun(rt, r2);
    expect(fake.calls).toEqual([
      { method: 'run.retry', params: { runId: r1.id } },
      { method: 'run.retry', params: { runId: r2.id } },
    ]);
  });
});
