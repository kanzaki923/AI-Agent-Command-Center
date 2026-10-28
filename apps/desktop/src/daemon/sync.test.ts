import type { Approval, Run, Session } from '@acc/protocol';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeClient } from '../test/fakeClient';
import { T0, approval, event, iso, message, run, session } from '../test/fixtures';
import { createActivityStore } from './activity';
import { createDeltaStore } from './deltas';
import { createEventLog } from './eventLog';
import { qk } from './keys';
import { type ChatMessage, type Streams, applyEvent, createInterruptNotifier, startSync } from './sync';

function setup() {
  const qc = new QueryClient();
  const flushNow = (cb: () => void) => cb();
  const streams: Streams = {
    deltas: createDeltaStore(flushNow),
    activity: createActivityStore(),
    events: createEventLog(),
  };
  return { qc, streams };
}

describe('applyEvent -> query cache', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('upserts sessions and keeps them ordered by last activity', () => {
    const { qc, streams } = ctx;
    const a = session({ title: 'a', lastActivityAt: iso(T0) });
    qc.setQueryData<Session[]>(qk.sessions, [a]);
    const b = session({ title: 'b', lastActivityAt: iso(T0 + 10) });
    applyEvent(qc, streams, event('session.created', { session: b }));
    expect(qc.getQueryData<Session[]>(qk.sessions)!.map((s) => s.title)).toEqual(['b', 'a']);
    applyEvent(qc, streams, event('session.updated', { session: { ...a, title: 'a2' }, changes: ['title'] }));
    expect(qc.getQueryData<Session[]>(qk.sessions)!.map((s) => s.title)).toEqual(['b', 'a2']);
  });

  it('does not create a collection that was never fetched', () => {
    const { qc, streams } = ctx;
    applyEvent(qc, streams, event('session.created', { session: session() }));
    expect(qc.getQueryData(qk.sessions)).toBeUndefined();
  });

  it('patches run status and clears the session active run when it ends', () => {
    const { qc, streams } = ctx;
    const s = session();
    const r = run(s, { status: 'running' });
    qc.setQueryData<Session[]>(qk.sessions, [s]);
    qc.setQueryData<Run[]>(qk.runs, []);
    applyEvent(qc, streams, event('run.created', { run: r }));
    expect(qc.getQueryData<Session[]>(qk.sessions)![0]!.activeRunId).toBe(r.id);

    applyEvent(qc, streams, event('run.status_changed', { runId: r.id, from: 'running', to: 'awaiting_approval', reason: null }));
    expect(qc.getQueryData<Run[]>(qk.runs)![0]!.status).toBe('awaiting_approval');
    expect(streams.activity.get(r.id)?.text).toBe('承認を待っています');

    const done = { ...r, status: 'completed' as const, endedAt: iso(T0 + 5000) };
    applyEvent(qc, streams, event('run.completed', { run: done }));
    expect(qc.getQueryData<Run[]>(qk.runs)![0]!.status).toBe('completed');
    expect(qc.getQueryData<Session[]>(qk.sessions)![0]!.activeRunId).toBeNull();
    expect(streams.activity.get(r.id)).toBeUndefined();
  });

  it('moves approvals between pending and resolved', () => {
    const { qc, streams } = ctx;
    const s = session();
    const a = approval(run(s));
    qc.setQueryData<Approval[]>(qk.approvals, []);
    applyEvent(qc, streams, event('approval.requested', { approval: a }));
    expect(qc.getQueryData<Approval[]>(qk.approvals)!.map((x) => x.id)).toEqual([a.id]);
    const resolved = { ...a, status: 'approved' as const, resolvedAt: iso(T0 + 1) };
    applyEvent(qc, streams, event('approval.resolved', { approval: resolved }));
    expect(qc.getQueryData<Approval[]>(qk.approvals)).toEqual([]);
    expect(qc.getQueryData<Approval[]>(qk.resolvedApprovals)![0]!.status).toBe('approved');
  });

  it('appends messages, replaces the optimistic copy and finishes the stream', () => {
    const { qc, streams } = ctx;
    const s = session();
    const optimistic: ChatMessage = {
      ...message(s, { id: 'local_1', content: [{ type: 'text', text: 'やあ' }] }),
      local: { status: 'sending', text: 'やあ' },
    };
    qc.setQueryData<ChatMessage[]>(qk.messages(s.id), [optimistic]);
    const persisted = message(s, { content: [{ type: 'text', text: 'やあ' }] });
    applyEvent(qc, streams, event('message.created', { message: persisted }));
    expect(qc.getQueryData<ChatMessage[]>(qk.messages(s.id))!.map((m) => m.id)).toEqual([persisted.id]);

    const r = run(s);
    streams.deltas.push({ runId: r.id, sessionId: s.id, messageId: 'msg_stream', kind: 'text', text: 'こん', index: 0 });
    expect(streams.deltas.store.getState().byMessage.msg_stream?.text).toBe('こん');
    const reply = message(s, { id: 'msg_stream', role: 'assistant', runId: r.id });
    applyEvent(qc, streams, event('message.created', { message: reply }));
    expect(streams.deltas.store.getState().byMessage.msg_stream).toBeUndefined();
    expect(qc.getQueryData<ChatMessage[]>(qk.messages(s.id))).toHaveLength(2);
  });

  it('turns tool calls into activity lines', () => {
    const { qc, streams } = ctx;
    applyEvent(qc, streams, event('tool.called', { runId: 'run_x', toolCallId: 't', name: 'Bash', input: { command: 'pnpm test auth' } }));
    expect(streams.activity.get('run_x')?.text).toBe('pnpm test auth を実行中');
  });

  it('records every event in the timeline log once', () => {
    const { qc, streams } = ctx;
    const e = event('settings.updated', { changes: ['defaultModel'] });
    applyEvent(qc, streams, e);
    applyEvent(qc, streams, e);
    expect(streams.events.events).toHaveLength(1);
  });

  it('invalidates settings and models on settings.updated', () => {
    const { qc, streams } = ctx;
    qc.setQueryData(qk.settings, { x: 1 });
    applyEvent(qc, streams, event('settings.updated', { changes: ['litellm.baseUrl'] }));
    expect(qc.getQueryState(qk.settings)?.isInvalidated).toBe(true);
  });
});

