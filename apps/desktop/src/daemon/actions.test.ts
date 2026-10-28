import { AccClientError } from '@acc/client';
import { describe, expect, it } from 'vitest';
import { createFakeClient } from '../test/fakeClient';
import { id, run, session } from '../test/fixtures';
import { makeOrchestrator, retryRun, runTask, sendMessage, setSessionModel } from './actions';
import { qk } from './keys';
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

describe('sendMessage', () => {
  it('loads the history of a chat that was never opened before adding the message', async () => {
    const s = session({ kind: 'chat' });
    const older = {
      id: id('msg'),
      sessionId: s.id,
      role: 'user' as const,
      content: [{ type: 'text' as const, text: '前の話' }],
      author: { kind: 'human' as const, client: 'test' },
      runId: null,
      model: null,
      createdAt: new Date(0).toISOString(),
    };
    const fake = createFakeClient({
      'session.messages': () => ({ items: [older], hasMore: false }),
      'session.send': () => ({ messageId: id('msg'), runId: id('run') }),
    });
    const rt = createRuntime(fake.client);
    expect(await sendMessage(rt, s.id, 'つづき')).toBe(true);
    const cached = rt.queryClient.getQueryData<{ id: string }[]>(qk.messages(s.id)) ?? [];
    expect(cached.map((m) => m.id)[0]).toBe(older.id);
    expect(cached).toHaveLength(2);
    expect(fake.calls.map((c) => c.method)).toEqual(['session.messages', 'session.send']);
  });
});

describe('setSessionModel', () => {
  it('shows the new model at once and puts the old one back when the daemon refuses', async () => {
    const s = session({ model: 'gpt-old' });
    const fake = createFakeClient({
      'session.update': () => {
        throw new AccClientError('invalid_params', 'unknown model');
      },
    });
    const rt = createRuntime(fake.client);
    rt.queryClient.setQueryData(qk.sessions, [s]);
    const pending = setSessionModel(rt, s, 'gpt-new');
    expect(rt.queryClient.getQueryData<{ model: string }[]>(qk.sessions)?.[0]?.model).toBe('gpt-new');
    await pending;
    expect(rt.queryClient.getQueryData<{ model: string }[]>(qk.sessions)?.[0]?.model).toBe('gpt-old');
  });
});
