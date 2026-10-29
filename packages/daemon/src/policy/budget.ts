import { randomUUID } from 'node:crypto';
import {
  type Actor,
  type AgentActor,
  type BudgetAllocation,
  type BudgetSubject,
  type EventRefs,
  RunStatus,
  isTerminalRunStatus,
} from '@acc/protocol';
import type { BudgetReservation, BudgetService } from '../contracts';
import type { DaemonContext } from '../core/context';
import { budgetExceeded, conflict, forbidden, invalidParams } from '../core/errors';
import { KeyedThrottle } from '../cost/throttle';

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

/** `budget.threshold` percentages (of the limit, spend of the budget and its descendants). */
const THRESHOLDS = [50, 80, 100] as const;

/** Changes of `reserved` / `spent` applied by `applySpend`. */
interface SpendDelta {
  reserved?: number;
  spent?: number;
}

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
 *
 * Overruns are carried up (spec 20261029 §3.8-6): whatever a budget spends beyond its limit is
 * added to its parent's `allocatedUsd`, and so on to the root, so a parent always accounts
 * for what its children really consumed. A budget can spend only while it and every ancestor
 * have room (`available`): once the root is over, the whole tree stops.
 *
 * Events: `budget.updated` for create / allocate / release / raise, and for spend at most
 * once a second per budget (not for reservations); `budget.threshold` when the spend of a
 * budget and its descendants crosses 50 / 80 / 100 % of its limit.
 */
export class BudgetManager implements BudgetService {
  /** Spend-driven budget.updated, at most once a second per budget (spec §2.3). */
  private readonly spendEvents: KeyedThrottle;

  constructor(private readonly ctx: DaemonContext) {
    this.spendEvents = new KeyedThrottle(ctx.clock);
    ctx.onClose(() => {
      this.spendEvents.flush();
      this.spendEvents.close();
    });
  }