describe('interrupt notifier', () => {
  it('folds a burst of interrupted runs into one notification', () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const n = createInterruptNotifier(notify, 100);
    for (let i = 0; i < 3; i++) {
      n(event('run.status_changed', { runId: `run_${i}`, from: 'running', to: 'interrupted', reason: 'daemon_restart' }));
    }
    n(event('run.status_changed', { runId: 'run_x', from: 'queued', to: 'running', reason: null }));
    vi.advanceTimersByTime(150);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(3);
    vi.useRealTimers();
  });
});

describe('startSync', () => {
  it('subscribes once, applies pushed events/deltas and refetches after a reconnect', () => {
    const { qc, streams } = setup();
    const fake = createFakeClient();
    const stop = startSync(fake.client, qc, streams);
    const s = session();
    qc.setQueryData<Session[]>(qk.sessions, []);
    fake.emit(event('session.created', { session: s }));
    expect(qc.getQueryData<Session[]>(qk.sessions)).toHaveLength(1);

    fake.delta({ runId: 'run_1', sessionId: s.id, messageId: 'm1', kind: 'text', text: 'a', index: 0 });
    expect(streams.deltas.store.getState().byMessage.m1?.text).toBe('a');

    const spy = vi.spyOn(qc, 'invalidateQueries');
    fake.setState('reconnecting');
    fake.setState('open');
    expect(spy).toHaveBeenCalledTimes(1);
    stop();
  });
});
