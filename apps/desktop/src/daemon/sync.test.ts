// @vitest-environment node
import {
  type Approval,
  type Artifact,
  type BudgetAllocation,
  type CapabilityGrant,
  EVENT_TYPES,
  type Event,
  type EventPayload,
  type EventType,
  type Integration,
  type Run,
  type Session,
} from '@acc/protocol';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeClient } from '../test/fakeClient';
import { T0, approval, event, integration, iso, message, run, session, task } from '../test/fixtures';
import { createActivityStore } from './activity';
import { createDeltaStore } from './deltas';
import { createEventLog } from './eventLog';
import { createRecentStore } from './recent';
import { qk } from './keys';
import { type BudgetNode, type ChatMessage, type Streams, applyEvent, createInterruptNotifier, startSync } from './sync';

function setup() {
  const qc = new QueryClient();
  const flushNow = (cb: () => void) => cb();
  const streams: Streams = {
    deltas: createDeltaStore(flushNow),
    activity: createActivityStore(),
    events: createEventLog(),
    recent: createRecentStore(),
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

  it('applies run.updated: the executor activity line and usage', () => {
    const { qc, streams } = ctx;
    const s = session();
    const r = run(s, { status: 'running' });
    qc.setQueryData<Run[]>(qk.runs, [r]);
    const busy = { ...r, activity: 'npm test を実行中' };
    applyEvent(qc, streams, event('run.updated', { run: busy, changes: ['activity'] }));
    expect(streams.activity.get(r.id)?.text).toBe('npm test を実行中');
    expect(qc.getQueryData<Run[]>(qk.runs)![0]!.activity).toBe('npm test を実行中');

    const usage = { ...busy, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.3, costSource: 'reported' as const } };
    applyEvent(qc, streams, event('run.updated', { run: usage, changes: ['usage'] }));
    expect(qc.getQueryData<Run>(qk.run(r.id))?.usage.costUsd).toBe(0.3);
    expect(streams.activity.get(r.id)?.text).toBe('npm test を実行中');

    applyEvent(qc, streams, event('run.updated', { run: { ...usage, activity: null }, changes: ['activity'] }));
    expect(streams.activity.get(r.id)).toBeUndefined();
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

  it('keeps a session’s grants live: created (session or run subject) and revoked', () => {
    const { qc, streams } = ctx;
    const s = session({ kind: 'chat' });
    const r = run(s);
    qc.setQueryData<Run[]>(qk.runs, [r]);
    qc.setQueryData<CapabilityGrant[]>(qk.grants(s.id), []);
    const g = grantFixture({ subject: { kind: 'session', sessionId: s.id } });
    applyEvent(qc, streams, event('grant.created', { grant: g }));
    const delegated = grantFixture({ subject: { kind: 'run', runId: r.id }, createdAt: iso(T0 + 5) });
    applyEvent(qc, streams, event('grant.created', { grant: delegated }));
    expect(qc.getQueryData<CapabilityGrant[]>(qk.grants(s.id))!.map((x) => x.id)).toEqual([g.id, delegated.id]);

    const revoke = event('grant.revoked', { grantId: g.id, reason: 'done' });
    applyEvent(qc, streams, revoke);
    expect(qc.getQueryData<CapabilityGrant[]>(qk.grants(s.id))![0]!.revokedAt).toBe(revoke.ts);
  });

  it('patches budgets: the node, its parent’s children and the session’s budgets', () => {
    const { qc, streams } = ctx;
    const root = budgetFixture({ subject: { kind: 'session', id: 'ses_1' } });
    const child = budgetFixture({ parentId: root.id, subject: { kind: 'run', id: 'run_1' } });
    qc.setQueryData<BudgetNode>(qk.budget(root.id), { budget: root, children: [] });
    qc.setQueryData<BudgetAllocation[]>(qk.sessionBudgets('ses_1'), []);
    applyEvent(qc, streams, event('budget.updated', { budget: { ...root, allocatedUsd: 1 }, reason: 'allocate' }));
    applyEvent(qc, streams, event('budget.updated', { budget: child, reason: 'allocate' }));
    const node = qc.getQueryData<BudgetNode>(qk.budget(root.id))!;
    expect(node.budget.allocatedUsd).toBe(1);
    expect(node.children.map((c) => c.id)).toEqual([child.id]);
    expect(qc.getQueryData<BudgetAllocation[]>(qk.sessionBudgets('ses_1'))!.map((b) => b.allocatedUsd)).toEqual([1]);
  });

  it('adds new artifacts to the lists the UI keeps', () => {
    const { qc, streams } = ctx;
    const art = {
      id: 'art_1',
      kind: 'test_result',
      projectId: 'prj_1',
      sessionId: 'ses_1',
      runId: null,
      taskId: null,
      workspaceId: null,
      title: 't',
      createdBy: { kind: 'system', component: 'x' },
      createdAt: iso(T0),
      data: { command: 'pnpm test', passed: true, exitCode: 0, durationMs: 1, summary: 'ok', output: null },
    } as Artifact;
    qc.setQueryData(qk.artifacts('ses_1', 'test_result'), []);
    qc.setQueryData(qk.projectArtifacts('prj_1', 'test_result'), []);
    applyEvent(qc, streams, event('artifact.created', { artifact: art }));
    expect(qc.getQueryData<Artifact[]>(qk.artifacts('ses_1', 'test_result'))).toEqual([art]);
    expect(qc.getQueryData<Artifact[]>(qk.projectArtifacts('prj_1', 'test_result'))).toEqual([art]);
    expect(qc.getQueryData(qk.artifact('art_1'))).toBe(art);
  });

  it('shows denials and orchestrator decisions on the run’s activity line', () => {
    const { qc, streams } = ctx;
    applyEvent(qc, streams, event('policy.denied', { permission: 'settings.update', reason: 'no grant', projectIds: null }, { runId: 'run_d' }));
    expect(streams.activity.get('run_d')?.text).toBe('権限外の操作を拒否しました（settings.update）');
    applyEvent(qc, streams, event('orchestrator.decision', { decision: 'Task を 2 つに分割', rationale: '独立しているため' }, { runId: 'run_o' }));
    expect(streams.activity.get('run_o')?.text).toBe('Task を 2 つに分割');
  });

  it('keeps integration detail caches in step with the list', () => {
    const { qc, streams } = ctx;
    const i = integration({ status: 'running' });
    qc.setQueryData(qk.integrations, [i]);
    applyEvent(qc, streams, event('integration.updated', { integration: { ...i, status: 'verifying' }, changes: ['status'] }));
    expect(qc.getQueryData<Integration[]>(qk.integrations)![0]!.status).toBe('verifying');
    expect(qc.getQueryData<Integration>(['integration.get', i.id])!.status).toBe('verifying');
  });

  it('handles every event type the protocol defines', () => {
    // The switch is exhaustive at compile time; this guards the runtime path too.
    const { qc, streams } = ctx;
    expect(EVENT_TYPES.length).toBeGreaterThan(20);
    for (const type of EVENT_TYPES) expect(() => applyEvent(qc, streams, sampleEvent(type))).not.toThrow();
  });
});

function grantFixture(over: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    id: `grt_${Math.random().toString(36).slice(2)}`,
    subject: { kind: 'session', sessionId: 'ses_x' },
    parentGrantId: null,
    permissions: ['task.*'],
    scope: {},
    limits: {},
    depth: 0,
    lifetime: 'session',
    expiresAt: null,
    revokedAt: null,
    reason: null,
    grantedBy: { kind: 'human', client: 'test' },
    createdAt: iso(T0),
    ...over,
  };
}

