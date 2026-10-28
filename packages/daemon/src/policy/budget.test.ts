import type { BudgetAllocation, Event } from '@acc/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { BudgetReservation } from '../contracts';
import { ApiError } from '../core/errors';
import { HUMAN, type TestDaemonNoServer, createTestDaemon } from '../testing';
import { type BudgetManager, freeUsd } from './budget';
import { actorOf, insertRun } from './testutil';

let d: TestDaemonNoServer;
afterEach(async () => {
  await d?.cleanup();
});

async function expectCode(p: Promise<unknown>, code: string): Promise<ApiError> {
  const err = await p.then(
    () => {
      throw new Error(`expected ${code}, got success`);
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe(code);
  return err as ApiError;
}

function expectThrowCode(fn: () => unknown, code: string): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe(code);
}

function invariantHolds(b: BudgetAllocation): boolean {
  return b.allocatedUsd + b.reservedUsd + b.spentUsd <= b.limitUsd + 1e-9;
}

const GLOBAL = { kind: 'global' as const, id: null };

describe('budget allocation tree', () => {
  it('root budgets are human-only; children carve from the parent and release returns unused', async () => {
    d = await createTestDaemon();
    const root = await d.call(HUMAN, 'budget.allocate', {
      parentId: null,
      subject: GLOBAL,
      limitUsd: 100,
    });
    expect(root).toMatchObject({
      limitUsd: 100,
      allocatedUsd: 0,
      status: 'active',
      parentId: null,
    });

    const a = await d.call(HUMAN, 'budget.allocate', {
      parentId: root.id,
      subject: { kind: 'task', id: d.ctx.ids.next('task') },
      limitUsd: 30,
    });
    const b = await d.call(HUMAN, 'budget.allocate', {
      parentId: root.id,
      subject: { kind: 'task', id: d.ctx.ids.next('task') },
      limitUsd: 30,
    });
    const tree = await d.call(HUMAN, 'budget.get', { budgetId: root.id });
    expect(tree.budget.allocatedUsd).toBe(60);
    expect(freeUsd(tree.budget)).toBe(40);
    expect(tree.children.map((c) => c.id)).toEqual([a.id, b.id]);

    const err = await expectCode(
      d.call(HUMAN, 'budget.allocate', { parentId: root.id, subject: GLOBAL, limitUsd: 40.01 }),
      'budget_exceeded',
    );
    expect(err.data).toMatchObject({ freeUsd: 40, requestedUsd: 40.01 });

    // A spends 12.5 and finishes: 17.5 goes back; the spent 12.5 stays accounted to A.
    const svc = d.ctx.service('budget');
    svc.recordSpend(a.id, 12.5);
    const releasedA = await d.call(HUMAN, 'budget.release', { budgetId: a.id });
    expect(releasedA).toMatchObject({ status: 'released', spentUsd: 12.5 });
    expect(releasedA.releasedAt).not.toBeNull();
    const after = svc.get(root.id);
    expect(after.allocatedUsd).toBe(42.5);
    expect(freeUsd(after)).toBe(57.5);
    // Released budgets take no more reservations / spend / children; release is idempotent.
    expectThrowCode(() => svc.reserve(a.id, 1), 'conflict');
    expectThrowCode(() => svc.recordSpend(a.id, 1), 'conflict');
    await expectCode(
      d.call(HUMAN, 'budget.allocate', { parentId: a.id, subject: GLOBAL, limitUsd: 1 }),
      'conflict',
    );
    await expect(d.call(HUMAN, 'budget.release', { budgetId: a.id })).resolves.toMatchObject({
      status: 'released',
    });
    expect(svc.get(root.id).allocatedUsd).toBe(42.5);

    const ev = d.ctx.bus.list({ types: ['budget.updated'] }).events as Extract<
      Event,
      { type: 'budget.updated' }
    >[];
    expect(ev.map((e) => e.payload.reason)).toContain('returned_from_child');
    expect(ev.every((e) => invariantHolds(e.payload.budget))).toBe(true);
  });

  it('releasing a budget releases its subtree first so nothing is lost', async () => {
    d = await createTestDaemon();
    const svc = d.ctx.service('budget');
    const root = svc.createRoot({ subject: GLOBAL, limitUsd: 10, actor: HUMAN });
    const mid = svc.allocate({ parentId: root.id, subject: GLOBAL, limitUsd: 6, actor: HUMAN });
    const leaf = svc.allocate({ parentId: mid.id, subject: GLOBAL, limitUsd: 4, actor: HUMAN });
    svc.recordSpend(leaf.id, 1);
    svc.recordSpend(mid.id, 0.5);
    svc.release(mid.id, HUMAN);
    expect(svc.get(leaf.id).status).toBe('released');
    expect(svc.get(mid.id)).toMatchObject({ status: 'released', allocatedUsd: 1, spentUsd: 0.5 });
    // root: 10 limit, 1.5 consumed below it.
    expect(svc.get(root.id).allocatedUsd).toBe(1.5);
    expect(freeUsd(svc.get(root.id))).toBe(8.5);
  });

  it('refuses to release while calls hold reservations', async () => {
    d = await createTestDaemon();
    const svc = d.ctx.service('budget');
    const root = svc.createRoot({ subject: GLOBAL, limitUsd: 10, actor: HUMAN });
    const child = svc.allocate({ parentId: root.id, subject: GLOBAL, limitUsd: 5, actor: HUMAN });
    const r = svc.reserve(child.id, 2);
    expectThrowCode(() => svc.release(root.id, HUMAN), 'conflict');
    // The failed release rolled back completely.
    expect(svc.get(child.id).status).toBe('active');
    expect(svc.get(root.id).status).toBe('active');
    svc.cancelReservation(r);
    svc.release(root.id, HUMAN);
    expect(svc.get(child.id).status).toBe('released');
  });
});

describe('reservations', () => {
  it('reserve -> settle frees the difference; cancel frees everything; double settle conflicts', async () => {
    d = await createTestDaemon();
    const svc = d.ctx.service('budget');
    const b = svc.createRoot({ subject: GLOBAL, limitUsd: 1, actor: HUMAN });
    const r1 = svc.reserve(b.id, 0.3);
    const r2 = svc.reserve(b.id, 0.3);
    expect(svc.get(b.id).reservedUsd).toBe(0.6);
    expectThrowCode(() => svc.reserve(b.id, 0.5), 'budget_exceeded');
    svc.settle(r1, 0.1);
    expect(svc.get(b.id)).toMatchObject({ reservedUsd: 0.3, spentUsd: 0.1 });
    svc.cancelReservation(r2);
    expect(svc.get(b.id)).toMatchObject({ reservedUsd: 0, spentUsd: 0.1 });
    expectThrowCode(() => svc.settle(r1, 0.1), 'conflict');
    expectThrowCode(() => svc.cancelReservation(r2), 'conflict');
    expectThrowCode(
      () => svc.settle({ id: 'rsv_nope', budgetId: b.id, amountUsd: 1 }, 0),
      'invalid_params',
    );
    expectThrowCode(() => svc.reserve(b.id, 0), 'invalid_params');
    expectThrowCode(() => svc.reserve(b.id, Number.NaN), 'invalid_params');
    // Many tiny amounts add up exactly (no float drift).
    for (let i = 0; i < 9; i++) svc.recordSpend(b.id, 0.1);
    expect(svc.get(b.id).spentUsd).toBe(1);
    expectThrowCode(() => svc.reserve(b.id, 0.000001), 'budget_exceeded');
  });

  it('records actual spend above the reservation instead of dropping it', async () => {
    d = await createTestDaemon();
    const svc = d.ctx.service('budget');
    const b = svc.createRoot({ subject: GLOBAL, limitUsd: 1, actor: HUMAN });
    const r = svc.reserve(b.id, 0.9);
    svc.settle(r, 1.2);
    expect(svc.get(b.id)).toMatchObject({ reservedUsd: 0, spentUsd: 1.2 });
    expect(freeUsd(svc.get(b.id))).toBeCloseTo(-0.2);
    expectThrowCode(() => svc.reserve(b.id, 0.01), 'budget_exceeded');
    const last = d.ctx.bus.list({ types: ['budget.updated'] }).events.at(-1) as Extract<
      Event,
      { type: 'budget.updated' }
    >;
    expect(last.payload.reason).toBe('settled_over_budget');
  });

  it('concurrent reservations never oversubscribe (same and separate connections)', async () => {
    d = await createTestDaemon();
    // A second daemon on the same database file = a second SQLite connection.
    const other = await createTestDaemon({ home: d.home });
    try {
      const svcs = [d.ctx.service('budget'), other.ctx.service('budget')];
      const b = svcs[0]!.createRoot({ subject: GLOBAL, limitUsd: 5, actor: HUMAN });
      const attempts = Array.from({ length: 200 }, (_, i) =>
        Promise.resolve().then(() => svcs[i % 2]!.reserve(b.id, 0.07)),
      );
      const results = await Promise.allSettled(attempts);
      const ok = results.filter(
        (r): r is PromiseFulfilledResult<BudgetReservation> => r.status === 'fulfilled',
      );
      const failed = results.filter((r) => r.status === 'rejected');
      expect(ok).toHaveLength(Math.floor(5 / 0.07)); // 71
      for (const f of failed) expect((f.reason as ApiError).code).toBe('budget_exceeded');
      const state = svcs[1]!.get(b.id);
      expect(state.reservedUsd).toBeCloseTo(71 * 0.07, 9);
      expect(invariantHolds(state)).toBe(true);

      // Settle half from one connection, cancel the rest from the other.
      ok.forEach((r, i) =>
        i % 2 === 0 ? svcs[0]!.settle(r.value, 0.05) : svcs[1]!.cancelReservation(r.value),
      );
      const end = svcs[0]!.get(b.id);
      expect(end.reservedUsd).toBe(0);
      expect(end.spentUsd).toBeCloseTo(36 * 0.05, 9);
    } finally {
      await other.close();
    }
  });

  it('cancels reservations left over by a previous process on startup', async () => {
    const first = await createTestDaemon();
    const svc = first.ctx.service('budget');
    const b = svc.createRoot({ subject: GLOBAL, limitUsd: 3, actor: HUMAN });
    svc.reserve(b.id, 2);
    await first.close();
    d = await createTestDaemon({ home: first.home });
    try {
      expect(d.ctx.service('budget').get(b.id).reservedUsd).toBe(0);
      const ev = d.ctx.bus.list({ types: ['budget.updated'] }).events.at(-1) as Extract<
        Event,
        { type: 'budget.updated' }
      >;
      expect(ev.payload.reason).toBe('daemon_restart');
    } finally {
      await d.cleanup();
      first.removeHome();
      d = undefined as unknown as TestDaemonNoServer;
    }
  });
});

describe('agents and budgets', () => {
  it('agents allocate only from budgets they own and cannot create roots', async () => {
    d = await createTestDaemon();
    const session = await d.call(HUMAN, 'session.create', { kind: 'agent' });
    const svc = d.ctx.service('budget');
    const pool = svc.createRoot({ subject: GLOBAL, limitUsd: 100, actor: HUMAN });
    const runBudget = svc.allocate({
      parentId: pool.id,
      subject: { kind: 'session', id: session.id },
      limitUsd: 20,
      actor: HUMAN,
    });
    const run = insertRun(d.ctx, { sessionId: session.id });
    const actor = actorOf(run);
    await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'run', runId: run.id },
      permissions: ['budget.*'],
    });

    await expectCode(
      d.call(actor, 'budget.allocate', { parentId: null, subject: GLOBAL, limitUsd: 1 }),
      'forbidden',
    );
    // Not its budget (the shared pool): cannot raise its own funds from there.
    const e = await expectCode(
      d.call(actor, 'budget.allocate', {
        parentId: pool.id,
        subject: { kind: 'session', id: session.id },
        limitUsd: 50,
      }),
      'forbidden',
    );
    expect(e.message).toMatch(/only allocate from budgets they own/);

    const worker = await d.call(actor, 'budget.allocate', {
      parentId: runBudget.id,
      subject: { kind: 'run', id: d.ctx.ids.next('run') },
      limitUsd: 8,
    });
    await expectCode(
      d.call(actor, 'budget.allocate', { parentId: runBudget.id, subject: GLOBAL, limitUsd: 12.5 }),
      'budget_exceeded',
    );
    // It can read its own budget, the pool above it and the worker budget below it.
    await expect(d.call(actor, 'budget.get', { budgetId: worker.id })).resolves.toBeTruthy();
    await expect(d.call(actor, 'budget.get', { budgetId: pool.id })).resolves.toBeTruthy();
    // ...but not a sibling's.
    const sibling = svc.allocate({ parentId: pool.id, subject: GLOBAL, limitUsd: 1, actor: HUMAN });
    await expectCode(d.call(actor, 'budget.get', { budgetId: sibling.id }), 'forbidden');
    await expectCode(d.call(actor, 'budget.release', { budgetId: sibling.id }), 'forbidden');

    // Releasing the worker budget returns its funds to the agent's budget.
    await d.call(actor, 'budget.release', { budgetId: worker.id });
    expect(freeUsd(svc.get(runBudget.id))).toBe(20);

    const denied = d.ctx.bus
      .list({ types: ['policy.denied'] })
      .events.map((x) => (x.type === 'policy.denied' ? x.payload.permission : ''));
    expect(denied).toEqual(['budget.allocate', 'budget.allocate', 'budget.get', 'budget.release']);
  });

  it("a run's assigned budget (run.budgetId) counts as its own", async () => {
    d = await createTestDaemon();
    const session = await d.call(HUMAN, 'session.create', {});
    const svc = d.ctx.service('budget') as BudgetManager;
    const b = svc.createRoot({ subject: GLOBAL, limitUsd: 5, actor: HUMAN });
    const run = insertRun(d.ctx, { sessionId: session.id, budgetId: b.id });
    const other = insertRun(d.ctx, { sessionId: session.id });
    expect(svc.owns(actorOf(run), b)).toBe(true);
    // Same session, but the budget is tied to the other run, not the session.
    expect(svc.owns(actorOf(other), b)).toBe(false);
  });
});
