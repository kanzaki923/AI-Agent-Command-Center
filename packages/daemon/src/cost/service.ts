import {
  COST_ATTENTION_CHOICES,
  type Actor,
  type CostSource,
  type DailySpend,
  EMPTY_SESSION_COST,
  type SessionCost,
  type SystemActor,
} from '@acc/protocol';
import type { LedgerEntry, LedgerService } from '../contracts';
import type { DaemonContext } from '../core/context';
import { budgetExceeded, forbidden } from '../core/errors';
import { LedgerStore, dayOf, fromMicro, toMicro, weakestSource } from './ledger';
import { KeyedThrottle } from './throttle';

export const COST_SYSTEM: SystemActor = { kind: 'system', component: 'cost' };

/** `data.reason` of the budget_exceeded error the daily limit raises. */
export const DAILY_LIMIT = 'daily_limit';

const usd = (n: number) => `$${Number(n.toFixed(2))}`;

/**
 * The usage ledger (spec 20261029 §1.10, §3.8; architecture.md §2.17), `ctx.service('ledger')`.
 *
 * - `record` appends one row and adds it to `Session.cost` of the session (`ownUsd`, `treeUsd`)
 *   and every ancestor (`treeUsd`) in the caller's transaction: the ledger is the only writer of
 *   Session.cost. `session.cost_updated` is emitted at most once a second per session.
 * - The daily limit (`settings.limits.dailyUsd`, plus what `cost.raiseDaily` added for today)
 *   is checked before LLM calls and after every usage report. Reaching it emits
 *   `cost.limit_reached` and opens one `budget` attention for the day.
 */
export class UsageLedger implements LedgerService {
  readonly store: LedgerStore;
  private readonly events: KeyedThrottle;
  private closed = false;

  constructor(private readonly ctx: DaemonContext) {
    this.store = new LedgerStore(ctx.db);
    this.events = new KeyedThrottle(ctx.clock);
  }

  // ------------------------------------------------------------------ recording

  record(entry: LedgerEntry): void {
    const { ctx } = this;
    const micro = toMicro(entry.costUsd);
    const input = Math.round(entry.inputTokens ?? 0);
    const output = Math.round(entry.outputTokens ?? 0);
    if (micro === 0 && input === 0 && output === 0) return;
    const ts = entry.ts ?? ctx.clock.iso();
    const session = entry.sessionId ? ctx.repos.sessions.get(entry.sessionId) : undefined;
    ctx.db.transaction(() => {
      this.store.insert({
        ts,
        day: dayOf(ts, ctx.settings.get().limits.timezone),
        session_id: entry.sessionId,
        root_session_id: session?.rootSessionId ?? null,
        project_id: entry.projectId ?? session?.projectId ?? null,
        run_id: entry.runId,
        model: entry.model ?? null,
        component: entry.component,
        cost_micro: micro,
        input_tokens: input,
        output_tokens: output,
        source: entry.source,
      });
      if (session) this.addToSessions(session.id, micro, entry.source);
    });
  }

  /** Add to the session's own and tree spend, and to every ancestor's tree spend. */
  private addToSessions(sessionId: string, micro: number, source: CostSource): void {
    const { ctx } = this;
    const seen = new Set<string>();
    for (
      let s = ctx.repos.sessions.get(sessionId), own = true;
      s && !seen.has(s.id);
      s = s.parentSessionId ? ctx.repos.sessions.get(s.parentSessionId) : undefined, own = false
    ) {
      seen.add(s.id);
      const cur = s.cost ?? EMPTY_SESSION_COST;
      const empty = cur.ownUsd === 0 && cur.treeUsd === 0 && cur.source === 'unknown';
      const next: SessionCost = {
        ownUsd: own ? fromMicro(toMicro(cur.ownUsd) + micro) : cur.ownUsd,
        treeUsd: fromMicro(toMicro(cur.treeUsd) + micro),
        source: empty ? source : weakestSource(cur.source, source),
      };
      ctx.db.run(`UPDATE sessions SET data = json_set(data, '$.cost', json(?)) WHERE id = ?`, [
        JSON.stringify(next),
        s.id,
      ]);
      const id = s.id;
      const rootSessionId = s.rootSessionId;
      this.events.touch(
        id,
        () => this.emitCost(id, rootSessionId, next),
        () =>
          ctx.db.transaction(() => {
            const latest = ctx.repos.sessions.get(id);
            if (latest) this.emitCost(id, latest.rootSessionId, latest.cost);
          }),
      );
    }
  }