function budgetFixture(over: Partial<BudgetAllocation> = {}): BudgetAllocation {
  return {
    id: `bud_${Math.random().toString(36).slice(2)}`,
    parentId: null,
    subject: { kind: 'global', id: null },
    status: 'active',
    limitUsd: 5,
    allocatedUsd: 0,
    reservedUsd: 0,
    spentUsd: 0,
    createdBy: { kind: 'human', client: 'test' },
    createdAt: iso(T0),
    updatedAt: iso(T0),
    releasedAt: null,
    ...over,
  };
}

/** A structurally valid event of any type (payload details do not matter here). */
function sampleEvent(type: EventType): Event {
  const s = session();
  const r = run(s);
  const payloads: { [K in EventType]: EventPayload<K> } = {
    'project.created': { project: { id: 'prj_1', name: 'p' } as never },
    'project.updated': { project: { id: 'prj_1', name: 'p' } as never, changes: ['name'] },
    'session.created': { session: s },
    'session.updated': { session: s, changes: ['title'] },
    'session.archived': { sessionId: s.id, archived: true },
    'message.created': { message: message(s) },
    'run.created': { run: r },
    'run.status_changed': { runId: r.id, from: 'running', to: 'completed', reason: null },
    'run.updated': { run: r, changes: ['usage'] },
    'run.completed': { run: r },
    'run.failed': { run: r, error: { code: 'x', message: 'x' } },
    'tool.called': { runId: r.id, toolCallId: 't', name: 'Read', input: {} },
    'tool.result': { runId: r.id, toolCallId: 't', name: 'Read', output: {}, isError: false, durationMs: 1 },
    'approval.requested': { approval: approval(r) },
    'approval.resolved': { approval: approval(r, { status: 'approved' }) },
    'task.created': { task: task() },
    'task.updated': { task: task(), changes: ['status'] },
    'workspace.created': { workspace: { id: 'wsp_1' } as never },
    'workspace.updated': { workspace: { id: 'wsp_1' } as never, changes: ['branch'] },
    'workspace.removed': { workspaceId: 'wsp_1' },
    'artifact.created': { artifact: { id: 'art_x', kind: 'note', projectId: null, sessionId: null, workspaceId: null, data: { text: '' } } as never },
    'integration.created': { integration: integration() },
    'integration.updated': { integration: integration(), changes: ['status'] },
    'grant.created': { grant: grantFixture() },
    'grant.revoked': { grantId: 'grt_x', reason: null },
    'policy.denied': { permission: 'x', reason: 'y', projectIds: null },
    'budget.updated': { budget: budgetFixture(), reason: null },
    'orchestrator.decision': { decision: 'd', rationale: 'r' },
    'settings.updated': { changes: [] },
  };
  return event(type, payloads[type] as never);
}

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
    const stop = startSync(fake.client, qc, streams, undefined, (flush) => flush());
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

  it('applies a burst of events once per frame, in order', () => {
    const { qc, streams } = setup();
    const fake = createFakeClient();
    const frames: (() => void)[] = [];
    const stop = startSync(fake.client, qc, streams, undefined, (flush) => frames.push(flush));
    qc.setQueryData<Session[]>(qk.sessions, []);
    qc.setQueryData<Run[]>(qk.runs, []);
    const sessions = Array.from({ length: 10 }, (_, i) => session({ title: `S${i}`, lastActivityAt: iso(T0 + i) }));
    for (const s of sessions) {
      fake.emit(event('session.created', { session: s }));
      fake.emit(event('run.created', { run: run(s, { status: 'queued' }) }));
    }
    // Nothing applied yet, and a single frame scheduled for all 20 events.
    expect(qc.getQueryData<Session[]>(qk.sessions)).toHaveLength(0);
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(qc.getQueryData<Session[]>(qk.sessions)!.map((s) => s.title)).toEqual(
      sessions.map((s) => s.title).reverse(),
    );
    expect(qc.getQueryData<Run[]>(qk.runs)).toHaveLength(10);
    // Each run made its session active (events applied in order after their session).
    expect(qc.getQueryData<Session[]>(qk.sessions)!.every((s) => s.activeRunId)).toBe(true);
    fake.emit(event('settings.updated', { changes: [] }));
    stop(); // pending events are applied on stop
    expect(streams.events.events.at(-1)?.type).toBe('settings.updated');
  });
});
