/**
 * T5 Cost acceptance tests (spec 20261029 §5.7): the usage ledger, live spend, child budget
 * returns and overrun propagation, the daily limit, cost.summary, budget changes. Mock agent
 * runtime and mock LLM only (no API is ever called).
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Event, Run, Session } from '@acc/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonContext } from '../core/context';
import { createManualClock } from '../core/clock';
import { MockAgentRuntime } from '../runtime/mock/runtime';
import {
  HUMAN,
  SYSTEM,
  type TestDaemonNoServer,
  agentActor,
  createTestDaemon,
  insertTestTask,
} from '../testing';
import type { UsageLedger } from './service';
import type { BudgetManager } from '../policy/budget';
import { actorOf, insertRun } from '../policy/testutil';

vi.setConfig({ testTimeout: 30_000 });

let d: TestDaemonNoServer | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await d?.cleanup();
  d = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const micro = (usd: number) => Math.round(usd * 1e6);
const ledgerOf = (ctx: DaemonContext) => ctx.service('ledger') as UsageLedger;
const budgetsOf = (ctx: DaemonContext) => ctx.service('budget') as BudgetManager;

/** A daemon whose mock agent runs without delays and whose commits are no-ops (no git). */
async function daemon(opts: Parameters<typeof createTestDaemon>[0] = {}) {
  d = await createTestDaemon(opts);
  const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
  vi.spyOn(d.ctx.service('runtimes').get('mock'), 'run').mockImplementation((i) => fast.run(i));
  vi.spyOn(d.ctx.service('workspaces'), 'commitAll').mockResolvedValue(null);
  return d;
}

