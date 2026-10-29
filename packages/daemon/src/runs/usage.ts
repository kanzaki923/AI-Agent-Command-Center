import type { Actor, BudgetAllocation, CostSource, Run, Usage } from '@acc/protocol';
import type { BudgetHold, BudgetReservation, BudgetService } from '../contracts';
import type { DaemonContext } from '../core/context';
import { ApiError, budgetExceeded } from '../core/errors';

/** Unallocated, unreserved, unspent amount of a budget, in integer micro-dollars. */
export function remainingMicroUsd(b: BudgetAllocation): number {
  const micro = (usd: number) => Math.round(usd * 1_000_000);
  return micro(b.limitUsd) - micro(b.allocatedUsd) - micro(b.reservedUsd) - micro(b.spentUsd);
}

const COST_RANK: Record<CostSource, number> = { unknown: 0, estimated: 1, reported: 2 };

/**
 * Sum usage. The cost source of the total is the weakest of its parts (one unknown call
 * makes the total a lower bound), except that the first report replaces the empty default.
 */
export function mergeUsage(cur: Usage, delta: Partial<Usage>, first: boolean): Usage {
  let costSource = cur.costSource;
  if (delta.costSource) {
    costSource =
      first || COST_RANK[delta.costSource] < COST_RANK[cur.costSource]
        ? delta.costSource
        : cur.costSource;
  }
  return {
    inputTokens: cur.inputTokens + Math.max(0, Math.round(delta.inputTokens ?? 0)),
    outputTokens: cur.outputTokens + Math.max(0, Math.round(delta.outputTokens ?? 0)),
    costUsd: cur.costUsd + Math.max(0, delta.costUsd ?? 0),
    costSource,
  };
}

/** The part of an active run the accountant reads and updates. */
export interface UsageRun {
  readonly runId: string;
  run: Run;
  usageReported: boolean;
  /** Budget reservations of in-flight LLM calls (cancelled if the run ends first). */
  readonly reservations: Set<BudgetReservation>;
}

/** What the accountant needs from the run manager. */
export interface UsageHost {
  /** True once shutdown finished: late executor callbacks must not touch the (closed) DB. */
  isDetached(): boolean;
  /** The run's budget is used up: stop it (failed, budget_exhausted). */
  stopForBudget(runId: string): void;
}

/**
 * Usage and budget accounting of running runs (architecture.md §2.5, §2.6), split out of the
 * run manager so the Cost track (T5) owns it: `RunController.reportUsage`,
 * `reserveBudget` / `BudgetHold.settle` and `assertBudgetLeft` all come here, and every
 * usage recorded on a run also goes to the usage ledger (`ledger.record`, in the same
 * transaction) — the single place Session.cost is fed from.
 */
export class UsageAccountant {
  constructor(
    private readonly ctx: DaemonContext,
    private readonly host: UsageHost,
  ) {}

  /** RunController.reportUsage: add usage, then book its cost as spend on the run's budget. */
  report(a: UsageRun, delta: Partial<Usage>, actor: Actor): void {
    const run = this.record(a, delta, actor);
    const cost = delta.costUsd ?? 0;
    if (cost > 0 && run.budgetId && this.ctx.hasService('budget')) {
      this.spend(a, run.budgetId, (budget, id) => budget.recordSpend(id, cost));
    }
  }

  /** RunController.assertBudgetLeft. */
  assertBudgetLeft(a: UsageRun): void {
    const budgetId = a.run.budgetId;
    if (!budgetId || !this.ctx.hasService('budget')) return;
    const budget = this.ctx.service('budget').get(budgetId);
    if (budget.status !== 'active') {
      throw budgetExceeded('予算が返却されているため、これ以上実行できません', { budgetId });
    }
    if (remainingMicroUsd(budget) <= 0) {
      throw budgetExceeded('予算の上限に達したため、これ以上実行できません', { budgetId });
    }
  }

