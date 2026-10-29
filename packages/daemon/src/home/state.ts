import type {
  Actor,
  AttentionKind,
  RunStatus,
  Session,
  SessionKind,
  SessionState,
  Supervision,
  TaskStatus,
} from '@acc/protocol';
import type { SessionStateService } from '../contracts';
import type { DaemonContext } from '../core/context';
import { ACTIVE_RUN_STATUSES } from '../runs/manager';
import { NOW_PREPARING, clip, nowForActivity } from './now';
import { isWorkSettled, subtreeIds } from './tree';

/** Everything the state of one session is derived from (spec 20261029 §3.7). */
export interface StateFacts {
  kind: SessionKind;
  /** Kinds of the open attention items on this session. */
  openAttention: AttentionKind[];
  /** Status of the session's latest run, if any. */
  lastRunStatus: RunStatus | null;
  /** Status of the session's task (its own, or the one assigned to it), if any. */
  taskStatus: TaskStatus | null;
  /** A descendant has an active run or a task waiting to start. */
  descendantBusy: boolean;
  hasChildren: boolean;
  supervision: Supervision;
}

const ASKS_A_HUMAN: readonly AttentionKind[] = ['question', 'approval', 'budget', 'stuck'];

/**
 * The §3.7 table, first match wins: needs_you > failed > working > supervising > queued >
 * review > stopped > done > idle. Pure.
 */
export function deriveSessionState(f: StateFacts): SessionState {
  if (f.openAttention.some((k) => ASKS_A_HUMAN.includes(k))) return 'needs_you';
  if (f.openAttention.includes('failure')) return 'failed';
  if (f.lastRunStatus === 'running' || f.lastRunStatus === 'awaiting_approval') return 'working';
  const runActive = f.lastRunStatus === 'created' || f.lastRunStatus === 'queued';
  if (!runActive && f.descendantBusy) return 'supervising';
  if (runActive || f.taskStatus === 'pending' || f.taskStatus === 'ready') return 'queued';
  if (f.taskStatus === 'review' || f.openAttention.includes('review')) return 'review';
  if (f.taskStatus === 'paused' || f.supervision === 'paused') return 'stopped';
  if (
    f.taskStatus === 'done' ||
    (f.lastRunStatus === 'completed' && !f.hasChildren && f.kind === 'agent')
  ) {
    return 'done';
  }
  return 'idle';
}

/** Read the facts of one session (a handful of indexed queries). */
export function readStateFacts(ctx: DaemonContext, session: Session): StateFacts {
  const { repos } = ctx;
  const openAttention = repos.attention
    .find({ where: { session_id: session.id, status: 'open' } })
    .map((a) => a.kind);
  const lastRun = repos.runs.findOne({ where: { session_id: session.id } });
  const task =
    (session.taskId ? repos.tasks.get(session.taskId) : undefined) ??
    repos.tasks.findOne({ where: { assignee_session_id: session.id } });
  const descendants = subtreeIds(ctx, session.id).slice(1);
  const descendantBusy =
    descendants.length > 0 &&
    (repos.runs.count({
      where: { session_id: descendants, status: [...ACTIVE_RUN_STATUSES] },
    }) > 0 ||
      repos.tasks.count({
        where: { assignee_session_id: descendants, status: ['pending', 'ready'] },
      }) > 0);
  return {
    kind: session.kind,
    openAttention,
    lastRunStatus: lastRun?.status ?? null,
    taskStatus: task?.status ?? null,
    descendantBusy,
    hasChildren: descendants.length > 0,
    supervision: session.supervision,
  };
}

/** Run statuses during which a session shows what it is doing (`Session.now`). */
const NOW_RUN_STATUSES: readonly RunStatus[] = ['running', 'awaiting_approval'];

const SYSTEM: Actor = { kind: 'system', component: 'home' };

/** Ancestor walk guard (trees are shallow; a corrupt parent cycle must not hang the daemon). */
const MAX_DEPTH = 64;