/** An agent session working in a plain folder (a `directory` workspace). */
async function agentSession(ctx: DaemonContext, over: { parentSessionId?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acc-cost-'));
  dirs.push(dir);
  const now = ctx.clock.iso();
  const ws = ctx.repos.workspaces.insert({
    id: ctx.ids.next('workspace'),
    projectId: null,
    kind: 'directory',
    status: 'ready',
    path: dir,
    branch: null,
    baseRef: null,
    taskId: null,
    lockedByRunId: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  });
  return d!.call(HUMAN, 'session.create', {
    kind: 'agent',
    runtime: 'mock',
    workspaceId: ws.id,
    ...over,
  });
}

const plan = (steps: unknown[], extra: object = {}) =>
  ['```acc-mock', JSON.stringify({ steps, delayScale: 0, summary: '完了', ...extra }), '```'].join(
    '\n',
  );

function startAgent(ctx: DaemonContext, session: Session, prompt: string, budgetId?: string) {
  const msg = ctx.service('sessions').appendMessage({
    sessionId: session.id,
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    author: HUMAN,
  });
  return ctx.service('runs').start({
    sessionId: session.id,
    kind: 'agent',
    createdBy: HUMAN,
    workspaceId: session.workspaceId,
    triggerMessageId: msg.id,
    ...(budgetId ? { budgetId } : {}),
  });
}

function startChat(ctx: DaemonContext, session: Session, model: string, budgetId?: string) {
  const msg = ctx.service('sessions').appendMessage({
    sessionId: session.id,
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    author: HUMAN,
  });
  return ctx.service('runs').start({
    sessionId: session.id,
    kind: 'chat',
    createdBy: HUMAN,
    model,
    triggerMessageId: msg.id,
    ...(budgetId ? { budgetId } : {}),
  });
}

const end = (ctx: DaemonContext, run: Run) => ctx.service('runs').waitForEnd(run.id);
const rows = (ctx: DaemonContext, where = '1', params: string[] = []) =>
  ledgerOf(ctx).store.rows(where, params);

describe('live spend (§5.7-1)', () => {
  it("grows the budget's spend and Session.cost while the mock agent works, and stops it at the limit", async () => {
    const dd = await daemon();
    const { ctx } = dd;
    const session = await agentSession(ctx);
    const budget = budgetsOf(ctx).createRoot({
      subject: { kind: 'session', id: session.id },
      limitUsd: 1,
      actor: HUMAN,
    });
    const run = startAgent(
      ctx,
      session,
      plan([
        { type: 'usage', costUsd: 0.4 },
        { type: 'sleep', ms: 300 },
        { type: 'usage', costUsd: 0.4 },
        { type: 'sleep', ms: 300 },
        { type: 'usage', costUsd: 0.4 },
        { type: 'write', path: 'never.txt', content: 'x' },
      ]),
      budget.id,
    );
    // While it runs, spend is visible on the budget and the session.
    await vi.waitFor(() => {
      expect(ctx.repos.runs.require(run.id).status).toBe('running');
      expect(ctx.repos.budgets.require(budget.id).spentUsd).toBeGreaterThanOrEqual(0.4);
      expect(ctx.repos.sessions.require(session.id).cost.ownUsd).toBeGreaterThanOrEqual(0.4);
    });
    const ended = await end(ctx, run);
    expect(ended).toMatchObject({
      status: 'failed',
      statusReason: 'budget_exhausted',
      error: { code: 'budget_exceeded' },
    });
    // The step after the limit never ran.
    const ws = ctx.repos.workspaces.require(session.workspaceId!);
    expect(existsSync(join(ws.path, 'never.txt'))).toBe(false);
    const b = ctx.repos.budgets.require(budget.id);
    expect(b.spentUsd).toBeCloseTo(ended.usage.costUsd, 6);
    expect(b.spentUsd).toBeGreaterThanOrEqual(1);
    const s = ctx.repos.sessions.require(session.id);
    expect(s.cost).toEqual({
      ownUsd: ended.usage.costUsd,
      treeUsd: ended.usage.costUsd,
      source: 'estimated',
    });
  });

  it('replaces estimates with the final figure as an adjust row (negative allowed)', async () => {
    const { ctx } = await daemon();
    const session = await agentSession(ctx);
    const run = startAgent(
      ctx,
      session,
      plan([
        { type: 'usage', costUsd: 0.5, inputTokens: 1000, outputTokens: 100 },
        // The auto mode classifier's request: outside the runtime's own totals.
        { type: 'usage', costUsd: 0.011, component: 'classifier' },
        // The runtime's own final figure for everything so far: lower than the estimates.
        {
          type: 'usage',
          costUsd: 0.3,
          inputTokens: 900,
          outputTokens: 90,
          phase: 'final',
          source: 'reported',
        },
      ]),
    );
    const ended = await end(ctx, run);
    expect(ended.status).toBe('completed');
    const ledger = rows(ctx, 'run_id = ?', [run.id]);
    const adjust = ledger.filter((r) => r.component === 'adjust');
    expect(adjust).toHaveLength(1);
    expect(adjust[0]!.cost_micro).toBe(-micro(0.2)); // 0.3 replaces the 0.5 estimated before it
    expect([adjust[0]!.input_tokens, adjust[0]!.output_tokens]).toEqual([-100, -10]);
    expect(ledger.filter((r) => r.component === 'classifier')).toMatchObject([
      { cost_micro: micro(0.011), source: 'estimated' },
    ]);
    const total = ledger.reduce((n, r) => n + r.cost_micro, 0);
    expect(total).toBe(micro(ended.usage.costUsd));
    expect(ctx.repos.sessions.require(session.id).cost.ownUsd).toBe(ended.usage.costUsd);
    // After the final figure only the closing message's estimate is added.
    expect(ended.usage.costUsd).toBeGreaterThan(0.311);
    expect(ended.usage.costUsd).toBeLessThan(0.321);
  });

  it('adds spend to every ancestor tree and emits session.cost_updated at most once a second', async () => {
    const { ctx } = await daemon();
    const root = await dd(HUMAN, 'session.create', {});
    const mid = await dd(HUMAN, 'session.create', { parentSessionId: root.id });
    const leaf = await agentSession(ctx, { parentSessionId: mid.id });
    const events: Extract<Event, { type: 'session.cost_updated' }>[] = [];
    ctx.bus.subscribe({ types: ['session.cost_updated'] }, (e) => {
      if (e.type === 'session.cost_updated') events.push(e);
    });
    const ledger = ledgerOf(ctx);
    for (let i = 0; i < 5; i++) {
      ctx.db.transaction(() =>
        ledger.record({
          sessionId: leaf.id,
          runId: null,
          component: 'agent',
          costUsd: 0.1,
          source: 'estimated',
        }),
      );
    }
    // Leading emission per session at once; the rest folded into one trailing emission.
    expect(events.filter((e) => e.payload.sessionId === root.id)).toHaveLength(1);
    ledger.flushEvents();
    const forRoot = events.filter((e) => e.payload.sessionId === root.id);
    expect(forRoot).toHaveLength(2);
    expect(forRoot.at(-1)!.payload).toMatchObject({
      rootSessionId: root.id,
      ownUsd: 0,
      treeUsd: 0.5,
      source: 'estimated',
    });
    expect(ctx.repos.sessions.require(leaf.id).cost).toEqual({
      ownUsd: 0.5,
      treeUsd: 0.5,
      source: 'estimated',
    });
    expect(ctx.repos.sessions.require(mid.id).cost).toEqual({
      ownUsd: 0,
      treeUsd: 0.5,
      source: 'estimated',
    });
    // A reported row does not hide that part of the total was estimated.
    ledger.record({
      sessionId: root.id,
      runId: null,
      component: 'llm',
      costUsd: 0.2,
      source: 'reported',
    });
    expect(ctx.repos.sessions.require(root.id).cost).toEqual({
      ownUsd: 0.2,
      treeUsd: 0.7,
      source: 'estimated',
    });
  });
});

/** `d.call` of the current daemon. */
const dd: TestDaemonNoServer['call'] = (...args) => d!.call(...args);

describe('child budgets (§5.7-3)', () => {
  it('returns a done child\'s unused budget to its parent (the "$0.20 free and stuck" case)', async () => {
    const { ctx } = await daemon({ clock: createManualClock() });
    await dd(HUMAN, 'settings.update', { llmCallReserveUsd: 0.25 });
    const parent = await dd(HUMAN, 'session.create', { model: 'mock/costly' });
    const child = await agentSession(ctx, { parentSessionId: parent.id });
    const budgets = budgetsOf(ctx);
    const pool = budgets.createRoot({
      subject: { kind: 'session', id: parent.id },
      limitUsd: 1,
      actor: HUMAN,
    });
    const slice = budgets.allocate({
      parentId: pool.id,
      subject: { kind: 'session', id: child.id },
      limitUsd: 0.8,
      actor: HUMAN,
    });
    const task = insertTestTask(ctx, {
      projectId: null,
      status: 'running',
      assigneeSessionId: child.id,
    });
    ctx.repos.sessions.update(child.id, (s) => ({ ...s, taskId: task.id }));
    ctx.service('llm').mock.define('mock/costly', () => ({
      text: 'ok',
      usage: { costUsd: 0.01, costSource: 'reported' },
    }));

    // While the child holds $0.80, the parent has $0.20: less than one call's reservation.
    const stuck = await end(ctx, startChat(ctx, parent, 'mock/costly', pool.id));
    expect(stuck).toMatchObject({ status: 'failed', statusReason: 'budget_exhausted' });

    const work = await end(
      ctx,
      startAgent(ctx, child, plan([{ type: 'usage', costUsd: 0.05 }]), slice.id),
    );
    expect(work.status).toBe('completed');
    // The child's task is done: its unused part goes back.
    ctx.service('tasks').setStatus(task.id, 'done', SYSTEM, null);
    await vi.waitFor(() => expect(ctx.repos.budgets.require(slice.id).status).toBe('released'));
    const after = ctx.repos.budgets.require(pool.id);
    expect(after.allocatedUsd).toBeCloseTo(work.usage.costUsd, 6);
    const ok = await end(ctx, startChat(ctx, parent, 'mock/costly', pool.id));
    expect(ok.status).toBe('completed');

    // A retry carves the slice again from the parent.
    const again = budgets.reallocate(slice.id, HUMAN)!;
    expect(again).toMatchObject({ status: 'active', parentId: pool.id, limitUsd: 0.8 });
  });

  it('keeps the budget while the child still runs, and a session root budget is never auto-released', async () => {
    const { ctx } = await daemon();
    const child = await agentSession(ctx);
    const root = budgetsOf(ctx).createRoot({
      subject: { kind: 'session', id: child.id },
      limitUsd: 1,
      actor: HUMAN,
    });
    const task = insertTestTask(ctx, {
      projectId: null,
      status: 'running',
      assigneeSessionId: child.id,
    });
    await end(ctx, startAgent(ctx, child, plan([{ type: 'say', text: 'x' }]), root.id));
    ctx.service('tasks').setStatus(task.id, 'done', SYSTEM, null);
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.repos.budgets.require(root.id).status).toBe('active');
  });

  it("carries a child's overrun up to the root and stops the whole tree once the root is over", async () => {
    const { ctx } = await daemon();
    const parent = await dd(HUMAN, 'session.create', {});
    const a = await agentSession(ctx, { parentSessionId: parent.id });
    const b = await agentSession(ctx, { parentSessionId: parent.id });
    const budgets = budgetsOf(ctx);
    const pool = budgets.createRoot({
      subject: { kind: 'session', id: parent.id },
      limitUsd: 1,
      actor: HUMAN,
    });
    const sa = budgets.allocate({
      parentId: pool.id,
      subject: { kind: 'session', id: a.id },
      limitUsd: 0.3,
      actor: HUMAN,
    });
    const sb = budgets.allocate({
      parentId: pool.id,
      subject: { kind: 'session', id: b.id },
      limitUsd: 0.6,
      actor: HUMAN,
    });
    // b works slowly; a overruns its $0.30 by $0.20 in one report.
    const runB = startAgent(ctx, b, plan([{ type: 'sleep', ms: 20_000 }]), sb.id);
    await vi.waitFor(() => expect(ctx.repos.runs.require(runB.id).status).toBe('running'));
    const runA = startAgent(ctx, a, plan([{ type: 'usage', costUsd: 0.5 }]), sa.id);
    const [endA, endB] = await Promise.all([end(ctx, runA), end(ctx, runB)]);
    expect(endA).toMatchObject({ status: 'failed', statusReason: 'budget_exhausted' });
    // The pool gave $0.90 and a used $0.20 more: $1.10 committed of $1, so b stops too.
    expect(endB).toMatchObject({ status: 'failed', statusReason: 'budget_exhausted' });
    const p = ctx.repos.budgets.require(pool.id);
    expect(p.allocatedUsd).toBeCloseTo(0.9 + (endA.usage.costUsd - 0.3), 6);
    expect(budgets.available(sb.id)).toMatchObject({ limitedBy: pool.id });
    expect(budgets.available(sb.id).freeUsd).toBeLessThan(0);
  });
});