  private emitCost(sessionId: string, rootSessionId: string, cost: SessionCost): void {
    this.ctx.bus.emit({
      type: 'session.cost_updated',
      actor: COST_SYSTEM,
      payload: { sessionId, rootSessionId, ...cost },
      refs: { sessionId },
    });
  }

  /** Emit pending `session.cost_updated` now (tests, shutdown). */
  flushEvents(): void {
    this.events.flush();
  }

  close(): void {
    this.closed = true;
    this.events.flush();
    this.events.close();
  }

  // ------------------------------------------------------------------ daily limit

  today(): string {
    return dayOf(this.ctx.clock.iso(), this.ctx.settings.get().limits.timezone);
  }

  usedToday(): number {
    return fromMicro(this.store.dayTotalMicro(this.today()));
  }

  private raisedMicro(day: string): number {
    return (
      this.ctx.db.get<{ extra_micro: number }>(
        'SELECT extra_micro FROM cost_daily_raises WHERE day = ?',
        [day],
      )?.extra_micro ?? 0
    );
  }

  daily(): DailySpend {
    const day = this.today();
    const setting = this.ctx.settings.get().limits.dailyUsd;
    const raised = this.raisedMicro(day);
    return {
      limitUsd: setting === null ? null : fromMicro(toMicro(setting) + raised),
      usedTodayUsd: fromMicro(this.store.dayTotalMicro(day)),
      raisedTodayUsd: fromMicro(raised),
      day,
    };
  }

  dailyLeft(): number | null {
    const d = this.daily();
    return d.limitUsd === null ? null : fromMicro(toMicro(d.limitUsd) - toMicro(d.usedTodayUsd));
  }

  /**
   * Refuse when today's limit is used up. `sessionId` names where it was hit (the attention
   * is shown there); the notice itself is sent outside the caller's transaction.
   */
  assertDailyLeft(sessionId?: string | null): void {
    const d = this.daily();
    if (d.limitUsd === null || toMicro(d.usedTodayUsd) < toMicro(d.limitUsd)) return;
    queueMicrotask(() => this.notifyDailyLimit(sessionId ?? null));
    throw budgetExceeded(
      `今日の費用の上限（${usd(d.limitUsd)}）に達したため、これ以上実行できません`,
      { reason: DAILY_LIMIT, limitUsd: d.limitUsd, usedUsd: d.usedTodayUsd },
    );
  }

  /** Whether today's limit is used up (no side effects). */
  dailyExhausted(): boolean {
    const d = this.daily();
    return d.limitUsd !== null && toMicro(d.usedTodayUsd) >= toMicro(d.limitUsd);
  }

  /** `cost.raiseDaily`: add to today's limit only. */
  raiseToday(addUsd: number, actor: Actor): DailySpend {
    if (actor.kind === 'agent') throw forbidden('今日の上限を上げられるのは人間だけです');
    const { ctx } = this;
    const day = this.today();
    ctx.db.run(
      `INSERT INTO cost_daily_raises (day, extra_micro, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET extra_micro = extra_micro + excluded.extra_micro,
         updated_at = excluded.updated_at`,
      [day, toMicro(addUsd), ctx.clock.iso()],
    );
    // After the caller is done: attention.respond resolves its own item with the choice.
    setImmediate(() => this.resolveDailyNotices(actor));
    return this.daily();
  }