  /** Add usage to the run (run.updated `["usage"]`) and to the usage ledger. */
  record(a: UsageRun, delta: Partial<Usage>, actor: Actor): Run {
    const { ctx } = this;
    const first = !a.usageReported;
    a.usageReported = true;
    const run = ctx.db.transaction(() => {
      const next = ctx.repos.runs.update(a.runId, (r) => ({
        ...r,
        usage: mergeUsage(r.usage, delta, first),
        updatedAt: ctx.clock.iso(),
      }));
      ctx.bus.emit({ type: 'run.updated', actor, payload: { run: next, changes: ['usage'] } });
      if (ctx.hasService('ledger')) {
        ctx.service('ledger').record({
          sessionId: next.sessionId,
          runId: next.id,
          projectId: next.projectId,
          model: next.model,
          component: next.kind === 'agent' ? 'agent' : 'llm',
          costUsd: Math.max(0, delta.costUsd ?? 0),
          inputTokens: delta.inputTokens ?? 0,
          outputTokens: delta.outputTokens ?? 0,
          source: delta.costSource ?? 'unknown',
        });
      }
      return next;
    });
    a.run = run;
    return run;
  }

  /**
   * Book spend on the run's budget and stop the run once nothing is left. Spending keeps the
   * fact even past the limit (it does not throw for that), so exhaustion is judged from what
   * is left afterwards.
   */
  spend(
    a: UsageRun,
    budgetId: string,
    book: (budget: BudgetService, budgetId: string) => void,
  ): void {
    const budget = this.ctx.service('budget');
    let exhausted: boolean;
    try {
      book(budget, budgetId);
      exhausted = remainingMicroUsd(budget.get(budgetId)) <= 0;
    } catch (err) {
      // Fail closed: a run whose spend cannot be booked (budget released, gone) must not go
      // on spending unaccounted. Its usage is already on the run.
      exhausted = true;
      if (!(err instanceof ApiError && err.code === 'budget_exceeded')) {
        this.ctx.log.error('failed to record run spend; stopping the run', { runId: a.runId, err });
      }
    }
    if (exhausted) this.host.stopForBudget(a.runId);
  }

  /** RunController.reserveBudget (architecture.md §2.6). */
  reserve(a: UsageRun, actor: Actor, estimateUsd?: number): BudgetHold {
    const { ctx } = this;
    const report = (usage: Partial<Usage>) => {
      if (this.host.isDetached()) return null;
      return this.record(a, usage, actor);
    };
    const budgetId = a.run.budgetId;
    if (!budgetId || !ctx.hasService('budget')) {
      return { amountUsd: 0, settle: (u) => void report(u), cancel: () => {} };
    }
    const budget = ctx.service('budget');
    const left = remainingMicroUsd(budget.get(budgetId));
    if (left <= 0) {
      throw budgetExceeded('予算の上限に達したため、LLM を呼び出せません', { budgetId });
    }
    const amount = Math.max(0, estimateUsd ?? ctx.settings.get().llmCallReserveUsd);
    if (Math.round(amount * 1_000_000) <= 0) {
      // Reservations switched off: book the cost afterwards like reportUsage.
      return {
        amountUsd: 0,
        settle: (u) => {
          const cost = u.costUsd ?? 0;
          if (report(u) && cost > 0) this.spend(a, budgetId, (b, id) => b.recordSpend(id, cost));
        },
        cancel: () => {},
      };
    }
    let reservation: BudgetReservation;
    try {
      reservation = budget.reserve(budgetId, amount);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'budget_exceeded') {
        throw budgetExceeded(
          `予算の残り（$${(left / 1_000_000).toFixed(4)}）が、LLM の 1 回の呼び出しに確保する額（$${amount}）に足りないため呼び出せません`,
          { budgetId, freeUsd: left / 1_000_000, reserveUsd: amount },
        );
      }
      throw err;
    }
    a.reservations.add(reservation);
    let done = false;
    const take = (): boolean => {
      if (done) return false;
      done = true;
      // Already cancelled when the run ended before its executor settled.
      return a.reservations.delete(reservation) && !this.host.isDetached();
    };
    return {
      amountUsd: reservation.amountUsd,
      settle: (u) => {
        if (done || this.host.isDetached()) return;
        const cost = Math.max(0, u.costUsd ?? 0);
        if (!take()) {
          // The run was force-cleaned up (its reservation cancelled) while this call was in
          // flight. The provider still charged it: book the fact on the run and the budget.
          report(u);
          if (cost > 0) this.spend(a, budgetId, (b, id) => b.recordSpend(id, cost));
          return;
        }
        report(u);
        this.spend(a, budgetId, (b) => b.settle(reservation, cost));
      },
      cancel: () => {
        if (!take()) return;
        try {
          budget.cancelReservation(reservation);
        } catch (err) {
          ctx.log.error('failed to cancel budget reservation', { runId: a.runId, err });
        }
      },
    };
  }
}
