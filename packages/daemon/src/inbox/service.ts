import {
  type Actor,
  type ErrorInfo,
  type InboxItem,
  type InboxItemKind,
  type Message,
  type Run,
  type RunTrigger,
  type Session,
  type SystemActor,
  isTerminalRunStatus,
} from '@acc/protocol';
import type { InboxDeliverInput, InboxDeliverResult, InboxService } from '../contracts';
import type { DaemonContext } from '../core/context';
import { textOfParts } from '../llm/messages';
import type { ChatMessage } from '../llm/types';
import { ACTIVE_RUN_STATUSES } from '../runs/manager';
import { resolveChatModel } from '../sessions/chat';
import { sessionBudgetId } from '../sessions/methods/shared';
import { isSupervisor, runKindFor, setSupervision } from './supervision';
import { CHILD_UPDATE_STATES, INJECTED_PREFIX, currentState, wakeEntries, wakeText } from './wake';

export const INBOX_SYSTEM: SystemActor = { kind: 'system', component: 'inbox' };

/** Delays before a supervisor whose run failed transiently is woken again (§3.2). */
export const TRANSIENT_RETRY_DELAYS_MS = [60_000, 300_000, 900_000];

/** Statuses reasons of runs the daemon stopped as runaway (they open a `stuck` item). */
const RUNAWAY_REASONS = new Set(['turn_limit', 'loop_detected']);
const RUNAWAY_TITLES: Record<string, string> = {
  turn_limit: 'モデルの呼び出しが上限に達して止まりました',
  loop_detected: '同じ操作を繰り返していたため止めました',
};
const BUDGET_REASONS = new Set(['budget_exhausted', 'daily_limit']);
const WAKE_LIMIT_TITLE = '起こされる回数が上限に達したため見守りを止めました';
const TRANSIENT_GAVE_UP_TITLE = '一時的なエラーが続いたため止まっています';

/** Items handed over as a message (a user turn), not gathered into a wake. */
export function isMessageItem(item: Pick<InboxItem, 'kind' | 'refs'>): boolean {
  return (item.kind === 'user_message' || item.kind === 'answer') && !!item.refs.messageId;
}

const TRANSIENT_CODES = new Set(['llm_timeout', 'llm_unreachable', 'llm_stream_error']);

/** 429 / 5xx / timeouts / dropped connections: worth trying again later. */
export function isTransientRunError(err: ErrorInfo | null): boolean {
  if (!err) return false;
  if (TRANSIENT_CODES.has(err.code)) return true;
  if (err.code === 'llm_http_error') {
    const status = Number(/HTTP (\d{3})/.exec(err.message)?.[1] ?? 0);
    return status === 429 || status >= 500;
  }
  return false;
}

export interface InboxOptions {
  /** Delays of the transient-error retries (tests shorten them). */
  retryDelaysMs?: number[];
}

/**
 * The inbox (spec 20261029 §1.7, §3.2): the only way a session gets new work.
 *
 * - Messages (a user's, a parent's, an answer) start a run when the session is idle; a busy
 *   chat / supervisor run takes them at its next step (`drain`); a busy agent gets them after
 *   its current run (one run per message, in order).
 * - Everything else (a child finished, an answer without a message, budget, a restart) wakes
 *   a supervisor: items gathered for `supervisor.wakeDebounceMs` become one system message
 *   (`meta.wake`) and one `orchestrator` run (trigger `wake`). A supervisor has no run while
 *   its children work, so a human can always talk to it.
 * - Runaway protection: wakes per hour without a human message are capped (then supervision
 *   pauses and a `stuck` item opens), runs stopped for turn_limit / loop_detected open a
 *   `stuck` item too, transient LLM errors are retried after 1, 5 and 15 minutes.
 * - Paused sessions (stopped, or over the wake limit) are not woken; items wait.
 */
export class Inbox implements InboxService {
  private readonly wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Last child state reported to the parent, per child (`state:runId`). */
  private readonly reported = new Map<string, string>();
  private closed = false;
  retryDelaysMs: number[];

  constructor(
    private readonly ctx: DaemonContext,
    opts: InboxOptions = {},
  ) {
    this.retryDelaysMs = opts.retryDelaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
  }

  // ------------------------------------------------------------------ InboxService