  /**
   * Today's limit has room again (raised for today, or changed in the settings): close the
   * daily-limit items still open. No-op while the limit is still reached.
   */
  resolveDailyNotices(actor: Actor): number {
    const { ctx } = this;
    if (this.closed || this.dailyExhausted() || !ctx.hasService('attention')) return 0;
    const rows = ctx.db.all<{ attention_id: string | null }>(
      "SELECT attention_id FROM cost_notices WHERE key LIKE 'daily:%' AND attention_id IS NOT NULL",
    );
    let n = 0;
    for (const { attention_id: id } of rows) {
      if (!id || ctx.repos.attention.get(id)?.status !== 'open') continue;
      try {
        ctx.service('attention').close(id, 'resolved', { by: actor });
        n += 1;
      } catch (err) {
        ctx.log.warn('failed to close a daily-limit item', { attentionId: id, err });
      }
    }
    return n;
  }

  /**
   * Once per day and limit: `cost.limit_reached` and one `budget` attention (none while an
   * earlier one of the day is still open).
   */
  notifyDailyLimit(sessionId: string | null): void {
    const { ctx } = this;
    if (this.closed) return;
    const d = this.daily();
    if (d.limitUsd === null) return;
    const key = `daily:${d.day}:${toMicro(d.limitUsd)}`;
    if (!this.claimNotice(key)) return;
    ctx.db.transaction(() => {
      ctx.bus.emit({
        type: 'cost.limit_reached',
        actor: COST_SYSTEM,
        payload: { scope: 'daily', usedUsd: d.usedTodayUsd, limitUsd: d.limitUsd! },
      });
    });
    if (this.openNotice(`daily:${d.day}:`)) return;
    this.openAttention(key, sessionId, {
      title: `今日の費用が上限（${usd(d.limitUsd)}）に達しました`,
      detail: `今日の使用額は ${usd(d.usedTodayUsd)} です。上限を上げるまで、新しい LLM の呼び出しは止まります（実行中のエージェントも止めました）。`,
      choices: [...COST_ATTENTION_CHOICES.daily],
    });
  }

  /** LiteLLM's own key budget is used up: one `budget` attention while it stays open. */
  notifyLlmQuota(sessionId: string, message: string): void {
    if (this.openNotice('llm_quota')) return;
    const key = `llm_quota:${this.ctx.clock.iso()}`;
    if (!this.claimNotice(key)) return;
    this.openAttention(key, sessionId, {
      title: 'LiteLLM のキーの予算が上限に達しました',
      detail: `${message}\nLiteLLM の管理者に上限の引き上げを依頼してください。`,
      choices: [],
    });
  }

  private claimNotice(key: string): boolean {
    const r = this.ctx.db.run(
      'INSERT OR IGNORE INTO cost_notices (key, attention_id, created_at) VALUES (?, NULL, ?)',
      [key, this.ctx.clock.iso()],
    );
    return r.changes > 0;
  }

  /** An attention of an earlier notice with this key prefix is still open. */
  private openNotice(prefix: string): boolean {
    const rows = this.ctx.db.all<{ attention_id: string | null }>(
      'SELECT attention_id FROM cost_notices WHERE key LIKE ? AND attention_id IS NOT NULL',
      [`${prefix}%`],
    );
    return rows.some(
      (r) => r.attention_id && this.ctx.repos.attention.get(r.attention_id)?.status === 'open',
    );
  }

  private openAttention(
    key: string,
    sessionId: string | null,
    a: {
      title: string;
      detail: string;
      choices: { id: string; label: string; tone: 'primary' | 'neutral' | 'danger' }[];
    },
  ): void {
    const { ctx } = this;
    if (!sessionId || !ctx.hasService('attention') || !ctx.repos.sessions.get(sessionId)) return;
    try {
      const opened = ctx.service('attention').open({
        kind: 'budget',
        sessionId,
        title: a.title,
        detail: a.detail,
        choices: a.choices,
        allowText: false,
        refs: {},
        actor: COST_SYSTEM,
      });
      if (opened) {
        ctx.db.run('UPDATE cost_notices SET attention_id = ? WHERE key = ?', [opened.id, key]);
      }
    } catch (err) {
      ctx.log.error('failed to open the spend attention', { err });
    }
  }
}