/**
 * `sessionState` (spec 20261029 §3.7, architecture.md §2.19): the only writer of
 * `Session.state` / `stateSince` / `now`.
 *
 * - `recompute(id)` re-derives the session and its ancestors from what is stored (runs,
 *   tasks, attention, the subtree) and emits `session.state_changed` for each that changed.
 *   The home module calls it on run / task / attention / session events; other modules may
 *   call it directly after changing one of those inputs.
 * - `now` comes from the latest tool use, activity line or streamed fragment of the running
 *   run (`noteActivity`). It is written at most once per `nowIntervalMs` per session
 *   (`session.now_changed`), and at once when it rides along with a state change.
 * - Until `start()` (daemon startup), changes are written without events: a restart must not
 *   look like work settling (D17, grants of lifetime `work`).
 */
export class SessionStateTracker implements SessionStateService {
  /** Minimum time between two `now` writes of one session (tests set 0). */
  nowIntervalMs = 1000;
  private readonly live = new Map<string, string>();
  private readonly spawnedByRun = new Map<string, number>();
  private readonly lastNowAt = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private emitting = false;
  private closed = false;

  constructor(private readonly ctx: DaemonContext) {}

  recompute(sessionId: string): Session | null {
    const { ctx } = this;
    return ctx.db.transaction(() => {
      let first: Session | null = null;
      let cur = ctx.repos.sessions.get(sessionId);
      for (let i = 0; cur && i < MAX_DEPTH; i++) {
        const next = this.recomputeOne(cur);
        first ??= next;
        cur = cur.parentSessionId ? ctx.repos.sessions.get(cur.parentSessionId) : undefined;
      }
      return first;
    });
  }

  isWorkSettled(sessionId: string): boolean {
    return isWorkSettled(this.ctx, sessionId);
  }

  /**
   * The running run of a session said what it is doing (a phrase from `home/now.ts`).
   * Null keeps the previous phrase.
   */
  noteActivity(sessionId: string, phrase: string | null): void {
    if (this.closed || !phrase) return;
    this.live.set(sessionId, clip(phrase));
    const session = this.ctx.repos.sessions.get(sessionId);
    if (!session) return;
    this.offerNow(session, this.nowFor(session, lastRunStatus(this.ctx, session.id)));
  }

  /** Count a `session.spawn` call of a run; returns how many it has made ("2 人に依頼"). */
  countSpawn(runId: string): number {
    const n = (this.spawnedByRun.get(runId) ?? 0) + 1;
    this.spawnedByRun.set(runId, n);
    return n;
  }

  /** A run ended: forget its live phrase (the state change that follows clears `now`). */
  runEnded(sessionId: string, runId: string): void {
    this.spawnedByRun.delete(runId);
    this.live.delete(sessionId);
  }

  /**
   * Daemon startup: bring every session that may be stale up to date without events (runs
   * were interrupted, attention was added or withdrawn), then emit from now on.
   */
  start(): number {
    const { ctx } = this;
    let changed = 0;
    ctx.db.transaction(() => {
      const rows = ctx.db.all<{ id: string }>(
        `SELECT id FROM sessions
          WHERE state NOT IN ('idle', 'done') OR json_extract(data, '$.now') IS NOT NULL`,
      );
      for (const { id } of rows) {
        const before = ctx.repos.sessions.get(id);
        if (!before) continue;
        const after = this.recomputeOne(before);
        if (after.state !== before.state || after.now !== before.now) changed += 1;
      }
    });
    this.emitting = true;
    return changed;
  }