  deliver(sessionId: string, input: InboxDeliverInput): InboxDeliverResult {
    const { ctx } = this;
    return ctx.db.transaction(() => {
      const session = ctx.repos.sessions.require(sessionId);
      const refs = input.refs ?? {};
      if (input.kind === 'child_update' && refs.childSessionId) {
        this.dropPending(session.id, 'child_update', refs.childSessionId);
      }
      let item = this.insert(session.id, input.kind, refs, input.actor);
      if (!isMessageItem(item)) {
        this.scheduleWake(session.id);
        return { item, delivery: 'queued', runId: null };
      }

      if (input.actor.kind === 'human' && session.supervision === 'paused') {
        // A person writing to a stopped session takes it back (spec §3.2).
        setSupervision(ctx, session.id, 'active', input.actor);
      }
      const active = this.activeRun(session.id);
      if (active && input.interrupt && active.kind === 'agent') {
        // Stop the agent's current run and hand the message to a new one right away (the
        // runtime resumes its own session, so nothing done so far is lost).
        ctx.service('runs').cancel(active.id, input.actor, 'superseded');
      } else if (active) {
        this.setDelivery(item.refs.messageId!, 'queued', input.actor);
        // Chats and supervisors take it at their next step; agents after this run.
        return active.kind === 'agent'
          ? { item, delivery: 'queued', runId: null }
          : { item, delivery: 'injected', runId: active.id };
      }
      const run = this.startForMessage(session, item, input.actor, input.model ?? null);
      item = this.consume([item], run.id)[0]!;
      return { item, delivery: 'started', runId: run.id };
    });
  }

  drain(runId: string): InboxItem[] {
    const { ctx } = this;
    const run = ctx.repos.runs.get(runId);
    if (!run || isTerminalRunStatus(run.status)) return [];
    return ctx.db.transaction(() => {
      const items = this.pending(run.sessionId).filter(isMessageItem);
      if (items.length === 0) return [];
      return this.consume(items, run.id);
    });
  }

  // ------------------------------------------------------------------ reactions

  /** A run ended: hand over what waited for it, wake its supervisor, report to the parent. */
  onRunEnded(run: Run): void {
    const { ctx } = this;
    if (this.closed) return;
    const session = ctx.repos.sessions.get(run.sessionId);
    if (!session) return;
    try {
      if (run.status === 'failed' && RUNAWAY_REASONS.has(run.statusReason ?? '')) {
        this.stuck(session, RUNAWAY_TITLES[run.statusReason!]!, run.error?.message ?? null, {
          runId: run.id,
        });
      } else if (
        run.status === 'failed' &&
        run.kind === 'orchestrator' &&
        !BUDGET_REASONS.has(run.statusReason ?? '') &&
        isSupervisor(ctx, session.id)
      ) {
        // Budget stops are the budget's own item (T5); everything else is retried or reported.
        this.retryLater(session, run);
      }
      this.next(session.id, run);
    } catch (err) {
      ctx.log.error('inbox: failed to continue after a run', { runId: run.id, err });
    }
    this.evaluateChild(session.id);
  }

  /**
   * Report a child's new state to its supervising parent (done / failed / review /
   * needs_you), once per state and run. Called on every change that can move the state.
   */
  evaluateChild(childId: string): void {
    const { ctx } = this;
    if (this.closed) return;
    try {
      const child = ctx.repos.sessions.get(childId);
      if (!child?.parentSessionId) return;
      const parent = ctx.repos.sessions.get(child.parentSessionId);
      if (!parent || parent.archivedAt || !isSupervisor(ctx, parent.id)) return;
      const state = currentState(ctx, child);
      if (!CHILD_UPDATE_STATES.includes(state)) return;
      const lastRun = ctx.repos.runs.findOne({ where: { session_id: child.id } });
      const signature = `${state}:${lastRun?.id ?? ''}`;
      if (this.reported.get(child.id) === signature) return;
      this.reported.set(child.id, signature);
      this.deliver(parent.id, {
        kind: 'child_update',
        refs: { childSessionId: child.id, ...(lastRun ? { runId: lastRun.id } : {}) },
        actor: INBOX_SYSTEM,
      });
    } catch (err) {
      ctx.log.error('inbox: failed to report a child to its parent', { childId, err });
    }
  }

