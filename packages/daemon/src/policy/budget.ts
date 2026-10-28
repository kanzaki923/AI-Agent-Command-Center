import { randomUUID } from 'node:crypto';
import type { Actor, AgentActor, BudgetAllocation, BudgetSubject, EventRefs } from '@acc/protocol';
import type { BudgetReservation, BudgetService } from '../contracts';
import type { DaemonContext } from '../core/context';
import { budgetExceeded, conflict, forbidden, invalidParams } from '../core/errors';

/**
 * Amounts are kept as integer micro-dollars internally so that many small reservations
 * never drift (0.1 + 0.2 !== 0.3) and the invariant check is exact.
 */
const MICRO = 1_000_000;
const toMicro = (usd: number) => Math.round(usd * MICRO);
const fromMicro = (m: number) => m / MICRO;

interface ReservationRow {
  id: string;
  budget_id: string;
  amount_micro: number;
  status: 'pending' | 'settled' | 'cancelled';
}

/** Free amount: limit - allocated - reserved - spent (may be negative after an overrun). */
export function freeMicro(b: BudgetAllocation): number {
  return (
    toMicro(b.limitUsd) - toMicro(b.allocatedUsd) - toMicro(b.reservedUsd) - toMicro(b.spentUsd)
  );
}

export function freeUsd(b: BudgetAllocation): number {
  return fromMicro(freeMicro(b));
}

const SYSTEM_ACTOR: Actor = { kind: 'system', component: 'budget' };

/**
 * Budget tree (architecture.md §2.5), `ctx.service('budget')`.
 *
 * Invariant: allocated + reserved + spent <= limit, checked inside a `BEGIN IMMEDIATE`
 * transaction that re-reads the row, so concurrent reservations (even from another
 * connection to the same database) cannot oversubscribe a budget. The one exception is
 * actual spend that exceeds what was reserved: money already spent is recorded as is
 * (the budget then has no free amount left) rather than dropped.
 *
 * Release returns the free amount to the parent; the spent part stays counted in the
 * parent's `allocatedUsd` (it was given to that child and consumed).
 */
export class BudgetManager implements BudgetService {
  constructor(private readonly ctx: DaemonContext) {}

  get(budgetId: string): BudgetAllocation {
    return this.ctx.repos.budgets.require(budgetId);
  }

  children(budgetId: string): BudgetAllocation[] {
    return this.ctx.repos.budgets.find({ where: { parent_id: budgetId }, direction: 'asc' });
  }

  createRoot(input: { subject: BudgetSubject; limitUsd: number; actor: Actor }): BudgetAllocation {
    if (input.actor.kind === 'agent') {
      throw forbidden('only humans can create root budgets; allocate from a budget you own');
    }
    this.assertAmount(input.limitUsd, 'limitUsd', true);
    const { ctx } = this;
    return ctx.db.transaction(() => {
      const now = ctx.clock.iso();
      const budget = ctx.repos.budgets.insert({
        id: ctx.ids.next('budget'),
        parentId: null,
        subject: input.subject,
        status: 'active',
        limitUsd: fromMicro(toMicro(input.limitUsd)),
        allocatedUsd: 0,
        reservedUsd: 0,
        spentUsd: 0,
        createdBy: input.actor,
        createdAt: now,
        updatedAt: now,
        releasedAt: null,
      });
      this.emit(budget, input.actor, 'created');
      return budget;
    });
  }

  allocate(input: {
    parentId: string;
    subject: BudgetSubject;
    limitUsd: number;
    actor: Actor;
  }): BudgetAllocation {
    this.assertAmount(input.limitUsd, 'limitUsd', true);
    const { ctx } = this;
    return ctx.db.transaction(() => {
      const parent = ctx.repos.budgets.require(input.parentId);
      if (input.actor.kind === 'agent' && !this.owns(input.actor, parent)) {
        throw forbidden(
          `agents can only allocate from budgets they own (their run, session or task); budget ${parent.id} is not theirs`,
        );
      }
      this.assertActive(parent);
      const amount = toMicro(input.limitUsd);
      const free = freeMicro(parent);
      if (amount > free) {
        throw budgetExceeded(
          `budget ${parent.id} has $${fromMicro(Math.max(0, free))} unallocated; cannot allocate $${fromMicro(amount)}`,
          {
            budgetId: parent.id,
            freeUsd: fromMicro(Math.max(0, free)),
            requestedUsd: fromMicro(amount),
          },
        );
      }
      const now = ctx.clock.iso();
      const nextParent = ctx.repos.budgets.update(parent.id, (b) => ({
        ...b,
        allocatedUsd: fromMicro(toMicro(b.allocatedUsd) + amount),
        updatedAt: now,
      }));
      const child = ctx.repos.budgets.insert({
        id: ctx.ids.next('budget'),
        parentId: parent.id,
        subject: input.subject,
        status: 'active',
        limitUsd: fromMicro(amount),
        allocatedUsd: 0,
        reservedUsd: 0,
        spentUsd: 0,
        createdBy: input.actor,
        createdAt: now,
        updatedAt: now,
        releasedAt: null,
      });
      this.emit(nextParent, input.actor, 'allocated_to_child');
      this.emit(child, input.actor, 'allocated');
      return child;
    });
  }