  stop(): void {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private recomputeOne(session: Session): Session {
    const { ctx } = this;
    const facts = readStateFacts(ctx, session);
    const state = deriveSessionState(facts);
    const now = this.nowFor(session, facts.lastRunStatus);
    if (state === session.state) {
      if (now !== session.now) this.offerNow(session, now);
      return session;
    }
    const at = ctx.clock.iso();
    const next = ctx.repos.sessions.update(session.id, (s) => ({
      ...s,
      state,
      stateSince: at,
      now,
    }));
    this.nowWritten(session.id);
    if (this.emitting) {
      ctx.bus.emit({
        type: 'session.state_changed',
        actor: SYSTEM,
        payload: {
          sessionId: next.id,
          rootSessionId: next.rootSessionId,
          parentSessionId: next.parentSessionId,
          from: session.state,
          to: state,
          stateSince: at,
          now,
        },
        refs: { sessionId: next.id, projectId: next.projectId },
      });
    }
    return next;
  }

  /** What the session's chip says now: only while its run is running (§3.7). */
  private nowFor(session: Session, runStatus: RunStatus | null): string | null {
    if (!runStatus || !NOW_RUN_STATUSES.includes(runStatus)) return null;
    const { repos } = this.ctx;
    if (runStatus === 'awaiting_approval') {
      // Waiting for a human: the item's own one-line title ("pnpm add zod を実行").
      const waiting = repos.attention.findOne({
        where: { session_id: session.id, status: 'open', kind: ['approval', 'question'] },
      });
      if (waiting) return clip(waiting.title);
    }
    const live = this.live.get(session.id);
    if (live) return live;
    const run = repos.runs.findOne({
      where: { session_id: session.id, status: [...NOW_RUN_STATUSES] },
    });
    return nowForActivity(run?.activity) ?? NOW_PREPARING;
  }

  /** Write a new `now` (state unchanged), at most once per interval per session. */
  private offerNow(session: Session, now: string | null): void {
    if (this.closed || now === session.now) return;
    const last = this.lastNowAt.get(session.id);
    const wait = last === undefined ? 0 : last + this.nowIntervalMs - this.ctx.clock.now();
    if (wait <= 0 || !this.emitting) {
      this.writeNow(session.id);
      return;
    }
    if (this.timers.has(session.id)) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(session.id);
        if (!this.closed) this.writeNow(session.id);
      },
      Math.min(wait, this.nowIntervalMs),
    );
    timer.unref?.();
    this.timers.set(session.id, timer);
  }

  /** Persist the current `now` of a session and emit `session.now_changed`. */
  private writeNow(sessionId: string): void {
    const { ctx } = this;
    try {
      ctx.db.transaction(() => {
        const cur = ctx.repos.sessions.get(sessionId);
        if (!cur) return;
        const now = this.nowFor(cur, lastRunStatus(ctx, sessionId));
        this.nowWritten(sessionId);
        if (now === cur.now) return;
        const next = ctx.repos.sessions.update(sessionId, (s) => ({ ...s, now }));
        if (!this.emitting) return;
        ctx.bus.emit({
          type: 'session.now_changed',
          actor: SYSTEM,
          payload: { sessionId, rootSessionId: next.rootSessionId, now },
          refs: { sessionId, projectId: next.projectId },
        });
      });
    } catch (err) {
      ctx.log.warn('failed to update what a session is doing', { sessionId, err });
    }
  }

  private nowWritten(sessionId: string): void {
    this.lastNowAt.set(sessionId, this.ctx.clock.now());
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
  }
}

function lastRunStatus(ctx: DaemonContext, sessionId: string): RunStatus | null {
  return ctx.repos.runs.findOne({ where: { session_id: sessionId } })?.status ?? null;
}

/**
 * Startup backfill (spec §1.12-1, run once): derive every session's state and write the ones
 * that differ, without events (`stateSince` = its last activity).
 */
export function backfillSessionStates(ctx: DaemonContext): number {
  let changed = 0;
  ctx.db.transaction(() => {
    for (const { id } of ctx.db.all<{ id: string }>('SELECT id FROM sessions')) {
      const session = ctx.repos.sessions.get(id);
      if (!session) continue;
      const state = deriveSessionState(readStateFacts(ctx, session));
      if (state === session.state) continue;
      ctx.repos.sessions.update(id, (s) => ({ ...s, state, stateSince: s.lastActivityAt }));
      changed += 1;
    }
  });
  return changed;
}
