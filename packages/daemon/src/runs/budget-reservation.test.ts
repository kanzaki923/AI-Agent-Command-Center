/**
 * Budget reservation around LLM calls (concept §5.1, architecture.md §2.5): chat /
 * orchestrator runs reserve before each model call and settle afterwards, so runs sharing
 * one budget cannot overshoot it; agent runs (cost reported afterwards) are refused once
 * nothing is left.
 */
import type { Event, Run } from '@acc/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { HUMAN, type TestDaemonNoServer, createTestDaemon } from '../testing';

let d: TestDaemonNoServer | undefined;
afterEach(async () => {
  await d?.cleanup();
  d = undefined;
});

const micro = (usd: number) => Math.round(usd * 1e6);

async function chatRun(d: TestDaemonNoServer, model: string, budgetId: string): Promise<Run> {
  const session = await d.call(HUMAN, 'session.create', { model });
  const msg = d.ctx.service('sessions').appendMessage({
    sessionId: session.id,
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    author: HUMAN,
  });
  return d.ctx.service('runs').start({
    sessionId: session.id,
    kind: 'chat',
    createdBy: HUMAN,
    model,
    budgetId,
    triggerMessageId: msg.id,
  });
}

describe('budget reservation', () => {
  it('concurrent runs sharing one budget: a call whose reservation does not fit is refused, nothing overshoots', async () => {
    d = await createTestDaemon();
    await d.call(HUMAN, 'settings.update', { llmCallReserveUsd: 0.05 });
    const budget = d.ctx.service('budget').createRoot({
      subject: { kind: 'global', id: null },
      limitUsd: 0.12,
      actor: HUMAN,
    });
    // Every call costs $0.04 and is held until two calls are in flight at the same time.
    let inFlight = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    d.ctx.service('llm').mock.define('mock/costly', async () => {
      if (++inFlight >= 2) release();
      await both;
      return { text: 'ok', usage: { costUsd: 0.04, costSource: 'reported' } };
    });

    const runs = await Promise.all([1, 2, 3].map(() => chatRun(d!, 'mock/costly', budget.id)));
    const ended = await Promise.all(runs.map((r) => d!.ctx.service('runs').waitForEnd(r.id)));

    // $0.05 + $0.05 reserved leaves $0.02: the third call could not reserve and was refused.
    expect(ended.map((r) => r.status).sort()).toEqual(['completed', 'completed', 'failed']);
    const refused = ended.find((r) => r.status === 'failed')!;
    expect(refused).toMatchObject({
      statusReason: 'budget_exhausted',
      error: { code: 'budget_exceeded' },
    });
    const after = d.ctx.service('budget').get(budget.id);
    expect(after.reservedUsd).toBe(0);
    expect(after.spentUsd).toBeCloseTo(0.08);

    // Both calls held a reservation at once; the third never got one.
    const reservations = d.ctx.db.all<{ status: string; amount_micro: number }>(
      'SELECT status, amount_micro FROM budget_reservations WHERE budget_id = ?',
      [budget.id],
    );
    expect(reservations).toEqual([
      { status: 'settled', amount_micro: micro(0.05) },
      { status: 'settled', amount_micro: micro(0.05) },
    ]);
    // The invariant held at every step: allocated + reserved + spent <= limit. Reservations
    // themselves no longer emit budget.updated (spec 20261029 §2.3); spend does, throttled.
    const updates = d.ctx.bus
      .list({ types: ['budget.updated'], limit: 1000 })
      .events.filter(
        (e): e is Extract<Event, { type: 'budget.updated' }> => e.type === 'budget.updated',
      )
      .map((e) => e.payload);
    expect(updates.map((u) => u.reason)).not.toContain('reserved');
    for (const b of updates.map((u) => u.budget)) {
      expect(micro(b.allocatedUsd) + micro(b.reservedUsd) + micro(b.spentUsd)).toBeLessThanOrEqual(
        micro(b.limitUsd),
      );
    }
  });

  it('a cancelled call frees its reservation', async () => {
    d = await createTestDaemon();
    const budget = d.ctx.service('budget').createRoot({
      subject: { kind: 'global', id: null },
      limitUsd: 1,
      actor: HUMAN,
    });
    // Streams slowly, so the run is cancelled in the middle of the call.
    d.ctx
      .service('llm')
      .mock.define('mock/slow', () => ({ text: 'x'.repeat(4000) }), { chunkDelayMs: 20 });
    const run = await chatRun(d, 'mock/slow', budget.id);
    const budgets = d.ctx.service('budget');
    await expect.poll(() => budgets.get(budget.id).reservedUsd).toBe(0.25);
    d.ctx.service('runs').cancel(run.id, HUMAN);
    await d.ctx.service('runs').waitForEnd(run.id);
    await expect.poll(() => budgets.get(budget.id).reservedUsd).toBe(0);
    expect(budgets.get(budget.id).spentUsd).toBe(0);
  });

  it('an agent run does not start once its budget is used up', async () => {
    d = await createTestDaemon();
    const budgets = d.ctx.service('budget');
    const budget = budgets.createRoot({
      subject: { kind: 'global', id: null },
      limitUsd: 0.1,
      actor: HUMAN,
    });
    budgets.recordSpend(budget.id, 0.1);
    const session = await d.call(HUMAN, 'session.create', { kind: 'agent' });
    const run = d.ctx.service('runs').start({
      sessionId: session.id,
      kind: 'agent',
      createdBy: HUMAN,
      budgetId: budget.id,
    });
    const end = await d.ctx.service('runs').waitForEnd(run.id);
    expect(end).toMatchObject({
      status: 'failed',
      statusReason: 'budget_exhausted',
      error: { code: 'budget_exceeded' },
    });
  });
});