  release(budgetId: string, actor: Actor): BudgetAllocation {
    const { ctx } = this;
    return ctx.db.transaction(() => {
      const budget = ctx.repos.budgets.require(budgetId);
      if (actor.kind === 'agent') {
        const parent = budget.parentId ? ctx.repos.budgets.get(budget.parentId) : undefined;
        if (!this.owns(actor, budget) && !(parent && this.owns(actor, parent))) {
          throw forbidden(
            `agents can only release their own budgets or budgets they allocated; budget ${budget.id} is neither`,
          );
        }
      }
      return this.releaseTree(budget, actor);
    });
  }

  private releaseTree(budget: BudgetAllocation, actor: Actor): BudgetAllocation {
    const { ctx } = this;
    if (budget.status === 'released') return budget;
    // Children first, so their unused amounts flow back up before this one is computed.
    for (const child of this.children(budget.id)) {
      if (child.status === 'active') this.releaseTree(child, actor);
    }
    const current = ctx.repos.budgets.require(budget.id);
    if (toMicro(current.reservedUsd) > 0) {
      throw conflict(
        `budget ${budget.id} has $${current.reservedUsd} reserved by in-flight calls; settle or cancel them first`,
        { budgetId: budget.id, reservedUsd: current.reservedUsd },
      );
    }
    const unused = Math.max(0, freeMicro(current));
    const now = ctx.clock.iso();
    const released = ctx.repos.budgets.update(budget.id, (b) => ({
      ...b,
      status: 'released',
      updatedAt: now,
      releasedAt: now,
    }));
    this.emit(released, actor, 'released');
    if (current.parentId) {
      const parent = ctx.repos.budgets.update(current.parentId, (b) => ({
        ...b,
        allocatedUsd: fromMicro(Math.max(0, toMicro(b.allocatedUsd) - unused)),
        updatedAt: now,
      }));
      this.emit(parent, actor, 'returned_from_child');
    }
    return released;
  }

  reserve(budgetId: string, amountUsd: number): BudgetReservation {
    this.assertAmount(amountUsd, 'amountUsd', true);
    const { ctx } = this;
    return ctx.db.transaction(() => {
      const budget = ctx.repos.budgets.require(budgetId);
      this.assertActive(budget);
      const amount = toMicro(amountUsd);
      const free = freeMicro(budget);
      if (amount > free) {
        throw budgetExceeded(
          `budget ${budget.id} has $${fromMicro(Math.max(0, free))} left; cannot reserve $${fromMicro(amount)}`,
          {
            budgetId: budget.id,
            freeUsd: fromMicro(Math.max(0, free)),
            requestedUsd: fromMicro(amount),
          },
        );
      }
      const id = `rsv_${randomUUID()}`;
      ctx.db.run(
        'INSERT INTO budget_reservations (id, budget_id, amount_micro, status, created_at) VALUES (?, ?, ?, ?, ?)',
        [id, budget.id, amount, 'pending', ctx.clock.iso()],
      );
      const next = this.adjust(budget.id, { reserved: amount });
      this.emit(next, SYSTEM_ACTOR, 'reserved');
      return { id, budgetId: budget.id, amountUsd: fromMicro(amount) };
    });
  }

  settle(reservation: BudgetReservation, actualUsd: number): void {
    this.assertAmount(actualUsd, 'actualUsd', false);
    const { ctx } = this;
    ctx.db.transaction(() => {
      const row = this.takeReservation(reservation, 'settled');
      const next = this.adjust(row.budget_id, {
        reserved: -row.amount_micro,
        spent: toMicro(actualUsd),
      });
      this.emit(next, SYSTEM_ACTOR, freeMicro(next) < 0 ? 'settled_over_budget' : 'settled');
    });
  }

  cancelReservation(reservation: BudgetReservation): void {
    const { ctx } = this;
    ctx.db.transaction(() => {
      const row = this.takeReservation(reservation, 'cancelled');
      const next = this.adjust(row.budget_id, { reserved: -row.amount_micro });
      this.emit(next, SYSTEM_ACTOR, 'reservation_cancelled');
    });
  }

  recordSpend(budgetId: string, amountUsd: number): void {
    this.assertAmount(amountUsd, 'amountUsd', false);
    if (toMicro(amountUsd) === 0) return;
    const { ctx } = this;
    ctx.db.transaction(() => {
      const budget = ctx.repos.budgets.require(budgetId);
      this.assertActive(budget);
      const next = this.adjust(budget.id, { spent: toMicro(amountUsd) });
      this.emit(next, SYSTEM_ACTOR, freeMicro(next) < 0 ? 'spent_over_budget' : 'spent');
    });
  }

  /**
   * Startup: no call can still be in flight, so pending reservations left by a previous
   * process are cancelled and their amounts freed.
   */
  cancelStaleReservations(): number {
    const { ctx } = this;
    const rows = ctx.db.all<ReservationRow>(
      "SELECT * FROM budget_reservations WHERE status = 'pending'",
    );
    for (const r of rows) {
      ctx.db.transaction(() => {
        ctx.db.run("UPDATE budget_reservations SET status = 'cancelled' WHERE id = ?", [r.id]);
        const next = this.adjust(r.budget_id, { reserved: -r.amount_micro });
        this.emit(next, SYSTEM_ACTOR, 'daemon_restart');
      });
    }
    return rows.length;
  }

