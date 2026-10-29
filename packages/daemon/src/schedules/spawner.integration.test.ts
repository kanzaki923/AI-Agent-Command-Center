/**
 * Schedules with the real spawner (T6 × T2): a firing is a child of the owner session with
 * the schedule's title, `scheduleId`, `meta.schedule` and trigger, and the budget the
 * scheduler decided — a root budget for a person's schedule, a slice of its creator's
 * budget for an AI's — and `supervise` makes the firing a supervisor of its own.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { actorOf, insertRun } from '../policy/testutil';
import { HUMAN, type TestDaemonNoServer, createTestDaemon } from '../testing';

let d: TestDaemonNoServer | null = null;
afterEach(async () => {
  await d?.cleanup();
  d = null;
});

async function daemon(): Promise<TestDaemonNoServer> {
  d = await createTestDaemon();
  d.ctx.service('llm').mock.chunkDelayMs = 0;
  return d;
}

const WEEKLY = { kind: 'cron', expr: '0 9 * * 1' } as const;

describe('schedule firings through the real spawner', () => {
  it("a person's schedule fires a chat child with a root budget of its own", async () => {
    const dd = await daemon();
    const owner = await dd.call(HUMAN, 'session.create', { title: '週次', model: 'mock/fast' });
    const s = await dd.call(HUMAN, 'schedule.create', {
      sessionId: owner.id,
      title: '週次レポート',
      prompt: '今週の進捗をまとめて',
      trigger: WEEKLY,
      run: { mode: 'chat', budgetUsd: 0.5 },
    });
    const { sessionId } = await dd.call(HUMAN, 'schedule.runNow', { scheduleId: s.id });
    const child = dd.ctx.repos.sessions.require(sessionId);
    expect(child).toMatchObject({
      kind: 'chat',
      parentSessionId: owner.id,
      rootSessionId: owner.rootSessionId,
      scheduleId: s.id,
    });
    expect(child.title.startsWith('週次レポート · ')).toBe(true);
    const first = dd.ctx.repos.messages
      .find({ where: { session_id: child.id }, orderBy: 'id', direction: 'asc' })
      .at(0)!;
    expect(first.meta).toMatchObject({ kind: 'schedule', scheduleId: s.id });
    const budget = dd.ctx.repos.budgets.findOne({
      where: { subject_kind: 'session', subject_id: child.id },
    })!;
    expect(budget).toMatchObject({ parentId: null, limitUsd: 0.5 });
    const run = dd.ctx.repos.runs.findOne({ where: { session_id: child.id } })!;
    expect(run).toMatchObject({ kind: 'chat', trigger: 'schedule', budgetId: budget.id });
    expect((await dd.ctx.service('runs').waitForEnd(run.id)).status).toBe('completed');
  });

  it("an AI's schedule carves each firing from its creator's budget, and refuses when it does not fit", async () => {
    const dd = await daemon();
    const lead = await dd.call(HUMAN, 'session.create', { title: '指揮', model: 'mock/fast' });
    dd.ctx.service('policy').createGrant(
      {
        subject: { kind: 'session', sessionId: lead.id },
        permissions: ['schedule.*', 'session.get'],
        lifetime: 'session',
      },
      HUMAN,
    );
    const pool = dd.ctx.service('budget').createRoot({
      subject: { kind: 'session', id: lead.id },
      limitUsd: 1,
      actor: HUMAN,
    });
    const actor = actorOf(insertRun(dd.ctx, { sessionId: lead.id }));
    const s = await dd.call(actor, 'schedule.create', {
      sessionId: lead.id,
      prompt: '競合の価格を調べて',
      trigger: WEEKLY,
      run: { mode: 'chat', budgetUsd: 0.6 },
    });
    const { sessionId } = await dd.call(HUMAN, 'schedule.runNow', { scheduleId: s.id });
    const budget = dd.ctx.repos.budgets.findOne({
      where: { subject_kind: 'session', subject_id: sessionId },
    })!;
    expect(budget).toMatchObject({ parentId: pool.id, limitUsd: 0.6 });
    const run = dd.ctx.repos.runs.findOne({ where: { session_id: sessionId } })!;
    await dd.ctx.service('runs').waitForEnd(run.id);
    // The pool has $0.4 left at most: the next firing does not fit and creates nothing.
    const before = dd.ctx.repos.sessions.find({ where: { parent_session_id: lead.id } }).length;
    await expect(dd.call(HUMAN, 'schedule.runNow', { scheduleId: s.id })).rejects.toMatchObject({
      code: 'budget_exceeded',
    });
    expect(dd.ctx.repos.sessions.find({ where: { parent_session_id: lead.id } })).toHaveLength(
      before,
    );
  });

  it('supervise makes the firing lead children of its own', async () => {
    const dd = await daemon();
    const owner = await dd.call(HUMAN, 'session.create', { title: '毎朝', model: 'mock/fast' });
    const s = await dd.call(HUMAN, 'schedule.create', {
      sessionId: owner.id,
      title: '朝の確認',
      prompt: '確認して',
      trigger: WEEKLY,
      run: { mode: 'chat', budgetUsd: 1, supervise: true },
    });
    const { sessionId } = await dd.call(HUMAN, 'schedule.runNow', { scheduleId: s.id });
    expect(dd.ctx.service('policy').sessionAllows(sessionId, 'session.spawn')).toBe(true);
    // Its children may not lead children of their own (depth 1 below the firing).
    expect(dd.ctx.service('policy').sessionAllows(owner.id, 'session.spawn')).toBe(false);
    const run = dd.ctx.repos.runs.findOne({ where: { session_id: sessionId } })!;
    expect(run.kind).toBe('orchestrator');
    await dd.ctx.service('runs').waitForEnd(run.id);
  });
});