  /** session.stop marks stopped children so their own state changes are not reported again. */
  markStopped(sessionId: string): void {
    const lastRun = this.ctx.repos.runs.findOne({ where: { session_id: sessionId } });
    this.reported.set(sessionId, `stopped:${lastRun?.id ?? ''}`);
    const timer = this.wakeTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.wakeTimers.delete(sessionId);
  }

  /** Forget what was reported for a session (it was resumed: its next outcome is news). */
  forgetReported(sessionId: string): void {
    this.reported.delete(sessionId);
  }

  /**
   * Store an item that a caller already acted on (e.g. the restart resume of a child agent,
   * which starts its run directly), consumed by `consumedByRunId`: the audit trail and the
   * once-per-interruption record.
   */
  record(
    sessionId: string,
    kind: InboxItemKind,
    refs: InboxItem['refs'],
    actor: Actor,
    consumedByRunId: string,
  ): InboxItem {
    return this.ctx.db.transaction(
      () => this.consume([this.insert(sessionId, kind, refs, actor)], consumedByRunId)[0]!,
    );
  }

  /** Wake soon if there is something to wake for (after resume / delegation). */
  poke(sessionId: string): void {
    if (this.pending(sessionId).some((i) => !isMessageItem(i))) this.scheduleWake(sessionId);
  }

  /** Wake every session that kept items while it could not be woken (e.g. the daily limit). */
  pokeAll(): void {
    if (this.closed) return;
    const rows = this.ctx.db.all<{ session_id: string }>(
      "SELECT DISTINCT session_id FROM inbox_items WHERE status = 'pending'",
    );
    for (const { session_id: id } of rows) this.poke(id);
  }

  private dailyLimitReached(): boolean {
    if (!this.ctx.hasService('ledger')) return false;
    const left = this.ctx.service('ledger').dailyLeft();
    return left !== null && left <= 0;
  }

