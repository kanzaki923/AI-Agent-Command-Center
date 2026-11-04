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
  stopHere,
  stopIfMoving,
  stopTree,
} from './actions';
import { qk } from './keys';
import { createRuntime } from './runtime';
import { useToasts } from '../store/toast';

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
  it('starts a conversation through the daemon (assistant.startWork), delegated when asked', async () => {
    const s = session({ kind: 'chat' });
    const fake = createFakeClient({ 'assistant.startWork': () => ({ session: s }) });
    const rt = createRuntime(fake.client);
    rt.queryClient.setQueryData(qk.sessions, []);
    expect(await startConversation(rt, { text: '調べて', delegate: true })).toEqual(s);
    expect(fake.calls).toEqual([{ method: 'assistant.startWork', params: { text: '調べて', delegate: true } }]);
    expect(rt.queryClient.getQueryData(qk.sessions)).toEqual([s]);
  });

  it('passes the chosen workspace and project on; 作業場所なし is left out', async () => {
    const s = session({ kind: 'agent' });
    const projectId = id('prj');
    const fake = createFakeClient({ 'assistant.startWork': () => ({ session: s }) });
    const rt = createRuntime(fake.client);
    await startConversation(rt, { text: '直して', workspace: { kind: 'worktree', projectId } });
    await startConversation(rt, { text: '書いて', projectId, workspace: { kind: 'none' } });
    expect(fake.calls.map((c) => c.params)).toEqual([
      { text: '直して', delegate: false, workspace: { kind: 'worktree', projectId } },
      { text: '書いて', delegate: false, projectId },
    ]);
  });

  it('returns null with a toast when the daemon refuses', async () => {
    const fake = createFakeClient({
      'assistant.startWork': () => {
        throw new AccClientError('limit_exceeded', 'no');
      },
    });
    expect(await startConversation(createRuntime(fake.client), { text: 'x' })).toBeNull();
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

describe('止める (one behaviour from every entrance)', () => {
  const stopped = () => ({ stoppedSessionIds: [], cancelledRunIds: [] });

  it('stops the whole tree without asking, and the toast resumes it', async () => {
    useToasts.setState({ toasts: [] });
    const fake = createFakeClient({ 'session.stop': stopped, 'session.resume': () => ({ resumedSessionIds: [], runIds: [] }) });
    const rt = createRuntime(fake.client);
    const s = session({ kind: 'agent', title: '調査' });
    expect(await stopHere(rt, s)).toBe(true);
    expect(fake.calls[0]).toEqual({ method: 'session.stop', params: { sessionId: s.id, tree: true } });
    const t = useToasts.getState().toasts.at(-1)!;
    expect(t.title).toBe('「調査」を止めました');
    expect(t.action?.label).toBe('再開');
    t.action!.run();
    expect(fake.calls[1]).toEqual({ method: 'session.resume', params: { sessionId: s.id, tree: true } });
  });

  it('from a key or /stop: stops a parent whose child still works, and does nothing when nothing moves', async () => {
    const fake = createFakeClient({ 'session.stop': stopped });
    const rt = createRuntime(fake.client);
    const parent = session({ kind: 'agent', state: 'idle', activeRunId: null });
    const child = session({ kind: 'agent', state: 'working', parentSessionId: parent.id, rootSessionId: parent.id });
    const quiet = session({ kind: 'chat', state: 'idle', activeRunId: null });
    rt.queryClient.setQueryData(qk.sessions, [parent, child, quiet]);
    expect(stopIfMoving(rt, quiet.id)).toBe(false);
    expect(stopIfMoving(rt, parent.id)).toBe(true);
    await Promise.resolve();
    expect(fake.calls).toEqual([{ method: 'session.stop', params: { sessionId: parent.id, tree: true } }]);
  });
});
