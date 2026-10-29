import {
  type Actor,
  type Artifact,
  type ErrorCode,
  type Params,
  type Schedule,
  type ScheduleLastRun,
  type ScheduleOutcome,
  type Session,
  type SystemActor,
  RECOVERABLE_RUN_STATUSES,
} from '@acc/protocol';
import type { SchedulerService, SpawnOptions, SpawnerService } from '../contracts';
import type { DaemonContext } from '../core/context';
import { isApiError } from '../core/errors';
import { freeUsd } from '../policy/budget';
import { firingLabel, planDue } from './time';

/** Who starts the children of firings (`startedBy: schedule` in the home view). */
export const SCHEDULER_ACTOR: SystemActor = { kind: 'system', component: 'scheduler' };

/** How much of the previous firing's main output is attached to the request. */
export const PREVIOUS_OUTPUT_CHARS = 4_000;
const MAX_GOAL_CHARS = 50_000;
const MAX_TITLE_CHARS = 80;
/** setTimeout's longest delay; a later nextRunAt is reached by re-arming. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The one timer the scheduler arms (injectable so tests can drive time). */
export interface TimerHost {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: TimerHost = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface SchedulerOptions {
  /** Spawner used for firings (default: the `spawner` service). */
  spawner?: (ctx: DaemonContext) => SpawnerService;
  timers?: TimerHost;
}

/** Result of one firing, with the reason when it did not start a child. */
export interface FireResult {
  sessionId: string | null;
  outcome: ScheduleOutcome;
  error: string | null;
  /** Error code of the failure (failed_to_start), for schedule.runNow. */
  code: ErrorCode | null;
}

const ACTIVE_RUN_STATUSES = ['created', ...RECOVERABLE_RUN_STATUSES] as const;
/** Task statuses of a child that has not finished its work yet (waiting to start or running). */
const ACTIVE_TASK_STATUSES = ['pending', 'ready', 'running'] as const;

/**
 * Fires schedules (architecture.md §2.18, spec §3.11). One timer for the nearest `nextRunAt`
 * (no polling); firings and catch-up run one at a time so the overlap check and the spawn
 * cannot interleave.
 */
export class Scheduler implements SchedulerService {
  private readonly timers: TimerHost;
  private timer: unknown = null;
  /** When the armed timer is due (ms), for tests and diagnostics. */
  armedFor: number | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly ctx: DaemonContext,
    private readonly opts: SchedulerOptions = {},
  ) {
    this.timers = opts.timers ?? realTimers;
  }

  private spawner(): SpawnerService {
    return this.opts.spawner?.(this.ctx) ?? this.ctx.service('spawner');
  }

  // -------------------------------------------------------------------------
  // Timer
  // -------------------------------------------------------------------------