  // -------------------------------------------------------------------------
  // Ownership (agents)
  // -------------------------------------------------------------------------

  /**
   * Whether a budget belongs to an agent: it is its run's budget (`run.budgetId`) or its
   * subject is the agent's run, session, or the task the run/session works on.
   */
  owns(actor: AgentActor, budget: BudgetAllocation): boolean {
    const { repos } = this.ctx;
    const run = repos.runs.get(actor.runId);
    if (run?.budgetId === budget.id) return true;
    const { kind, id } = budget.subject;
    if (kind === 'run') return id === actor.runId;
    if (kind === 'session') return id === actor.sessionId;
    if (kind === 'task' && id) {
      const session = repos.sessions.get(actor.sessionId);
      return run?.taskId === id || session?.taskId === id;
    }
    return false;
  }

  /** Budgets an agent may read: its own, anything below them, and their ancestors. */
  canView(actor: AgentActor, budget: BudgetAllocation): boolean {
    const { repos } = this.ctx;
    // Walking up from `budget`: one of them owned => budget is owned or below an owned one.
    for (
      let b: BudgetAllocation | undefined = budget;
      b;
      b = b.parentId ? repos.budgets.get(b.parentId) : undefined
    ) {
      if (this.owns(actor, b)) return true;
    }
    // Ancestor of an owned budget (e.g. the orchestrator's pool above a worker budget).
    const owned = this.ownedBudgets(actor);
    for (const o of owned) {
      for (
        let b: BudgetAllocation | undefined = o;
        b;
        b = b.parentId ? repos.budgets.get(b.parentId) : undefined
      ) {
        if (b.id === budget.id) return true;
      }
    }
    return false;
  }

  private ownedBudgets(actor: AgentActor): BudgetAllocation[] {
    const { repos } = this.ctx;
    const run = repos.runs.get(actor.runId);
    const session = repos.sessions.get(actor.sessionId);
    const found = new Map<string, BudgetAllocation>();
    const add = (bs: BudgetAllocation[]) => bs.forEach((b) => found.set(b.id, b));
    add(repos.budgets.find({ where: { subject_kind: 'run', subject_id: actor.runId } }));
    add(repos.budgets.find({ where: { subject_kind: 'session', subject_id: actor.sessionId } }));
    for (const taskId of new Set([run?.taskId, session?.taskId])) {
      if (taskId) add(repos.budgets.find({ where: { subject_kind: 'task', subject_id: taskId } }));
    }
    if (run?.budgetId) {
      const b = repos.budgets.get(run.budgetId);
      if (b) add([b]);
    }
    return [...found.values()];
  }

  // -------------------------------------------------------------------------

  private assertAmount(v: number, name: string, positive: boolean): void {
    if (!Number.isFinite(v) || v < 0 || (positive && toMicro(v) <= 0)) {
      throw invalidParams(
        `${name} must be a ${positive ? 'positive' : 'non-negative'} amount (USD)`,
      );
    }
  }

  private assertActive(b: BudgetAllocation): void {
    if (b.status !== 'active') throw conflict(`budget ${b.id} has been released`);
  }

  private takeReservation(r: BudgetReservation, to: 'settled' | 'cancelled'): ReservationRow {
    const row = this.ctx.db.get<ReservationRow>('SELECT * FROM budget_reservations WHERE id = ?', [
      r.id,
    ]);
    if (!row) throw invalidParams(`unknown budget reservation: ${r.id}`);
    if (row.status !== 'pending')
      throw conflict(`budget reservation ${r.id} is already ${row.status}`);
    this.ctx.db.run('UPDATE budget_reservations SET status = ? WHERE id = ?', [to, r.id]);
    return row;
  }

  private adjust(budgetId: string, d: { reserved?: number; spent?: number }): BudgetAllocation {
    const now = this.ctx.clock.iso();
    return this.ctx.repos.budgets.update(budgetId, (b) => ({
      ...b,
      reservedUsd: fromMicro(Math.max(0, toMicro(b.reservedUsd) + (d.reserved ?? 0))),
      spentUsd: fromMicro(toMicro(b.spentUsd) + (d.spent ?? 0)),
      updatedAt: now,
    }));
  }

  private emit(budget: BudgetAllocation, actor: Actor, reason: string): void {
    this.ctx.bus.emit({
      type: 'budget.updated',
      actor,
      payload: { budget, reason },
      refs: refsForSubject(budget.subject),
    });
  }
}

function refsForSubject(s: BudgetSubject): Partial<EventRefs> {
  if (!s.id) return {};
  switch (s.kind) {
    case 'project':
      return { projectId: s.id };
    case 'session':
      return { sessionId: s.id };
    case 'run':
      return { runId: s.id };
    case 'task':
      return { taskId: s.id };
    case 'global':
      return {};
  }
}
