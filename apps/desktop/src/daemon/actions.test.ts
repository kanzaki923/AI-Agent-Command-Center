import { AccClientError } from '@acc/client';
import { describe, expect, it } from 'vitest';
import { createFakeClient } from '../test/fakeClient';
import { id, run, session } from '../test/fixtures';
import {
  delegateSession,
  retryRun,
  sendMessage,
  setSessionModel,
  startConversation,
  stopTree,
  titleFromRequest,
} from './actions';
import { qk } from './keys';
import { createRuntime } from './runtime';

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

describe('session tree actions', () => {
  it('starts a conversation from its first message, delegated when asked', async () => {
    const s = session({ kind: 'chat' });
    const fake = createFakeClient({
      'session.create': () => s,
      'session.delegate': () => ({ grant: {}, budget: null }),
      'session.messages': () => ({ items: [], hasMore: false, streaming: null }),
      'session.send': () => ({ messageId: id('msg'), runId: id('run'), delivery: 'started' }),
    });
    const rt = createRuntime(fake.client);
    expect(await startConversation(rt, { text: '調べて', delegate: true })).toEqual(s);
    expect(fake.calls.map((c) => c.method)).toEqual(['session.create', 'session.delegate', 'session.send']);
    expect(fake.calls[0]!.params).toEqual({ kind: 'chat', title: '調べて' });
    expect(fake.calls[2]!.params).toMatchObject({ sessionId: s.id, content: '調べて' });
  });

  it('delegated with code chosen, it is a conversation in that project (its children get the code)', async () => {
    const s = session({ kind: 'chat' });
    const projectId = id('prj');
    const fake = createFakeClient({
      'session.create': () => s,
      'session.delegate': () => ({ grant: {}, budget: null }),
      'session.messages': () => ({ items: [], hasMore: false, streaming: null }),
      'session.send': () => ({ messageId: id('msg'), runId: id('run'), delivery: 'started' }),
    });
    const rt = createRuntime(fake.client);
    await startConversation(rt, {
      text: '直して',
      delegate: true,
      workspace: { kind: 'worktree', projectId },
    });
    expect(fake.calls.map((c) => c.method)).toEqual(['session.create', 'session.delegate', 'session.send']);
    expect(fake.calls[0]!.params).toEqual({ kind: 'chat', title: '直して', projectId });
  });

  it('names a conversation by the first line of what was asked, cut to 40 characters', () => {
    expect(titleFromRequest('  競合の価格を調べて\n詳しくは添付を見て ')).toBe('競合の価格を調べて');
    const long = 'あ'.repeat(60);
    expect(titleFromRequest(long)).toBe(`${'あ'.repeat(39)}…`);
    expect([...titleFromRequest(long)]).toHaveLength(40);
  });

  it('creates an agent with a workspace when one is chosen', async () => {
    const s = session({ kind: 'agent' });
    const fake = createFakeClient({
      'session.create': () => s,
      'session.send': () => ({ messageId: id('msg'), runId: id('run'), delivery: 'started' }),
    });
    const rt = createRuntime(fake.client);
    rt.queryClient.setQueryData(qk.messages(s.id), []);
    await startConversation(rt, { text: '直して', workspace: { kind: 'folder', path: '/tmp/x' } });
    expect(fake.calls[0]!.params).toEqual({
      kind: 'agent',
      title: '直して',
      workspace: { kind: 'folder', path: '/tmp/x' },
    });
  });

  it('marks a message sent to a busy agent as queued and passes interrupt on', async () => {
    const s = session({ kind: 'agent' });
    const messageId = id('msg');
    const fake = createFakeClient({
      'session.send': () => ({ messageId, runId: null, delivery: 'queued' }),
    });
    const rt = createRuntime(fake.client);
    rt.queryClient.setQueryData(qk.messages(s.id), []);
    let delivery = '';
    await sendMessage(rt, s.id, 'あとで', { interrupt: true, onDelivery: (d) => (delivery = d) });
    expect(fake.calls[0]!.params).toMatchObject({ interrupt: true });
    expect(delivery).toBe('queued');
    expect(rt.queryClient.getQueryData<{ id: string; delivery: string }[]>(qk.messages(s.id))).toEqual([
      expect.objectContaining({ id: messageId, delivery: 'queued' }),
    ]);
  });

  it('delegates and stops through the daemon, and reports a refusal', async () => {
    const fake = createFakeClient({
      'session.delegate': () => ({ grant: {}, budget: null }),
      'session.stop': () => {
        throw new AccClientError('forbidden', 'no');
      },
    });
    const rt = createRuntime(fake.client);
    const sid = id('ses');
    expect(await delegateSession(rt, sid, { budgetUsd: 5 })).toBe(true);
    expect(fake.calls[0]).toEqual({ method: 'session.delegate', params: { sessionId: sid, budgetUsd: 5 } });
    expect(await stopTree(rt, sid)).toBe(false);
  });
});