  /** Re-arm the single timer for the nearest nextRunAt of an enabled schedule. */
  rearm(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.armedFor = null;
    if (this.closed) return;
    const [soonest] = this.ctx.repos.schedules.find({
      where: { enabled: true, next_run_at: { not: null } },
      orderBy: 'next_run_at',
      direction: 'asc',
      limit: 1,
    });
    if (!soonest?.nextRunAt) return;
    const at = Date.parse(soonest.nextRunAt);
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, at - this.ctx.clock.now()));
    this.armedFor = at;
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.armedFor = null;
      void this.runDue();
    }, delay);
  }

  /**
   * Handle every schedule whose time has come, then re-arm. Called by the timer, at startup
   * and after waking from sleep (a late timer applies the catch-up rule at that moment).
   */
  runDue(): Promise<void> {
    return this.enqueue(() => this.processDue());
  }

  /** Resolves once queued firings have finished (tests). */
  async idle(): Promise<void> {
    for (;;) {
      const current = this.chain;
      await current;
      if (current === this.chain) return;
    }
  }

  start(): void {
    void this.runDue();
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.rearm();
    // Let an in-flight firing record its outcome, without holding shutdown for long.
    await Promise.race([this.chain, new Promise((r) => setTimeout(r, 5_000).unref())]);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async processDue(): Promise<void> {
    try {
      const nowMs = this.ctx.clock.now();
      const due = this.ctx.repos.schedules.find({
        where: { enabled: true },
        sql: {
          clause: 'next_run_at IS NOT NULL AND next_run_at <= ?',
          params: [new Date(nowMs).toISOString()],
        },
        orderBy: 'next_run_at',
        direction: 'asc',
      });
      for (const s of due) {
        if (this.closed) return;
        try {
          await this.handleDue(s, nowMs);
        } catch (err) {
          this.ctx.log.error('schedule firing failed', { scheduleId: s.id, err });
        }
      }
    } finally {
      this.rearm();
    }
  }

  private async handleDue(s: Schedule, nowMs: number): Promise<void> {
    const plan = planDue(s, nowMs);
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    // Move nextRunAt before spawning: a crash mid-firing skips it rather than firing it twice.
    this.ctx.db.transaction(() => {
      const missed: ScheduleLastRun | null =
        plan.missed === null
          ? null
          : {
              scheduledFor: iso(plan.missed)!,
              firedAt: new Date(nowMs).toISOString(),
              sessionId: null,
              outcome: 'missed',
              error: null,
            };
      const next = this.ctx.repos.schedules.update(s.id, (cur) => ({
        ...cur,
        nextRunAt: iso(plan.nextRunAt),
        lastRun: missed ?? cur.lastRun,
        updatedAt: this.ctx.clock.iso(),
      }));
      this.emitUpdated(next, missed ? ['nextRunAt', 'lastRun'] : ['nextRunAt']);
      if (missed) this.emitFired(next, missed);
    });
    if (plan.fire !== null) await this.fireNow(s.id, iso(plan.fire)!);
  }

  // -------------------------------------------------------------------------
  // Firing
  // -------------------------------------------------------------------------

  /** Fire once for `scheduledFor` (regular times unchanged). Queued behind other firings. */
  async fire(
    scheduleId: string,
    scheduledFor: string,
  ): Promise<{ sessionId: string | null; outcome: ScheduleOutcome }> {
    const r = await this.fireDetailed(scheduleId, scheduledFor);
    return { sessionId: r.sessionId, outcome: r.outcome };
  }

  fireDetailed(scheduleId: string, scheduledFor: string): Promise<FireResult> {
    return this.enqueue(() => this.fireNow(scheduleId, scheduledFor));
  }

  private async fireNow(scheduleId: string, scheduledFor: string): Promise<FireResult> {
    const s = this.ctx.repos.schedules.require(scheduleId);
    const result = await this.tryStart(s, scheduledFor);
    const firedAt = this.ctx.clock.iso();
    this.ctx.db.transaction(() => {
      if (!this.ctx.repos.schedules.get(s.id)) return; // deleted meanwhile
      const lastRun: ScheduleLastRun = {
        scheduledFor,
        firedAt,
        sessionId: result.sessionId,
        outcome: result.outcome,
        error: result.error,
      };
      const next = this.ctx.repos.schedules.update(s.id, (cur) => ({
        ...cur,
        lastRun,
        updatedAt: firedAt,
      }));
      this.emitUpdated(next, ['lastRun']);
      this.emitFired(next, lastRun);
    });
    if (result.outcome === 'failed_to_start') {
      this.ctx.log.warn('schedule did not start', { scheduleId: s.id, error: result.error });
    }
    return result;
  }

  private async tryStart(s: Schedule, scheduledFor: string): Promise<FireResult> {
    const fail = (error: string, code: ErrorCode): FireResult => ({
      sessionId: null,
      outcome: 'failed_to_start',
      error,
      code,
    });
    const owner = this.ctx.repos.sessions.get(s.sessionId);
    if (!owner) return fail('持ち主の会話がありません', 'not_found');
    if (owner.archivedAt) return fail('持ち主の会話はアーカイブされています', 'conflict');

    const previous = this.childrenOf(s, 5);
    if (previous[0] && this.isUnfinished(previous[0].id)) {
      return {
        sessionId: null,
        outcome: 'skipped_overlap',
        error: '前回の実行がまだ終わっていません',
        code: 'conflict',
      };
    }

    const budget = this.budgetFor(s);
    if ('error' in budget) {
      if (budget.budgetId) this.openBudgetAttention(s, budget.sessionId, budget.budgetId);
      return fail(budget.error, 'budget_exceeded');
    }
    try {
      this.ctx.service('ledger').assertDailyLeft();
    } catch (err) {
      return fail(isApiError(err) ? err.message : '今日の上限に達しています', 'budget_exceeded');
    }

    const params = this.spawnParams(s, owner, scheduledFor, previous);
    const opts: SpawnOptions = {
      scheduleId: s.id,
      scheduledFor,
      trigger: 'schedule',
      budget: budget.budget,
      supervise: s.run.supervise,
    };
    try {
      const res = await this.spawner().spawn(params, SCHEDULER_ACTOR, opts);
      return { sessionId: res.session.id, outcome: 'started', error: null, code: null };
    } catch (err) {
      const code = isApiError(err) ? err.code : 'internal';
      if (code === 'budget_exceeded' && budget.budget.parentBudgetId) {
        this.openBudgetAttention(s, budget.sessionId, budget.budget.parentBudgetId);
      }
      return fail(err instanceof Error ? err.message : String(err), code);
    }
  }

  /**
   * Budget of one firing (§3.11): an AI-made schedule carves `budgetUsd` from its creator
   * session's budget each time; a human-made one gets a root budget (within the daily limit).
   * An AI that never had a session budget fires with a root budget too (its human gave it
   * the schedule permission without one; the daily limit still holds).
   */
  private budgetFor(
    s: Schedule,
  ):
    | { budget: NonNullable<SpawnOptions['budget']>; sessionId: string | null }
    | { error: string; budgetId: string | null; sessionId: string | null } {
    const limitUsd = s.run.budgetUsd;
    if (s.createdBy.kind !== 'agent') {
      return { budget: { parentBudgetId: null, limitUsd }, sessionId: null };
    }
    const creator = s.createdBy.sessionId;
    const own = this.ctx.repos.budgets.findOne({
      where: { subject_kind: 'session', subject_id: creator },
      orderBy: 'created_at',
      direction: 'desc',
    });
    if (!own) return { budget: { parentBudgetId: null, limitUsd }, sessionId: creator };
    if (own.status !== 'active') {
      return { error: '作った AI の予算はもう使えません', budgetId: null, sessionId: creator };
    }
    if (freeUsd(own) + 1e-9 < limitUsd) {
      return {
        error: `予算が足りません（1 回 $${limitUsd}、空き $${freeUsd(own).toFixed(2)}）`,
        budgetId: own.id,
        sessionId: creator,
      };
    }
    return { budget: { parentBudgetId: own.id, limitUsd }, sessionId: creator };
  }

  private openBudgetAttention(s: Schedule, sessionId: string | null, budgetId: string): void {
    try {
      this.ctx.service('attention').open({
        kind: 'budget',
        sessionId: sessionId ?? s.sessionId,
        title: truncate(`「${s.title}」を始める予算が足りません`, MAX_TITLE_CHARS),
        detail: `繰り返しの 1 回ぶん（$${s.run.budgetUsd}）を予算から出せませんでした。`,
        refs: { budgetId },
        actor: SCHEDULER_ACTOR,
      });
    } catch (err) {
      this.ctx.log.warn('failed to open budget attention for a schedule', { err });
    }
  }

  /** Request of one firing: the prompt, plus the previous firing's main output. */
  spawnParams(
    s: Schedule,
    owner: Session,
    scheduledFor: string,
    previousChildren: Session[] = this.childrenOf(s, 5),
  ): Params<'session.spawn'> {
    const tz = s.trigger.kind === 'cron' ? s.trigger.tz : this.ctx.settings.get().limits.timezone;
    const label = firingLabel(Date.parse(scheduledFor), tz);
    const suffix = ` · ${label}`;
    const title = truncate(s.title, MAX_TITLE_CHARS - suffix.length) + suffix;
    let goal = s.prompt;
    if (s.run.includePrevious) {
      const prev = this.previousOutput(previousChildren, tz);
      if (prev) goal = `${goal}\n\n---\n${prev}`;
    }
    const workspace = s.run.mode === 'agent' ? s.run.workspace : undefined;
    const projectId =
      owner.projectId ?? (workspace?.kind === 'worktree' ? workspace.projectId : undefined);
    return {
      parentSessionId: owner.id,
      title,
      goal: truncate(goal, MAX_GOAL_CHARS),
      mode: s.run.mode,
      ...(workspace ? { workspace } : {}),
      ...(projectId ? { projectId } : {}),
      ...(s.run.model ? { model: s.run.model } : {}),
      budgetUsd: s.run.budgetUsd,
      reviewBy: 'none',
      start: true,
    };
  }

  /** "前回（11/4 9:00）の成果物「…」:" and the start of its content, or null. */
  private previousOutput(children: Session[], tz: string): string | null {
    for (const child of children) {
      const artifact = this.mainOutput(child.id);
      if (!artifact) continue;
      const at = firingLabel(Date.parse(child.createdAt), tz);
      const body = truncate(artifactExcerpt(artifact), PREVIOUS_OUTPUT_CHARS);
      return `前回（${at}）の成果物「${artifact.title}」:\n${body}`;
    }
    return null;
  }

  /** The child's newest output (evidence such as commits and test results is skipped). */
  private mainOutput(sessionId: string): Artifact | null {
    return (
      this.ctx.repos.artifacts
        .find({ where: { session_id: sessionId }, orderBy: 'created_at', direction: 'desc' })
        .find((a) => a.role === 'output') ?? null
    );
  }

  /** Children this schedule's firings created, newest first. */
  childrenOf(s: Pick<Schedule, 'id' | 'sessionId'>, limit: number): Session[] {
    return this.ctx.repos.sessions.find({
      where: { parent_session_id: s.sessionId },
      sql: { clause: "json_extract(data, '$.scheduleId') = ?", params: [s.id] },
      orderBy: 'created_at',
      direction: 'desc',
      limit,
    });
  }

  /**
   * Whether a firing's child (or anything it started) is still working or waiting to start.
   * A child that ended — done, failed, waiting for a person — does not block the next firing.
   */
  isUnfinished(sessionId: string): boolean {
    const { repos } = this.ctx;
    const ids = [sessionId];
    for (let i = 0; i < ids.length && ids.length < 500; i++) {
      for (const c of repos.sessions.find({ where: { parent_session_id: ids[i]! } })) {
        ids.push(c.id);
      }
    }
    const runs = repos.runs.find({
      where: { session_id: ids, status: [...ACTIVE_RUN_STATUSES] },
      limit: 1,
    });
    if (runs.length > 0) return true;
    return (
      repos.tasks.find({
        where: { assignee_session_id: ids, status: [...ACTIVE_TASK_STATUSES] },
        limit: 1,
      }).length > 0
    );
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  emitUpdated(schedule: Schedule, changes: string[], actor: Actor = SCHEDULER_ACTOR): void {
    this.ctx.bus.emit({
      type: 'schedule.updated',
      actor,
      payload: { schedule, changes },
      refs: { sessionId: schedule.sessionId },
    });
  }

  private emitFired(schedule: Schedule, run: ScheduleLastRun): void {
    this.ctx.bus.emit({
      type: 'schedule.fired',
      actor: SCHEDULER_ACTOR,
      payload: {
        scheduleId: schedule.id,
        sessionId: run.sessionId,
        scheduledFor: run.scheduledFor,
        outcome: run.outcome,
      },
      refs: { sessionId: schedule.sessionId },
    });
  }
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Plain-text start of an artifact, for attaching it to the next firing's request. */
export function artifactExcerpt(a: Artifact): string {
  switch (a.kind) {
    case 'document':
      return a.data.content;
    case 'note':
      return a.data.text;
    case 'data': {
      const cell = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
      const lines = [a.data.columns.join(','), ...a.data.rows.map((r) => r.map(cell).join(','))];
      let out = '';
      for (const line of lines) {
        if (out.length > PREVIOUS_OUTPUT_CHARS) break;
        out += `${line}\n`;
      }
      return out.trimEnd();
    }
    case 'link':
      return a.data.label ? `${a.data.label} ${a.data.url}` : a.data.url;
    case 'files':
      return a.data.files.map((f) => f.path).join('\n');
    case 'diff':
      return a.data.patch;
    case 'file':
      return a.data.content ?? a.data.path;
    case 'commit':
      return a.data.message;
    case 'test_result':
      return a.data.summary;
  }
}
