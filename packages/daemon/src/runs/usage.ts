import type {
  Actor,
  BudgetAllocation,
  CostSource,
  ErrorInfo,
  LedgerComponent,
  Run,
  Usage,
} from '@acc/protocol';
import type {
  BudgetHold,
  BudgetReservation,
  BudgetService,
  UsageReportOptions,
} from '../contracts';
import type { DaemonContext } from '../core/context';
import { ApiError, budgetExceeded } from '../core/errors';

const MICRO = 1_000_000;
const micro = (usd: number) => Math.round(usd * MICRO);

/** Unallocated, unreserved, unspent amount of a budget, in integer micro-dollars. */
export function remainingMicroUsd(b: BudgetAllocation): number {
  return micro(b.limitUsd) - micro(b.allocatedUsd) - micro(b.reservedUsd) - micro(b.spentUsd);
}

const COST_RANK: Record<CostSource, number> = { unknown: 0, estimated: 1, reported: 2 };

/**
 * Sum usage. The cost source of the total is the weakest of its parts (one unknown call
 * makes the total a lower bound), except that the first report replaces the empty default.
 * `signed` allows negative parts (a correction); totals never go below zero.
 */
export function mergeUsage(
  cur: Usage,
  delta: Partial<Usage>,
  first: boolean,
  signed = false,
): Usage {
  let costSource = cur.costSource;
  if (delta.costSource) {
    costSource =
      first || COST_RANK[delta.costSource] < COST_RANK[cur.costSource]
        ? delta.costSource
        : cur.costSource;
  }
  const part = (v: number | undefined) => (signed ? (v ?? 0) : Math.max(0, v ?? 0));
  return {
    inputTokens: Math.max(0, cur.inputTokens + Math.round(part(delta.inputTokens))),
    outputTokens: Math.max(0, cur.outputTokens + Math.round(part(delta.outputTokens))),
    costUsd: Math.max(0, (micro(cur.costUsd) + micro(part(delta.costUsd))) / MICRO),
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
  /** The run's budget (or the day's limit) is used up: stop it (failed, see `budgetStop`). */
  stopForBudget(runId: string): void;
  /** Runs that hold an execution slot or wait for one (to stop a whole tree or every agent). */
  activeRunIds(): string[];
}

/** Why a run was stopped for money: its budget tree, or the day's limit. */
export type BudgetStopReason = 'budget_exhausted' | 'daily_limit';

/** Estimated usage of a run not yet replaced by a final report. */
interface PendingEstimate {
  costMicro: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * What a run may still spend in USD, for runtimes that stop themselves (Claude
 * `maxBudgetUsd`, which counts only the current query()'s spend, also on resume): the lower
 * of its budget's room (capped by an over-limit ancestor) and what is left today. Null: no
 * cap. Zero or less: nothing left.
 */
export function spendCapUsd(ctx: DaemonContext, run: Run): number | null {
  const caps: number[] = [];
  if (run.budgetId && ctx.hasService('budget')) {
    caps.push(ctx.service('budget').available(run.budgetId).freeUsd);
  }
  const daily = ctx.hasService('ledger') ? ctx.service('ledger').dailyLeft() : null;
  if (daily !== null) caps.push(daily);
  return caps.length === 0 ? null : Math.min(...caps);
}

/**
 * Usage and budget accounting of running runs (architecture.md §2.5, §2.6, §2.17), split out of
 * the run manager so the Cost track (T5) owns it: `RunController.reportUsage`,
 * `reserveBudget` / `BudgetHold.settle` and `assertBudgetLeft` all come here, and every usage
 * recorded on a run also goes to the usage ledger (`ledger.record`, in the same transaction) —
 * the single place Session.cost is fed from.
 *
 * - Estimates (`phase: 'estimate'`) count at once (run, ledger, budget) so limits act while a
 *   runtime is still working; the next final report replaces them: the difference goes to the
 *   ledger as an `adjust` row (negative allowed) and to the budget (`adjustSpend`).
 * - The daily limit is checked before every LLM call and after every report; once reached,
 *   every running agent is stopped (`daily_limit`).
 * - A budget whose ancestor is over its limit has no room either; when that happens, every
 *   run below that ancestor is stopped.
 */
export class UsageAccountant {
  private readonly estimates = new WeakMap<UsageRun, PendingEstimate>();
  /** Why a run was stopped by `stopForBudget` (read when it is finalized). */
  private readonly stopReasons = new Map<string, BudgetStopReason>();

  constructor(
    private readonly ctx: DaemonContext,
    private readonly host: UsageHost,
  ) {}

  /** RunController.reportUsage. */
  report(a: UsageRun, delta: Partial<Usage>, actor: Actor, opts: UsageReportOptions = {}): void {
    const base: LedgerComponent = a.run.kind === 'agent' ? 'agent' : 'llm';
    if (opts.component === 'classifier') {
      this.book(a, { ...delta, costSource: delta.costSource ?? 'estimated' }, actor, 'classifier');
    } else if (opts.phase === 'estimate') {
      const p = this.estimates.get(a) ?? { costMicro: 0, inputTokens: 0, outputTokens: 0 };
      p.costMicro += micro(Math.max(0, delta.costUsd ?? 0));
      p.inputTokens += Math.max(0, Math.round(delta.inputTokens ?? 0));
      p.outputTokens += Math.max(0, Math.round(delta.outputTokens ?? 0));
      this.estimates.set(a, p);
      this.book(a, { ...delta, costSource: delta.costSource ?? 'estimated' }, actor, base);
    } else {
      const p = this.estimates.get(a);
      this.estimates.delete(a);
      if (!p) {
        this.book(a, delta, actor, base);
      } else {
        // The final figure covers the estimated calls: book only the difference.
        let cost = micro(Math.max(0, delta.costUsd ?? 0)) - p.costMicro;
        // A runtime that could not price the model guessed too: keep the higher estimate.
        if (delta.costSource === 'unknown' && cost < 0) cost = 0;
        this.book(
          a,
          {
            inputTokens: Math.round(delta.inputTokens ?? 0) - p.inputTokens,
            outputTokens: Math.round(delta.outputTokens ?? 0) - p.outputTokens,
            costUsd: cost / MICRO,
            ...(delta.costSource ? { costSource: delta.costSource } : {}),
          },
          actor,
          'adjust',
        );
      }
    }
    this.checkDaily(a);
  }

  /** Record on the run and the ledger, then book the cost on the run's budget. */
  private book(a: UsageRun, delta: Partial<Usage>, actor: Actor, component: LedgerComponent): void {
    const run = this.record(a, delta, actor, component);
    const cost = delta.costUsd ?? 0;
    if (!run.budgetId || !this.ctx.hasService('budget') || micro(cost) === 0) return;
    if (component === 'adjust') {
      this.spend(a, run.budgetId, (b, id) => b.adjustSpend(id, cost));
    } else if (cost > 0) {
      this.spend(a, run.budgetId, (b, id) => b.recordSpend(id, cost));
    }
  }

  /** RunController.assertBudgetLeft (and the day's limit). */
  assertBudgetLeft(a: UsageRun): void {
    if (this.ctx.hasService('ledger')) this.ctx.service('ledger').assertDailyLeft(a.run.sessionId);
    const budgetId = a.run.budgetId;
    if (!budgetId || !this.ctx.hasService('budget')) return;
    const budget = this.ctx.service('budget');
    if (budget.get(budgetId).status !== 'active') {
      throw budgetExceeded('予算が返却されているため、これ以上実行できません', { budgetId });
    }
    if (micro(budget.available(budgetId).freeUsd) <= 0) {
      throw budgetExceeded('予算の上限に達したため、これ以上実行できません', { budgetId });
    }
  }

  /** Add usage to the run (run.updated `["usage"]`) and to the usage ledger. */
  record(
    a: UsageRun,
    delta: Partial<Usage>,
    actor: Actor,
    component: LedgerComponent = a.run.kind === 'agent' ? 'agent' : 'llm',
  ): Run {
    const { ctx } = this;
    const first = !a.usageReported;
    a.usageReported = true;
    const signed = component === 'adjust';
    const run = ctx.db.transaction(() => {
      const next = ctx.repos.runs.update(a.runId, (r) => ({
        ...r,
        usage: mergeUsage(r.usage, delta, first, signed),
        updatedAt: ctx.clock.iso(),
      }));
      ctx.bus.emit({ type: 'run.updated', actor, payload: { run: next, changes: ['usage'] } });
      if (ctx.hasService('ledger')) {
        const clamp = (v: number | undefined) => (signed ? (v ?? 0) : Math.max(0, v ?? 0));
        ctx.service('ledger').record({
          sessionId: next.sessionId,
          runId: next.id,
          projectId: next.projectId,
          model: next.model,
          component,
          costUsd: clamp(delta.costUsd),
          inputTokens: clamp(delta.inputTokens),
          outputTokens: clamp(delta.outputTokens),
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
   * is left afterwards. When an ancestor is the one over its limit, the runs below it stop too.
   */
  spend(
    a: UsageRun,
    budgetId: string,
    book: (budget: BudgetService, budgetId: string) => void,
  ): void {
    const budget = this.ctx.service('budget');
    let exhausted: boolean;
    let limitedBy = budgetId;
    try {
      book(budget, budgetId);
      const room = budget.available(budgetId);
      exhausted = micro(room.freeUsd) <= 0;
      limitedBy = room.limitedBy;
    } catch (err) {
      // Fail closed: a run whose spend cannot be booked (budget released, gone) must not go
      // on spending unaccounted. Its usage is already on the run.
      exhausted = true;
      if (!(err instanceof ApiError && err.code === 'budget_exceeded')) {
        this.ctx.log.error('failed to record run spend; stopping the run', { runId: a.runId, err });
      }
    }
    if (!exhausted) return;
    this.stop(a.runId, 'budget_exhausted');
    if (limitedBy !== budgetId) {
      for (const id of this.host.activeRunIds()) {
        const other = this.ctx.repos.runs.get(id);
        if (other?.budgetId && this.isUnder(other.budgetId, limitedBy)) {
          this.stop(id, 'budget_exhausted');
        }
      }
    }
  }

  /** Whether `budgetId` is `ancestorId` or below it. */
  private isUnder(budgetId: string, ancestorId: string): boolean {
    const seen = new Set<string>();
    for (
      let b = this.ctx.repos.budgets.get(budgetId);
      b && !seen.has(b.id);
      b = b.parentId ? this.ctx.repos.budgets.get(b.parentId) : undefined
    ) {
      if (b.id === ancestorId) return true;
      seen.add(b.id);
    }
    return false;
  }

  /** After a report: once today's limit is reached, notify and stop every running agent. */
  private checkDaily(a: UsageRun): void {
    if (this.host.isDetached() || !this.ctx.hasService('ledger')) return;
    const ledger = this.ctx.service('ledger');
    try {
      ledger.assertDailyLeft(a.run.sessionId);
      return;
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'budget_exceeded')) throw err;
    }
    for (const id of this.host.activeRunIds()) {
      if (this.ctx.repos.runs.get(id)?.kind === 'agent') this.stop(id, 'daily_limit');
    }
  }

  private stop(runId: string, reason: BudgetStopReason): void {
    if (!this.stopReasons.has(runId)) this.stopReasons.set(runId, reason);
    this.host.stopForBudget(runId);
  }

  /**
   * Status reason and error of a run that ended for money: stopped here, or refused with
   * `budget_exceeded` (e.g. by a reservation or a runtime's own cap). Forgets the run.
   */
  budgetStop(runId: string, error?: unknown): { reason: BudgetStopReason; error: ErrorInfo } {
    let reason = this.stopReasons.get(runId);
    this.stopReasons.delete(runId);
    if (!reason) {
      const data =
        error instanceof ApiError ? (error.data as { reason?: unknown } | undefined) : undefined;
      const left = this.ctx.hasService('ledger') ? this.ctx.service('ledger').dailyLeft() : null;
      const daily = data?.reason === 'daily_limit' || (left !== null && left <= 0);
      reason = daily ? 'daily_limit' : 'budget_exhausted';
    }
    if (error instanceof ApiError)
      return { reason, error: { code: error.code, message: error.message } };
    return {
      reason,
      error: {
        code: 'budget_exceeded',
        message:
          reason === 'daily_limit'
            ? '今日の費用の上限に達したため停止しました'
            : '予算の上限に達したため停止しました',
      },
    };
  }

  /** RunController.reserveBudget (architecture.md §2.6). */
  reserve(a: UsageRun, actor: Actor, estimateUsd?: number): BudgetHold {
    const { ctx } = this;
    if (ctx.hasService('ledger')) ctx.service('ledger').assertDailyLeft(a.run.sessionId);
    const report = (usage: Partial<Usage>) => {
      if (this.host.isDetached()) return null;
      const run = this.record(a, usage, actor);
      this.checkDaily(a);
      return run;
    };
    const budgetId = a.run.budgetId;
    if (!budgetId || !ctx.hasService('budget')) {
      return { amountUsd: 0, settle: (u) => void report(u), cancel: () => {} };
    }
    const budget = ctx.service('budget');
    const left = micro(budget.available(budgetId).freeUsd);
    if (left <= 0) {
      throw budgetExceeded('予算の上限に達したため、LLM を呼び出せません', { budgetId });
    }
    const amount = Math.max(0, estimateUsd ?? ctx.settings.get().llmCallReserveUsd);
    if (micro(amount) <= 0) {
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
          `予算の残り（$${(left / MICRO).toFixed(4)}）が、LLM の 1 回の呼び出しに確保する額（$${amount}）に足りないため呼び出せません`,
          { budgetId, freeUsd: left / MICRO, reserveUsd: amount },
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