  /**
   * Messages for a run at a step boundary, as model turns. Marks them delivered; used by the
   * chat and supervisor executors as the tool loop's `inject`.
   */
  injectedMessages(runId: string): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const item of this.drain(runId)) {
      const message = item.refs.messageId ? this.ctx.repos.messages.get(item.refs.messageId) : null;
      const text = message ? textOfParts(message.content) : '';
      if (text) out.push({ role: 'user', content: `${INJECTED_PREFIX}\n${text}` });
    }
    return out;
  }

  stop(): void {
    this.closed = true;
    for (const t of this.wakeTimers.values()) clearTimeout(t);
    this.wakeTimers.clear();
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
  }

  // ------------------------------------------------------------------ wakes

  private scheduleWake(sessionId: string): void {
    if (this.closed || this.wakeTimers.has(sessionId)) return;
    const delay = this.ctx.settings.get().supervisor.wakeDebounceMs;
    // After commit: a rolled-back item must not wake anyone.
    this.ctx.db.afterCommit(() => {
      if (this.closed || this.wakeTimers.has(sessionId)) return;
      const timer = setTimeout(() => {
        this.wakeTimers.delete(sessionId);
        this.wakeNow(sessionId);
      }, delay);
      timer.unref?.();
      this.wakeTimers.set(sessionId, timer);
    });
  }

  /** Gather the pending items into one wake message and start the supervisor's run. */
  wakeNow(sessionId: string): Run | null {
    const { ctx } = this;
    if (this.closed) return null;
    try {
      return ctx.db.transaction(() => {
        const session = ctx.repos.sessions.get(sessionId);
        if (!session || session.archivedAt || session.supervision === 'paused') return null;
        if (this.activeRun(session.id)) return null; // its end hands the items over
        const pending = this.pending(session.id);
        const messages = pending.filter(isMessageItem);
        if (messages.length > 0) {
          // A message waiting without a run (should not happen): it starts the run.
          const run = this.startForMessage(session, messages[0]!, INBOX_SYSTEM, null);
          this.consume(messages, run.id);
          return run;
        }
        if (pending.length === 0) return null;
        // Today's spend limit is reached: the run could not call the model. Keep the items
        // until today has room again (pokeAll on the budget item's resolution).
        if (this.dailyLimitReached()) return null;
        if (!isSupervisor(ctx, session.id)) {
          // Nobody to wake (not, or no longer, a supervisor): do not keep its work unsettled.
          this.drop(pending);
          return null;
        }
        if (this.overWakeLimit(session)) {
          setSupervision(ctx, session.id, 'paused', INBOX_SYSTEM);
          this.stuck(session, WAKE_LIMIT_TITLE, null, {});
          return null;
        }
        const entries = wakeEntries(ctx, session, pending);
        if (entries.length === 0) {
          this.drop(pending);
          return null;
        }
        const message = ctx.service('sessions').appendMessage({
          sessionId: session.id,
          role: 'system',
          content: [{ type: 'text', text: wakeText(entries) }],
          author: INBOX_SYSTEM,
          meta: { kind: 'wake', items: entries.map((e) => e.view) },
        });
        const run = this.startRun(session, {
          trigger: 'wake',
          triggerMessageId: message.id,
          actor: INBOX_SYSTEM,
          model: null,
        });
        this.consume(pending, run.id);
        return run;
      });
    } catch (err) {
      ctx.log.error('inbox: failed to wake a session', { sessionId, err });
      return null;
    }
  }

  /** More than `maxWakesPerHour` wakes since the later of an hour ago and the last human message. */
  private overWakeLimit(session: Session): boolean {
    const { ctx } = this;
    const max = ctx.settings.get().supervisor.maxWakesPerHour;
    const hourAgo = new Date(ctx.clock.now() - 3_600_000).toISOString();
    const lastHuman = ctx.repos.messages.findOne({
      where: { session_id: session.id },
      sql: {
        clause:
          "json_extract(data, '$.role') = 'user' AND json_extract(data, '$.author.kind') = 'human'",
      },
    });
    const since = lastHuman && lastHuman.createdAt > hourAgo ? lastHuman.createdAt : hourAgo;
    const wakes = ctx.repos.runs.count({
      where: { session_id: session.id },
      sql: {
        clause: "json_extract(data, '$.trigger') = 'wake' AND created_at > ?",
        params: [since],
      },
    });
    return wakes >= max;
  }

  /** After a run: the next queued message, else a wake for what gathered meanwhile. */
  private next(sessionId: string, ended: Run): void {
    const { ctx } = this;
    ctx.db.transaction(() => {
      const session = ctx.repos.sessions.get(sessionId);
      if (!session || session.archivedAt || this.activeRun(session.id)) return;
      // Stopped: what waits stays until the session is resumed or written to.
      if (session.supervision === 'paused' || ended.statusReason === 'stopped_by_user') return;
      const pending = this.pending(session.id);
      const messages = pending.filter(isMessageItem);
      if (messages.length > 0) {
        const run = this.startForMessage(session, messages[0]!, INBOX_SYSTEM, null);
        // An agent gets one message per run; chats and supervisors read all from history.
        this.consume(session.kind === 'agent' ? [messages[0]!] : messages, run.id);
        return;
      }
      if (pending.length > 0) this.scheduleWake(session.id);
    });
  }

  // ------------------------------------------------------------------ runaway & errors

  /** Open a `stuck` item and stop waking the session until a human resumes it. */
  private stuck(
    session: Session,
    title: string,
    detail: string | null,
    refs: { runId?: string },
  ): void {
    const { ctx } = this;
    setSupervision(ctx, session.id, 'paused', INBOX_SYSTEM);
    if (!ctx.hasService('attention')) return;
    ctx.service('attention').open({
      kind: 'stuck',
      sessionId: session.id,
      title,
      detail,
      refs,
      actor: INBOX_SYSTEM,
    });
  }

  /** A supervisor run failed: retry transient errors later (3 times), else ask a human. */
  private retryLater(session: Session, run: Run): void {
    const { ctx } = this;
    if (!isTransientRunError(run.error)) {
      this.openFailure(session, run);
      return;
    }
    let streak = 0;
    for (const r of ctx.repos.runs.find({
      where: { session_id: session.id, kind: 'orchestrator' },
      limit: 20,
    })) {
      if (r.status !== 'failed' || !isTransientRunError(r.error)) break;
      streak += 1;
    }
    const delay = this.retryDelaysMs[streak - 1];
    if (delay === undefined) {
      this.openFailure(session, run, TRANSIENT_GAVE_UP_TITLE);
      return;
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (this.closed) return;
      try {
        this.deliver(session.id, { kind: 'resume', refs: { runId: run.id }, actor: INBOX_SYSTEM });
      } catch (err) {
        ctx.log.error('inbox: failed to retry a supervisor', { runId: run.id, err });
      }
    }, delay);
    timer.unref?.();
    this.retryTimers.add(timer);
  }

  private openFailure(session: Session, run: Run, title?: string): void {
    const { ctx } = this;
    if (!ctx.hasService('attention')) return;
    ctx.service('attention').open({
      kind: 'failure',
      sessionId: session.id,
      title: title ?? '指揮役の実行が失敗しました',
      detail: run.error?.message ?? null,
      refs: { runId: run.id },
      actor: INBOX_SYSTEM,
    });
  }

  // ------------------------------------------------------------------ runs

  private startForMessage(
    session: Session,
    item: InboxItem,
    actor: Actor,
    model: string | null,
  ): Run {
    const messageId = item.refs.messageId!;
    this.setDelivery(messageId, 'delivered', actor);
    const message = this.ctx.repos.messages.get(messageId);
    return this.startRun(session, {
      trigger: item.kind === 'answer' ? 'wake' : 'user',
      triggerMessageId: messageId,
      actor: message?.author ?? actor,
      model,
    });
  }

  private startRun(
    session: Session,
    opts: { trigger: RunTrigger; triggerMessageId: string; actor: Actor; model: string | null },
  ): Run {
    const { ctx } = this;
    const kind = runKindFor(ctx, session);
    return ctx.service('runs').start({
      sessionId: session.id,
      kind,
      createdBy: opts.actor,
      triggerMessageId: opts.triggerMessageId,
      trigger: opts.trigger,
      model:
        kind === 'agent'
          ? (opts.model ?? session.model)
          : resolveChatModel(ctx, session.model, opts.model),
      runtime: session.runtime,
      workspaceId: kind === 'agent' ? session.workspaceId : null,
      budgetId: sessionBudgetId(ctx, session.id),
    });
  }

  private activeRun(sessionId: string): Run | undefined {
    return this.ctx.repos.runs.findOne({
      where: { session_id: sessionId, status: [...ACTIVE_RUN_STATUSES] },
    });
  }

  // ------------------------------------------------------------------ items

  private pending(sessionId: string): InboxItem[] {
    return this.ctx.repos.inboxItems.find({
      where: { session_id: sessionId, status: 'pending' },
      direction: 'asc',
    });
  }

  private insert(
    sessionId: string,
    kind: InboxItemKind,
    refs: InboxItem['refs'],
    actor: Actor,
  ): InboxItem {
    const { ctx } = this;
    const item = ctx.repos.inboxItems.insert({
      id: ctx.ids.next('inboxItem'),
      sessionId,
      kind,
      refs,
      status: 'pending',
      consumedByRunId: null,
      createdAt: ctx.clock.iso(),
    });
    ctx.bus.emit({ type: 'inbox.added', actor, payload: { item }, refs: { sessionId } });
    return item;
  }

  private consume(items: InboxItem[], runId: string): InboxItem[] {
    const { ctx } = this;
    if (items.length === 0) return [];
    const out = items.map((i) => {
      if (i.refs.messageId) this.setDelivery(i.refs.messageId, 'delivered', INBOX_SYSTEM);
      return ctx.repos.inboxItems.update(i.id, (x) => ({
        ...x,
        status: 'consumed',
        consumedByRunId: runId,
      }));
    });
    ctx.bus.emit({
      type: 'inbox.consumed',
      actor: INBOX_SYSTEM,
      payload: { itemIds: out.map((i) => i.id), runId },
      refs: { sessionId: out[0]!.sessionId, runId },
    });
    return out;
  }

  private drop(items: InboxItem[]): void {
    for (const i of items) {
      this.ctx.repos.inboxItems.update(i.id, (x) => ({ ...x, status: 'dropped' }));
    }
  }

  /** A newer update of the same child replaces the one still waiting. */
  private dropPending(sessionId: string, kind: InboxItemKind, childSessionId: string): void {
    this.drop(
      this.pending(sessionId).filter(
        (i) => i.kind === kind && i.refs.childSessionId === childSessionId,
      ),
    );
  }

  private setDelivery(messageId: string, delivery: Message['delivery'], actor: Actor): void {
    const { ctx } = this;
    const cur = ctx.repos.messages.get(messageId);
    if (!cur || cur.delivery === delivery) return;
    const message = ctx.repos.messages.update(messageId, (m) => ({ ...m, delivery }));
    ctx.bus.emit({ type: 'message.updated', actor, payload: { message, changes: ['delivery'] } });
  }
}