describe('the daily limit (§5.7-4)', () => {
  it('refuses new LLM calls, stops running agents and opens one budget attention', async () => {
    const { ctx } = await daemon();
    await dd(HUMAN, 'settings.update', { limits: { dailyUsd: 0.3 } });
    const open = vi.spyOn(ctx.service('attention'), 'open');
    const limits: Event[] = [];
    ctx.bus.subscribe({ types: ['cost.limit_reached'] }, (e) => limits.push(e));
    const slow = await agentSession(ctx);
    const fast = await agentSession(ctx);
    const runSlow = startAgent(ctx, slow, plan([{ type: 'sleep', ms: 20_000 }]));
    await vi.waitFor(() => expect(ctx.repos.runs.require(runSlow.id).status).toBe('running'));
    const runFast = startAgent(
      ctx,
      fast,
      plan([
        { type: 'usage', costUsd: 0.4 },
        { type: 'write', path: 'x.txt', content: 'x' },
      ]),
    );
    const [a, b] = await Promise.all([end(ctx, runFast), end(ctx, runSlow)]);
    expect(a).toMatchObject({ status: 'failed', statusReason: 'daily_limit' });
    expect(b).toMatchObject({ status: 'failed', statusReason: 'daily_limit' });

    // A new chat call is refused before it reaches the model.
    const chat = await dd(HUMAN, 'session.create', { model: 'mock/fast' });
    const refused = await end(ctx, startChat(ctx, chat, 'mock/fast'));
    expect(refused).toMatchObject({
      status: 'failed',
      statusReason: 'daily_limit',
      error: { code: 'budget_exceeded' },
    });
    await new Promise((r) => setTimeout(r, 10));
    const budgetAttentions = open.mock.calls.filter(
      ([i]) => i.kind === 'budget' && i.choices?.[0]?.id === 'raise_today_10',
    );
    expect(budgetAttentions).toHaveLength(1);
    expect(budgetAttentions[0]![0]).toMatchObject({
      title: '今日の費用が上限（$0.3）に達しました',
      refs: {},
    });
    expect(limits).toHaveLength(1);
    expect(limits[0]!.payload).toMatchObject({ scope: 'daily', limitUsd: 0.3 });

    // "今日だけ +$10" (humans only) lets work continue.
    await expect(
      dd(agentActor(chat.id, refused.id), 'cost.raiseDaily', { addUsd: 10 }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await dd(HUMAN, 'cost.raiseDaily', { addUsd: 10 })).toMatchObject({
      limitUsd: 10.3,
      raisedTodayUsd: 10,
    });
    expect((await end(ctx, startChat(ctx, chat, 'mock/fast'))).status).toBe('completed');
    // Today has room again, so the daily item closed itself.
    await vi.waitFor(() =>
      expect(
        ctx.repos.attention
          .find({ where: { kind: 'budget' } })
          .find((x) => x.choices[0]?.id === 'raise_today_10')?.status,
      ).toBe('resolved'),
    );
  });

  it('the daily item routes "今日だけ +$10" and closes when the settings give today room', async () => {
    const { ctx } = await daemon();
    await dd(HUMAN, 'settings.update', { limits: { dailyUsd: 0.3 } });
    const chat = await dd(HUMAN, 'session.create', { model: 'mock/fast' });
    const spend = await agentSession(ctx);
    await end(ctx, startAgent(ctx, spend, plan([{ type: 'usage', costUsd: 0.4 }])));
    const daily = () =>
      ctx.repos.attention
        .find({ where: { kind: 'budget' } })
        .filter((x) => x.choices[0]?.id === 'raise_today_10');
    await end(ctx, startChat(ctx, chat, 'mock/fast'));
    await vi.waitFor(() => expect(daily()).toHaveLength(1));
    const item = daily()[0]!;
    // The settings choice is a screen to open: refused here, the item stays.
    await expect(
      dd(HUMAN, 'attention.respond', { attentionId: item.id, choiceId: 'open_settings' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(ctx.repos.attention.require(item.id).status).toBe('open');
    expect(
      await dd(HUMAN, 'attention.respond', { attentionId: item.id, choiceId: 'raise_today_10' }),
    ).toMatchObject({ status: 'resolved', resolution: { choiceId: 'raise_today_10' } });
    // "+$10" also continues what the limit cut off: the agent run and the refused chat
    // message run again (the agent's plan spends its $0.4 once more).
    const retries = () =>
      ctx.repos.runs.find({}).filter((r) => r.retryOfRunId && r.status === 'completed');
    await vi.waitFor(() =>
      expect(
        retries()
          .map((r) => r.sessionId)
          .sort(),
      ).toEqual([chat.id, spend.id].sort()),
    );
    expect(ctx.service('ledger').dailyLeft()).toBeCloseTo(9.5, 1);
    expect(ctx.service('ledger').dailyLeft()).toBeLessThanOrEqual(9.5);

    // Reached again tomorrow-style: raising the limit in the settings closes the new item.
    await end(ctx, startAgent(ctx, spend, plan([{ type: 'usage', costUsd: 10 }])));
    await end(ctx, startChat(ctx, chat, 'mock/fast'));
    await vi.waitFor(() => expect(daily().filter((x) => x.status === 'open')).toHaveLength(1));
    await dd(HUMAN, 'settings.update', { limits: { dailyUsd: 50 } });
    expect(daily().filter((x) => x.status === 'open')).toEqual([]);
    expect(daily().map((x) => x.resolution?.choiceId ?? null)).toEqual(
      expect.arrayContaining(['raise_today_10', null]),
    );
  });

  it('passes the run its spend cap: the lower of the budget room and what is left today', async () => {
    const { ctx } = await daemon();
    await dd(HUMAN, 'settings.update', { limits: { dailyUsd: 2 } });
    const session = await agentSession(ctx);
    const budget = budgetsOf(ctx).createRoot({
      subject: { kind: 'session', id: session.id },
      limitUsd: 0.75,
      actor: HUMAN,
    });
    const seen: (number | null)[] = [];
    const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
    vi.spyOn(ctx.service('runtimes').get('mock'), 'run').mockImplementation((i) => {
      seen.push(i.maxBudgetUsd);
      return fast.run(i);
    });
    await end(ctx, startAgent(ctx, session, plan([]), budget.id));
    await end(ctx, startAgent(ctx, session, plan([])));
    expect(seen[0]).toBeCloseTo(0.75, 2);
    expect(seen[1]).toBeLessThanOrEqual(2);
    expect(seen[1]).toBeGreaterThan(1.9);
    await dd(HUMAN, 'settings.update', { limits: { dailyUsd: null } });
    await end(ctx, startAgent(ctx, session, plan([])));
    expect(seen[2]).toBeNull();
  });
});

describe('cost.summary (§5.7-4)', () => {
  it('groups the ledger by day, project, tree and model, and agents see only their tree', async () => {
    const clock = createManualClock(Date.UTC(2026, 9, 27, 3));
    const { ctx } = await daemon({ clock });
    await dd(HUMAN, 'settings.update', { limits: { dailyUsd: 20, timezone: 'UTC' } });
    const project = await dd(HUMAN, 'project.create', { name: '広報' });
    const a = await dd(HUMAN, 'session.create', { title: 'ローンチ準備', projectId: project.id });
    const a1 = await dd(HUMAN, 'session.create', {
      title: '調査',
      parentSessionId: a.id,
      projectId: project.id,
    });
    const b = await dd(HUMAN, 'session.create', { title: '別件' });
    const ledger = ledgerOf(ctx);
    const rec = (
      sessionId: string,
      costUsd: number,
      model: string,
      source: 'reported' | 'estimated' = 'reported',
    ) => ledger.record({ sessionId, runId: null, model, component: 'llm', costUsd, source });
    rec(a.id, 1, 'claude-sonnet-5');
    clock.advance(86_400_000);
    rec(a1.id, 2, 'claude-haiku-4-5', 'estimated');
    clock.advance(86_400_000);
    rec(b.id, 4, 'claude-sonnet-5');

    const week = (groupBy: 'day' | 'project' | 'root' | 'model', more: object = {}) =>
      dd(HUMAN, 'cost.summary', { range: '7d', groupBy, ...more });
    expect(await week('day')).toEqual({
      totalUsd: 7,
      estimated: true,
      rows: [
        { key: '2026-10-27', label: '2026-10-27', usd: 1, estimated: false },
        { key: '2026-10-28', label: '2026-10-28', usd: 2, estimated: true },
        { key: '2026-10-29', label: '2026-10-29', usd: 4, estimated: false },
      ],
      daily: { limitUsd: 20, usedTodayUsd: 4 },
    });
    expect((await week('project')).rows).toEqual([
      { key: 'none', label: 'プロジェクトなし', usd: 4, estimated: false },
      { key: project.id, label: '広報', usd: 3, estimated: true },
    ]);
    expect((await week('root')).rows.map((r) => [r.label, r.usd])).toEqual([
      ['別件', 4],
      ['ローンチ準備', 3],
    ]);
    expect((await week('model')).rows.map((r) => [r.key, r.usd])).toEqual([
      ['claude-sonnet-5', 5],
      ['claude-haiku-4-5', 2],
    ]);
    expect((await dd(HUMAN, 'cost.summary', { range: 'today', groupBy: 'day' })).totalUsd).toBe(4);
    expect((await week('day', { rootSessionId: a.id })).totalUsd).toBe(3);

    // An agent of tree a: its own tree by default, another tree is forbidden.
    ctx.service('policy').createGrant(
      {
        subject: { kind: 'session', sessionId: a.id },
        permissions: ['cost.summary'],
        lifetime: 'session',
      },
      HUMAN,
    );
    const asAgent = actorOf(insertRun(ctx, { sessionId: a.id }));
    expect((await dd(asAgent, 'cost.summary', { range: '7d', groupBy: 'day' })).totalUsd).toBe(3);
    await expect(
      dd(asAgent, 'cost.summary', { range: '7d', groupBy: 'day', rootSessionId: b.id }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('budget changes (§5.7-6)', () => {
  it('budget.raise and session.setBudget are for humans; a child raise is taken from its parent', async () => {
    const { ctx } = await daemon();
    const parent = await dd(HUMAN, 'session.create', {});
    const child = await dd(HUMAN, 'session.create', { parentSessionId: parent.id });
    const { budget: pool } = await dd(HUMAN, 'session.setBudget', {
      sessionId: parent.id,
      limitUsd: 1,
    });
    expect(pool).toMatchObject({
      limitUsd: 1,
      parentId: null,
      subject: { kind: 'session', id: parent.id },
    });
    const budgets = budgetsOf(ctx);
    const slice = budgets.allocate({
      parentId: pool!.id,
      subject: { kind: 'session', id: child.id },
      limitUsd: 0.9,
      actor: HUMAN,
    });

    const agent = agentActor(child.id, ctx.ids.next('run'));
    await expect(
      dd(agent, 'budget.raise', { budgetId: slice.id, addUsd: 1 }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      dd(agent, 'session.setBudget', { sessionId: child.id, limitUsd: 5 }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // +$0.50 for the child: the parent has $0.10 free, so it is raised by the other $0.40.
    const raised = await dd(HUMAN, 'budget.raise', { budgetId: slice.id, addUsd: 0.5 });
    expect(raised.limitUsd).toBeCloseTo(1.4, 6);
    expect(ctx.repos.budgets.require(pool!.id)).toMatchObject({ limitUsd: 1.4, allocatedUsd: 1.4 });

    // Lowering gives the difference back to the parent; null removes the budget.
    const lowered = await dd(HUMAN, 'session.setBudget', { sessionId: child.id, limitUsd: 0.4 });
    expect(lowered.budget).toMatchObject({ id: slice.id, limitUsd: 0.4 });
    expect(ctx.repos.budgets.require(pool!.id).allocatedUsd).toBeCloseTo(0.4, 6);
    expect(await dd(HUMAN, 'session.setBudget', { sessionId: child.id, limitUsd: null })).toEqual({
      budget: null,
    });
    expect(ctx.repos.budgets.require(slice.id).status).toBe('released');
    expect(ctx.repos.budgets.require(pool!.id).allocatedUsd).toBe(0);
  });

  it('announces 50 / 80 / 100 % of a budget tree once each', async () => {
    const { ctx } = await daemon();
    const parent = await dd(HUMAN, 'session.create', {});
    const budgets = budgetsOf(ctx);
    const pool = budgets.createRoot({
      subject: { kind: 'session', id: parent.id },
      limitUsd: 1,
      actor: HUMAN,
    });
    const slice = budgets.allocate({
      parentId: pool.id,
      subject: { kind: 'global', id: null },
      limitUsd: 0.8,
      actor: HUMAN,
    });
    const seen: string[] = [];
    ctx.bus.subscribe({ types: ['budget.threshold'] }, (e) => {
      if (e.type === 'budget.threshold')
        seen.push(`${e.payload.budgetId === pool.id ? 'pool' : 'slice'}:${e.payload.pct}`);
    });
    budgets.recordSpend(slice.id, 0.3);
    budgets.recordSpend(slice.id, 0.3);
    budgets.recordSpend(pool.id, 0.3);
    // slice $0.81 of $0.80 (80 % and 100 %), the pool's tree $1.11 of $1.
    budgets.recordSpend(slice.id, 0.21);
    expect(seen).toEqual(['slice:50', 'pool:50', 'pool:80', 'slice:80', 'slice:100', 'pool:100']);
    const payloads = ctx.bus.list({ types: ['budget.threshold'] }).events.map((e) => e.payload);
    expect(payloads).toContainEqual({ budgetId: pool.id, rootSessionId: parent.id, pct: 100 });
    // A budget without a session (global) belongs to no tree.
    expect(payloads).toContainEqual({ budgetId: slice.id, rootSessionId: null, pct: 100 });
  });
});

describe('spend attentions', () => {
  it("opens one budget attention per used-up budget and one for LiteLLM's key budget", async () => {
    const { ctx } = await daemon();
    const open = vi.spyOn(ctx.service('attention'), 'open');
    const session = await dd(HUMAN, 'session.create', { model: 'mock/big' });
    const budget = budgetsOf(ctx).createRoot({
      subject: { kind: 'session', id: session.id },
      limitUsd: 0.3,
      actor: HUMAN,
    });
    ctx.service('llm').mock.define('mock/big', () => ({
      text: 'ok',
      usage: { costUsd: 0.4, costSource: 'reported' },
    }));
    await end(ctx, startChat(ctx, session, 'mock/big', budget.id));
    await end(ctx, startChat(ctx, session, 'mock/big', budget.id));
    const forBudget = open.mock.calls.filter(([i]) => i.refs.budgetId === budget.id);
    // The attention service dedupes by refs: the daemon asks with the same refs both times.
    expect(forBudget.length).toBeGreaterThanOrEqual(1);
    expect(forBudget[0]![0]).toMatchObject({
      kind: 'budget',
      title: '予算（$0.30）の上限に達しました',
    });

    open.mockClear();
    open.mockReturnValue({ id: 'atn_x' } as never);
    vi.spyOn(ctx.repos.attention, 'get').mockReturnValue({ status: 'open' } as never);
    const quota = await dd(HUMAN, 'session.create', { model: 'mock/quota' });
    ctx.service('llm').mock.define('mock/quota', () => {
      throw Object.assign(new Error('LiteLLM の API キーの予算の上限に達しました'), {
        code: 'llm_quota_exceeded',
      });
    });
    await end(ctx, startChat(ctx, quota, 'mock/quota'));
    await end(ctx, startChat(ctx, quota, 'mock/quota'));
    const quotaCalls = open.mock.calls.filter(([i]) => i.title.includes('LiteLLM'));
    expect(quotaCalls).toHaveLength(1);
  });
});
