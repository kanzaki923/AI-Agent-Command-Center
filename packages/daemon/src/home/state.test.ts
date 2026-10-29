/**
 * T7 acceptance 1 (spec 20261029 §5.9, §3.7): the state derivation table, and the
 * `sessionState` service keeping Session.state / stateSince / now current from events.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Event, SessionState } from '@acc/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { insertRun } from '../policy/testutil';
import {
  HUMAN,
  SYSTEM,
  type TestDaemonNoServer,
  createTestDaemon,
  insertTestTask,
} from '../testing';
import { type StateFacts, type SessionStateTracker, deriveSessionState } from './state';
import { finishHeldRun, holdRuns, openAttention, resolveAttention, startHeldRun } from './testutil';

const daemons: TestDaemonNoServer[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.cleanup();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 5 });
});

async function daemon(home?: string) {
  const d = await createTestDaemon(home ? { home } : {});
  daemons.push(d);
  tracker(d).nowIntervalMs = 0;
  return d;
}

const tracker = (d: TestDaemonNoServer) =>
  d.ctx.service('sessionState') as unknown as SessionStateTracker;

function eventsOf<T extends Event['type']>(d: TestDaemonNoServer, type: T) {
  return d.ctx.bus
    .list({ types: [type] })
    .events.filter((e): e is Extract<Event, { type: T }> => e.type === type);
}

const stateOf = (d: TestDaemonNoServer, id: string) => d.ctx.repos.sessions.require(id).state;

describe('deriveSessionState: every row of §3.7, in precedence order', () => {
  const base: StateFacts = {
    kind: 'agent',
    openAttention: [],
    lastRunStatus: null,
    taskStatus: null,
    descendantBusy: false,
    hasChildren: false,
    supervision: 'active',
  };
  it.each<[string, Partial<StateFacts>, SessionState]>([
    ['question', { openAttention: ['question'] }, 'needs_you'],
    ['approval', { openAttention: ['approval'], lastRunStatus: 'awaiting_approval' }, 'needs_you'],
    ['budget', { openAttention: ['budget'], taskStatus: 'failed' }, 'needs_you'],
    ['stuck', { openAttention: ['stuck', 'failure'] }, 'needs_you'],
    ['failure', { openAttention: ['failure'], lastRunStatus: 'running' }, 'failed'],
    ['failure beats review', { openAttention: ['failure', 'review'] }, 'failed'],
    ['running', { lastRunStatus: 'running', taskStatus: 'review' }, 'working'],
    ['awaiting approval', { lastRunStatus: 'awaiting_approval' }, 'working'],
    ['working beats supervising', { lastRunStatus: 'running', descendantBusy: true }, 'working'],
    ['children busy', { lastRunStatus: 'completed', descendantBusy: true }, 'supervising'],
    ['children busy, no run yet', { descendantBusy: true, kind: 'chat' }, 'supervising'],
    ['own run queued', { lastRunStatus: 'queued', descendantBusy: true }, 'queued'],
    ['own run created', { lastRunStatus: 'created' }, 'queued'],
    ['task pending (after)', { taskStatus: 'pending' }, 'queued'],
    ['task ready (slot)', { taskStatus: 'ready', lastRunStatus: 'interrupted' }, 'queued'],
    ['task review', { taskStatus: 'review', lastRunStatus: 'completed' }, 'review'],
    ['review item', { openAttention: ['review'], kind: 'chat' }, 'review'],
    ['task paused', { taskStatus: 'paused', lastRunStatus: 'cancelled' }, 'stopped'],
    ['supervision paused', { supervision: 'paused', kind: 'chat' }, 'stopped'],
    ['review beats stopped', { taskStatus: 'review', supervision: 'paused' }, 'review'],
    ['task done', { taskStatus: 'done', kind: 'chat' }, 'done'],
    ['agent done without task', { lastRunStatus: 'completed' }, 'done'],
    ['agent with children', { lastRunStatus: 'completed', hasChildren: true }, 'idle'],
    ['chat answered', { lastRunStatus: 'completed', kind: 'chat' }, 'idle'],
    ['run failed, no item', { lastRunStatus: 'failed' }, 'idle'],
    ['nothing', {}, 'idle'],
  ])('%s → %s', (_name, facts, state) => {
    expect(deriveSessionState({ ...base, ...facts })).toBe(state);
  });
});

describe('sessionState follows events', () => {
  it('a child working makes it working and its parent supervising, then done', async () => {
    const d = await daemon();
    const held = holdRuns(d.ctx, 'agent');
    const root = await d.call(HUMAN, 'session.create', { title: '指揮' });
    const child = await d.call(HUMAN, 'session.create', {
      kind: 'agent',
      parentSessionId: root.id,
    });
    const { run } = await startHeldRun(d.ctx, child.id, 'agent', held);
    expect(stateOf(d, child.id)).toBe('working');
    expect(stateOf(d, root.id)).toBe('supervising');
    const s = d.ctx.repos.sessions.require(child.id);
    expect(s.stateSince).not.toBeNull();
    expect(s.now).toBe('準備中');

    await finishHeldRun(d.ctx, held, run.id);
    expect(stateOf(d, child.id)).toBe('done');
    expect(stateOf(d, root.id)).toBe('idle');
    expect(d.ctx.repos.sessions.require(child.id).now).toBeNull();

    const changes = eventsOf(d, 'session.state_changed').map((e) => [
      e.payload.sessionId === child.id ? 'child' : 'root',
      e.payload.from,
      e.payload.to,
    ]);
    expect(changes).toEqual([
      ['child', 'idle', 'queued'],
      ['root', 'idle', 'supervising'],
      ['child', 'queued', 'working'],
      ['child', 'working', 'done'],
      ['root', 'supervising', 'idle'],
    ]);
    const last = eventsOf(d, 'session.state_changed').at(-2)!;
    expect(last.payload).toMatchObject({
      rootSessionId: root.id,
      parentSessionId: root.id,
      now: null,
    });
    expect(last.sessionId).toBe(child.id);
  });

  it('attention, tasks and supervision move the state', async () => {
    const d = await daemon();
    const s = await d.call(HUMAN, 'session.create', { kind: 'agent' });
    const failure = openAttention(d.ctx, s.id, 'failure');
    expect(stateOf(d, s.id)).toBe('failed');
    const q = openAttention(d.ctx, s.id, 'question', '価格を FAQ に載せる？');
    expect(stateOf(d, s.id)).toBe('needs_you');
    resolveAttention(d.ctx, q.id);
    expect(stateOf(d, s.id)).toBe('failed');
    resolveAttention(d.ctx, failure.id);
    expect(stateOf(d, s.id)).toBe('idle');

    const task = insertTestTask(d.ctx, {
      projectId: null,
      status: 'pending',
      assigneeSessionId: s.id,
    });
    const setTask = (status: 'review' | 'paused' | 'done') =>
      d.ctx.db.transaction(() => {
        const t = d.ctx.repos.tasks.update(task.id, (x) => ({ ...x, status }));
        d.ctx.bus.emit({
          type: 'task.updated',
          actor: SYSTEM,
          payload: { task: t, changes: ['status'] },
        });
      });
    d.ctx.service('sessionState').recompute(s.id);
    expect(stateOf(d, s.id)).toBe('queued');
    setTask('review');
    expect(stateOf(d, s.id)).toBe('review');
    setTask('paused');
    expect(stateOf(d, s.id)).toBe('stopped');
    setTask('done');
    expect(stateOf(d, s.id)).toBe('done');

    const chat = await d.call(HUMAN, 'session.create', {});
    d.ctx.db.transaction(() => {
      const session = d.ctx.repos.sessions.update(chat.id, (x) => ({
        ...x,
        supervision: 'paused',
      }));
      d.ctx.bus.emit({
        type: 'session.updated',
        actor: SYSTEM,
        payload: { session, changes: ['supervision'] },
      });
    });
    expect(stateOf(d, chat.id)).toBe('stopped');
  });

  it('now follows tool uses, activity and streaming, and clears when the run ends', async () => {
    const d = await daemon();
    const held = holdRuns(d.ctx, 'agent');
    const s = await d.call(HUMAN, 'session.create', { kind: 'agent' });
    const { run, ctl } = await startHeldRun(d.ctx, s.id, 'agent', held);
    const now = () => d.ctx.repos.sessions.require(s.id).now;
    const m1 = d.ctx.ids.next('message');

    ctl.setActivity('Claude Code を起動しました');
    expect(now()).toBe('準備中');
    ctl.toolCalled({ toolCallId: 't1', name: 'Edit', input: { file_path: '/w/docs/faq.md' } });
    expect(now()).toBe('faq.md を編集');
    ctl.setActivity('ファイルを編集中: docs/faq.md');
    expect(now()).toBe('faq.md を編集');
    ctl.toolCalled({ toolCallId: 't2', name: 'mcp__acc__session_spawn', input: {} });
    ctl.toolCalled({ toolCallId: 't3', name: 'mcp__acc__session_spawn', input: {} });
    expect(now()).toBe('2 人に依頼');
    ctl.toolCalled({ toolCallId: 't4', name: 'mcp__acc__orchestrator_recordDecision', input: {} });
    expect(now()).toBe('2 人に依頼');
    ctl.emitDelta(m1, 'こんに');
    expect(now()).toBe('回答を作成中');
    ctl.emitDelta(m1, 'ちは');
    ctl.toolCalled({ toolCallId: 't5', name: 'Bash', input: { command: 'pnpm test' } });
    expect(now()).toBe('pnpm test を実行');

    const nows = eventsOf(d, 'session.now_changed').map((e) => e.payload.now);
    expect(nows).toEqual([
      'faq.md を編集',
      '1 人に依頼',
      '2 人に依頼',
      '回答を作成中',
      'pnpm test を実行',
    ]);
    expect(eventsOf(d, 'session.now_changed')[0]!.payload.rootSessionId).toBe(s.id);

    await finishHeldRun(d.ctx, held, run.id);
    expect(now()).toBeNull();
    expect(eventsOf(d, 'session.state_changed').at(-1)!.payload).toMatchObject({
      to: 'done',
      now: null,
    });
  });

  it('a run waiting for approval shows the item title', async () => {
    const d = await daemon();
    const held = holdRuns(d.ctx, 'agent');
    const s = await d.call(HUMAN, 'session.create', { kind: 'agent' });
    const { ctl } = await startHeldRun(d.ctx, s.id, 'agent', held);
    ctl.toolCalled({ toolCallId: 't1', name: 'Bash', input: { command: 'pnpm add zod' } });
    const decision = ctl.requestApproval({ kind: 'tool_use', title: 'コマンドの実行' });
    // The attention module turns the approval into an item at once: its title is shown.
    const item = d.ctx.repos.attention.findOne({ where: { session_id: s.id, kind: 'approval' } })!;
    expect(item.status).toBe('open');
    expect(d.ctx.repos.sessions.require(s.id)).toMatchObject({
      state: 'needs_you',
      now: item.title,
    });
    const approval = d.ctx.repos.approvals.findOne({ where: { session_id: s.id } })!;
    d.ctx.service('runs').resolveApproval(approval.id, { decision: 'approved' }, HUMAN);
    await decision;
  });

  it('writes now at most once per interval, keeping the latest phrase', async () => {
    const d = await daemon();
    tracker(d).nowIntervalMs = 150;
    const held = holdRuns(d.ctx, 'agent');
    const s = await d.call(HUMAN, 'session.create', { kind: 'agent' });
    const { ctl } = await startHeldRun(d.ctx, s.id, 'agent', held);
    // The state change wrote now (準備中) just before: the next writes wait.
    for (const f of ['a.md', 'b.md', 'c.md']) {
      ctl.toolCalled({ toolCallId: f, name: 'Read', input: { file_path: f } });
    }
    expect(eventsOf(d, 'session.now_changed')).toHaveLength(0);
    await vi.waitFor(() => expect(eventsOf(d, 'session.now_changed')).toHaveLength(1), {
      timeout: 2000,
    });
    expect(eventsOf(d, 'session.now_changed')[0]!.payload.now).toBe('c.md を参照');
    expect(d.ctx.repos.sessions.require(s.id).now).toBe('c.md を参照');
  });

  it('a restart reconciles states silently and ends no work grant', async () => {
    const home = mkdtempSync(join(tmpdir(), 'acc-home-state-'));
    homes.push(home);
    const d1 = await daemon(home);
    const root = await d1.call(HUMAN, 'session.create', { title: 'root' });
    const child = await d1.call(HUMAN, 'session.create', {
      kind: 'agent',
      parentSessionId: root.id,
    });
    const grant = d1.ctx.service('policy').createGrant(
      {
        subject: { kind: 'session', sessionId: root.id },
        permissions: ['session.get'],
        lifetime: 'work',
      },
      HUMAN,
    );
    insertRun(d1.ctx, { sessionId: child.id, status: 'running' });
    d1.ctx.service('sessionState').recompute(child.id);
    expect(stateOf(d1, child.id)).toBe('working');
    expect(stateOf(d1, root.id)).toBe('supervising');
    await d1.close();
    daemons.splice(daemons.indexOf(d1), 1);

    const d2 = await daemon(home);
    const seq = d2.ctx.bus.lastSeq();
    expect(stateOf(d2, child.id)).toBe('idle');
    expect(stateOf(d2, root.id)).toBe('idle');
    expect(d2.ctx.repos.sessions.require(child.id).now).toBeNull();
    expect(
      d2.ctx.bus.list({ types: ['session.state_changed'] }).events.filter((e) => e.seq <= seq),
    ).toHaveLength(2);
    expect(d2.ctx.repos.grants.require(grant.id).revokedAt).toBeNull();
  });
});