  /** Emit pending spend updates now (tests). */
  flushEvents(): void {
    this.spendEvents.flush();
  }

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
    // Agent runtimes book their cost afterwards (no reservation), and orchestrator / chat runs
    // hold none between calls: a budget is in use for as long as a run on it has not ended.
    const user = ctx.repos.runs
      .find({ where: { status: RunStatus.options.filter((s) => !isTerminalRunStatus(s)) } })
      .find((r) => r.budgetId === budget.id);
    if (user) {
      throw conflict(
        `budget ${budget.id} is in use by run ${user.id}; cancel the run or wait for it to end first`,
        { budgetId: budget.id, runId: user.id },
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
      const free = this.availableMicro(budget).free;
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
      this.applySpend(budget.id, { reserved: amount });
      return { id, budgetId: budget.id, amountUsd: fromMicro(amount) };
    });
  }

  settle(reservation: BudgetReservation, actualUsd: number): void {
    this.assertAmount(actualUsd, 'actualUsd', false);
    const { ctx } = this;
    ctx.db.transaction(() => {
      const row = this.takeReservation(reservation, 'settled');
      this.applySpend(
        row.budget_id,
        { reserved: -row.amount_micro, spent: toMicro(actualUsd) },
        'settled',
      );
    });
  }

  cancelReservation(reservation: BudgetReservation): void {
    const { ctx } = this;
    ctx.db.transaction(() => {
      const row = this.takeReservation(reservation, 'cancelled');
      this.applySpend(row.budget_id, { reserved: -row.amount_micro });
    });
  }

  recordSpend(budgetId: string, amountUsd: number): void {
    this.assertAmount(amountUsd, 'amountUsd', false);
    if (toMicro(amountUsd) === 0) return;
    const { ctx } = this;
    ctx.db.transaction(() => {
      const budget = ctx.repos.budgets.require(budgetId);
      this.assertActive(budget);
      this.applySpend(budget.id, { spent: toMicro(amountUsd) }, 'spent');
    });
  }

  adjustSpend(budgetId: string, deltaUsd: number): void {
    if (!Number.isFinite(deltaUsd)) throw invalidParams('deltaUsd must be a finite amount (USD)');
    const delta = toMicro(deltaUsd);
    if (delta === 0) return;
    const { ctx } = this;
    ctx.db.transaction(() => {
      const budget = ctx.repos.budgets.require(budgetId);
      // Spend never goes below zero.
      const d = Math.max(delta, -toMicro(budget.spentUsd));
      if (budget.status === 'released') {
        // Its consumed part already sits in the parent's allocation: move that with it.
        this.applySpend(budget.id, { spent: d }, 'adjusted', { carry: false });
        this.carryOver(budget.parentId, d);
        return;
      }
      this.applySpend(budget.id, { spent: d }, 'adjusted');
    });
  }

  raise(budgetId: string, addUsd: number, actor: Actor): BudgetAllocation {
    if (actor.kind === 'agent') throw forbidden('予算を増やせるのは人間だけです');
    this.assertAmount(addUsd, 'addUsd', true);
    const { ctx } = this;
    return ctx.db.transaction(() => {
      const budget = ctx.repos.budgets.require(budgetId);
      this.assertActive(budget);
      return this.raiseBy(budget, toMicro(addUsd), actor);
    });
  }

  /**
   * Raise `budget`'s limit by `add` micro-dollars. A child takes from its parent what its
   * overrun does not already cover (an overrun was carried up into the parent's allocation),
   * raising the parent first when it has not enough free.
   */
  private raiseBy(budget: BudgetAllocation, add: number, actor: Actor): BudgetAllocation {
    const { ctx } = this;
    const now = ctx.clock.iso();
    if (budget.parentId) {
      const covered = Math.min(add, Math.max(0, -freeMicro(budget)));
      const need = add - covered;
      let parent = ctx.repos.budgets.require(budget.parentId);
      this.assertActive(parent);
      const free = this.availableMicro(parent).free;
      if (need > free) parent = this.raiseBy(parent, need - Math.max(0, free), actor);
      // `covered` moves from "carried overrun" to "allocated within the limit": no change.
      if (need > 0) {
        parent = ctx.repos.budgets.update(parent.id, (b) => ({
          ...b,
          allocatedUsd: fromMicro(toMicro(b.allocatedUsd) + need),
          updatedAt: now,
        }));
        this.emit(parent, actor, 'allocated_to_child');
      }
    }
    const raised = ctx.repos.budgets.update(budget.id, (b) => ({
      ...b,
      limitUsd: fromMicro(toMicro(b.limitUsd) + add),
      updatedAt: now,
    }));
    this.emit(raised, actor, 'raised');
    return raised;
  }

  /**
   * Set a budget's limit (`session.setBudget`). Raising goes through `raise`; lowering gives
   * the difference back to the parent (never below what is already committed).
   */
  setLimit(budgetId: string, limitUsd: number, actor: Actor): BudgetAllocation {
    if (actor.kind === 'agent') throw forbidden('予算を変えられるのは人間だけです');
    this.assertAmount(limitUsd, 'limitUsd', true);
    const { ctx } = this;
    return ctx.db.transaction(() => {
      const budget = ctx.repos.budgets.require(budgetId);
      this.assertActive(budget);
      const target = toMicro(limitUsd);
      const cur = toMicro(budget.limitUsd);
      if (target === cur) return budget;
      if (target > cur) return this.raiseBy(budget, target - cur, actor);
      const committed = cur - Math.max(0, freeMicro(budget));
      const next = Math.max(target, committed);
      const give = cur - next;
      if (give <= 0) return budget;
      const now = ctx.clock.iso();
      if (budget.parentId) {
        const parent = ctx.repos.budgets.update(budget.parentId, (b) => ({
          ...b,
          allocatedUsd: fromMicro(Math.max(0, toMicro(b.allocatedUsd) - give)),
          updatedAt: now,
        }));
        this.emit(parent, actor, 'returned_from_child');
      }
      const lowered = ctx.repos.budgets.update(budget.id, (b) => ({
        ...b,
        limitUsd: fromMicro(next),
        updatedAt: now,
      }));
      this.emit(lowered, actor, 'lowered');
      return lowered;
    });
  }

  available(budgetId: string): { freeUsd: number; limitedBy: string } {
    const r = this.availableMicro(this.ctx.repos.budgets.require(budgetId));
    return { freeUsd: fromMicro(r.free), limitedBy: r.limitedBy };
  }

  /** Own free, capped by any ancestor that is over its limit. */
  private availableMicro(budget: BudgetAllocation): { free: number; limitedBy: string } {
    let free = freeMicro(budget);
    let limitedBy = budget.id;
    const seen = new Set([budget.id]);
    for (
      let p = budget.parentId ? this.ctx.repos.budgets.get(budget.parentId) : undefined;
      p && !seen.has(p.id);
      p = p.parentId ? this.ctx.repos.budgets.get(p.parentId) : undefined
    ) {
      seen.add(p.id);
      const pf = freeMicro(p);
      if (pf < 0 && pf < free) {
        free = pf;
        limitedBy = p.id;
      }
    }
    return { free, limitedBy };
  }

  reallocate(budgetId: string, actor: Actor): BudgetAllocation | null {
    const { ctx } = this;
    return ctx.db.transaction(() => {
      const budget = ctx.repos.budgets.require(budgetId);
      if (budget.status === 'active') return budget;
      if (!budget.parentId) return null;
      const parent = ctx.repos.budgets.get(budget.parentId);
      if (!parent || parent.status !== 'active') return null;
      const amount = Math.min(toMicro(budget.limitUsd), this.availableMicro(parent).free);
      if (amount <= 0) return null;
      return this.allocate({
        parentId: parent.id,
        subject: budget.subject,
        limitUsd: fromMicro(amount),
        actor,
      });
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
        // Rare and worth seeing (unlike a reservation of a live call).
        const next = this.applySpend(r.budget_id, { reserved: -r.amount_micro });
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

  /**
   * Change a budget's reserved / spent amounts, carry an overrun change up to the parent,
   * announce crossed thresholds, and (for spend, when `reason` is given) a throttled
   * budget.updated. Reservations alone emit nothing.
   */
  private applySpend(
    budgetId: string,
    d: SpendDelta,
    reason?: string,
    opts: { carry?: boolean } = {},
  ): BudgetAllocation {
    const { ctx } = this;
    const now = ctx.clock.iso();
    const before = ctx.repos.budgets.require(budgetId);
    const next = ctx.repos.budgets.update(budgetId, (b) => ({
      ...b,
      reservedUsd: fromMicro(Math.max(0, toMicro(b.reservedUsd) + (d.reserved ?? 0))),
      spentUsd: fromMicro(Math.max(0, toMicro(b.spentUsd) + (d.spent ?? 0))),
      updatedAt: now,
    }));
    if (opts.carry !== false && next.status === 'active') {
      const overBefore = Math.max(0, -freeMicro(before));
      const overAfter = Math.max(0, -freeMicro(next));
      this.carryOver(next.parentId, overAfter - overBefore);
    }
    const spent = toMicro(next.spentUsd) - toMicro(before.spentUsd);
    if (spent > 0) this.announceThresholds(next, spent);
    if (reason && spent !== 0) {
      const id = next.id;
      this.spendEvents.touch(
        id,
        () => this.emit(next, SYSTEM_ACTOR, freeMicro(next) < 0 ? `${reason}_over_budget` : reason),
        () =>
          ctx.db.transaction(() => {
            const latest = ctx.repos.budgets.get(id);
            if (latest) this.emit(latest, SYSTEM_ACTOR, 'spent');
          }),
      );
    }
    return next;
  }

  /** Add a child's overrun change to the parent's allocation, and on up while it overflows. */
  private carryOver(parentId: string | null, delta: number): void {
    if (!parentId || delta === 0) return;
    const { ctx } = this;
    const before = ctx.repos.budgets.get(parentId);
    if (!before) return;
    const next = ctx.repos.budgets.update(parentId, (b) => ({
      ...b,
      allocatedUsd: fromMicro(Math.max(0, toMicro(b.allocatedUsd) + delta)),
      updatedAt: ctx.clock.iso(),
    }));
    const overBefore = Math.max(0, -freeMicro(before));
    const overAfter = Math.max(0, -freeMicro(next));
    this.carryOver(next.parentId, overAfter - overBefore);
  }

  /** Spend of a budget and all its descendants (released ones included), in micro-dollars. */
  treeSpentMicro(budget: BudgetAllocation, seen = new Set<string>()): number {
    if (seen.has(budget.id)) return 0;
    seen.add(budget.id);
    let n = toMicro(budget.spentUsd);
    for (const c of this.children(budget.id)) n += this.treeSpentMicro(c, seen);
    return n;
  }

  /** `budget.threshold` for this budget and each ancestor whose tree spend crossed a mark. */
  private announceThresholds(budget: BudgetAllocation, added: number): void {
    const seen = new Set<string>();
    for (
      let b: BudgetAllocation | undefined = budget;
      b && !seen.has(b.id);
      b = b.parentId ? this.ctx.repos.budgets.get(b.parentId) : undefined
    ) {
      seen.add(b.id);
      const limit = toMicro(b.limitUsd);
      if (limit <= 0) continue;
      const after = this.treeSpentMicro(b);
      const before = after - added;
      for (const pct of THRESHOLDS) {
        const mark = (limit * pct) / 100;
        if (before < mark && after >= mark) {
          this.ctx.bus.emit({
            type: 'budget.threshold',
            actor: SYSTEM_ACTOR,
            payload: { budgetId: b.id, rootSessionId: this.rootSessionOf(b), pct },
            refs: refsForSubject(b.subject),
          });
        }
      }
    }
  }

  /** The session tree a budget belongs to (its subject's session), if any. */
  private rootSessionOf(b: BudgetAllocation): string | null {
    const { repos } = this.ctx;
    const { kind, id } = b.subject;
    if (!id) return null;
    const sessionId =
      kind === 'session'
        ? id
        : kind === 'run'
          ? repos.runs.get(id)?.sessionId
          : kind === 'task'
            ? repos.tasks.get(id)?.assigneeSessionId
            : null;
    return sessionId ? (repos.sessions.get(sessionId)?.rootSessionId ?? null) : null;
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
