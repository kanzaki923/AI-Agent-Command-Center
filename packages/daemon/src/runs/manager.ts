import {
  type Actor,
  type AgentActor,
  type Approval,
  type BudgetAllocation,
  type CostSource,
  type ErrorInfo,
  type Run,
  type RunKind,
  type RunStatus,
  type Session,
  type SystemActor,
  type Usage,
  isTerminalRunStatus,
} from '@acc/protocol';
import type {
  ApprovalDecision,
  ApprovalRequest,
  BudgetHold,
  BudgetReservation,
  BudgetService,
  RunController,
  RunExecutor,
  RunsService,
  StartRunInput,
  WorkspaceLock,
} from '../contracts';
import type { DaemonContext } from '../core/context';
import { ApiError, budgetExceeded, conflict, forbidden } from '../core/errors';

/** Unallocated, unreserved, unspent amount of a budget, in integer micro-dollars. */
function remainingMicroUsd(b: BudgetAllocation): number {
  const micro = (usd: number) => Math.round(usd * 1_000_000);
  return micro(b.limitUsd) - micro(b.allocatedUsd) - micro(b.reservedUsd) - micro(b.spentUsd);
}

/** Statuses of a run that has not ended (at most one per session). */
export const ACTIVE_RUN_STATUSES = [
  'created',
  'queued',
  'running',
  'awaiting_approval',
] as const satisfies RunStatus[];

const SYSTEM: SystemActor = { kind: 'system', component: 'runs' };
const MAX_ACTIVITY_CHARS = 200;

type AbortKind = 'cancel' | 'shutdown' | 'budget';

interface ApprovalWaiter {
  runId: string;
  resolve: (d: ApprovalDecision) => void;
  reject: (e: unknown) => void;
}

/** In-memory state of a run that holds an execution slot (running / awaiting_approval). */
interface ActiveRun {
  readonly runId: string;
  run: Run;
  readonly abort: AbortController;
  abortKind: AbortKind | null;
  lock: WorkspaceLock | null;
  readonly deltaIndex: Map<string, number>;
  readonly toolStarts: Map<string, number>;
  usageReported: boolean;
  settled: boolean;
  done: Promise<void>;
  forceTimer: ReturnType<typeof setTimeout> | null;
  /** Budget reservations of in-flight LLM calls (cancelled if the run ends first). */
  readonly reservations: Set<BudgetReservation>;
}

export interface RunManagerOptions {
  /** How long a cancelled executor may take to unwind before its slot is freed anyway. */
  cancelGraceMs?: number;
  /** How long shutdown waits for executors to unwind. */
  shutdownGraceMs?: number;
}

function abortErr(message: string): DOMException {
  return new DOMException(message, 'AbortError');
}

/** Error thrown by an executor -> Run.error. */
export function toErrorInfo(err: unknown): ErrorInfo {
  if (err instanceof ApiError) return { code: err.code, message: err.message };
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      code: typeof code === 'string' ? code : err.name === 'AbortError' ? 'aborted' : 'internal',
      message: err.message || '不明なエラーが発生しました',
    };
  }
  return { code: 'internal', message: String(err) };
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

/**
 * Run lifecycle (architecture.md §2.6):
 * created → queued → running ⇄ awaiting_approval → completed | failed | cancelled | interrupted.
 *
 * - At most `settings.maxConcurrentRuns` runs hold an execution slot (running or
 *   awaiting_approval); the rest wait in `queued`, started FIFO as slots free up.
 * - A run with a workspace starts only once it holds the workspace's write lock; until then
 *   it stays queued while runs behind it may start.
 * - Executors (one per run kind) do the work through a RunController; they never set
 *   terminal statuses themselves.
 */
export class RunManager implements RunsService {
  private readonly executors = new Map<RunKind, RunExecutor>();
  private queue: string[] = [];
  private readonly active = new Map<string, ActiveRun>();
  private readonly waiters = new Map<string, Set<(run: Run) => void>>();
  private readonly approvalWaiters = new Map<string, ApprovalWaiter>();
  private readonly lockWaitNoted = new Set<string>();
  private closed = false;
  /** Set once shutdown finished: late executor callbacks must not touch the (closed) DB. */
  private detached = false;
  private pumping = false;
  private pumpAgain = false;
  private readonly cancelGraceMs: number;
  private readonly shutdownGraceMs: number;

  constructor(
    private readonly ctx: DaemonContext,
    opts: RunManagerOptions = {},
  ) {
    this.cancelGraceMs = opts.cancelGraceMs ?? 10_000;
    this.shutdownGraceMs = opts.shutdownGraceMs ?? 5_000;
  }

  // ------------------------------------------------------------------ RunsService

  registerExecutor(kind: RunKind, executor: RunExecutor): void {
    if (this.executors.has(kind)) this.ctx.log.debug('run executor replaced', { kind });
    this.executors.set(kind, executor);
    // Runs of this kind may already be waiting.
    queueMicrotask(() => this.pump());
  }

  hasExecutor(kind: RunKind): boolean {
    return this.executors.has(kind);
  }

  start(input: StartRunInput): Run {
    const { ctx } = this;
    if (this.closed) throw conflict('デーモンを停止中のため Run を開始できません');
    const run = ctx.db.transaction(() => {
      const session = ctx.repos.sessions.require(input.sessionId);
      const busy = ctx.repos.runs.findOne({
        where: { session_id: session.id, status: [...ACTIVE_RUN_STATUSES] },
      });
      if (busy) {
        throw conflict('このセッションでは別の Run が実行中です', { runId: busy.id });
      }
      const attempt = input.retryOfRunId
        ? ctx.repos.runs.require(input.retryOfRunId).attempt + 1
        : 1;
      const now = ctx.clock.iso();
      const taskId = input.taskId ?? session.taskId;
      const created = ctx.repos.runs.insert({
        id: ctx.ids.next('run'),
        sessionId: session.id,
        projectId: input.projectId ?? session.projectId,
        taskId,
        kind: input.kind,
        status: 'created',
        statusReason: null,
        model: input.model ?? null,
        runtime: input.runtime ?? null,
        workspaceId: input.workspaceId ?? this.defaultWorkspaceId(input.kind, session, taskId),
        parentRunId: input.parentRunId ?? null,
        retryOfRunId: input.retryOfRunId ?? null,
        attempt,
        budgetId: input.budgetId ?? null,
        triggerMessageId: input.triggerMessageId ?? null,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'unknown' },
        error: null,
        activity: null,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        endedAt: null,
      });
      ctx.bus.emit({ type: 'run.created', actor: input.createdBy, payload: { run: created } });
      if (ctx.hasService('sessions')) {
        ctx.service('sessions').setActiveRun(session.id, created.id, input.createdBy);
      }
      return this.transition(created, 'queued', null, input.createdBy);
    });
    // Only queue what was committed (start may run inside a caller's transaction).
    ctx.db.afterCommit(() => {
      this.queue.push(run.id);
      this.pump();
    });
    return run;
  }

  /**
   * Agent runs write to the session's (or task's) workspace when none is given — the agent
   * executor falls back the same way — so resolve it here: the run must hold that lock.
   */
  private defaultWorkspaceId(
    kind: RunKind,
    session: Session,
    taskId: string | null,
  ): string | null {
    if (kind !== 'agent') return null;
    if (session.workspaceId) return session.workspaceId;
    return (taskId && this.ctx.repos.tasks.get(taskId)?.workspaceId) || null;
  }

  cancel(runId: string, actor: Actor, reason?: string): Run {
    const run = this.ctx.repos.runs.require(runId);
    if (isTerminalRunStatus(run.status)) {
      throw conflict('この Run はすでに終了しています', { status: run.status });
    }
    const a = this.active.get(runId);
    if (a) a.abortKind ??= 'cancel';
    const next = this.terminate(run, 'cancelled', reason ?? 'cancelled', actor);
    if (a) {
      a.run = next;
      this.rejectApprovalWaiters(runId, abortErr('Run was cancelled'));
      a.abort.abort(abortErr('Run was cancelled'));
      // A misbehaving executor must not hold its slot (and workspace lock) forever.
      a.forceTimer = setTimeout(() => {
        if (a.settled) return;
        this.ctx.log.warn('cancelled run did not stop in time; releasing its slot', { runId });
        this.cleanup(a);
      }, this.cancelGraceMs);
      a.forceTimer.unref?.();
    } else {
      this.queue = this.queue.filter((id) => id !== runId);
      this.lockWaitNoted.delete(runId);
    }
    return next;
  }

  waitForEnd(runId: string, signal?: AbortSignal): Promise<Run> {
    const run = this.ctx.repos.runs.require(runId);
    if (isTerminalRunStatus(run.status)) return Promise.resolve(run);
    if (signal?.aborted) return Promise.reject(abortErr('Wait aborted'));
    return new Promise((resolve, reject) => {
      let set = this.waiters.get(runId);
      if (!set) this.waiters.set(runId, (set = new Set()));
      const onAbort = () => {
        set.delete(fn);
        reject(abortErr('Wait aborted'));
      };
      const fn = (r: Run) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(r);
      };
      set.add(fn);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  resolveApproval(approvalId: string, decision: ApprovalDecision, actor: Actor): Approval {
    const { ctx } = this;
    return ctx.db.transaction(() => {
      const cur = ctx.repos.approvals.require(approvalId);
      if (cur.status !== 'pending') {
        throw conflict('この承認リクエストはすでに処理されています', { status: cur.status });
      }
      if (actor.kind === 'agent' && cur.runId !== null && actor.runId === cur.runId) {
        throw forbidden('自分が出した承認リクエストには回答できません');
      }
      // Integration approvals (running the tests on agent-written code, applying to a
      // protected branch) are decisions only a human makes, whatever the grants say.
      if (cur.kind === 'integration' && actor.kind !== 'human') {
        throw forbidden('統合に関する承認は人間だけが回答できます');
      }
      const approval = ctx.repos.approvals.update(approvalId, (ap) => ({
        ...ap,
        status: decision.decision,
        resolvedBy: actor,
        resolutionNote: decision.note ?? null,
        resolvedAt: ctx.clock.iso(),
      }));
      ctx.bus.emit({ type: 'approval.resolved', actor, payload: { approval } });

      if (approval.runId) {
        const run = ctx.repos.runs.get(approval.runId);
        const stillPending = ctx.repos.approvals.count({
          where: { run_id: approval.runId, status: 'pending' },
        });
        if (run?.status === 'awaiting_approval' && stillPending === 0) {
          const next = this.transition(run, 'running', 'approval_resolved', actor);
          const a = this.active.get(run.id);
          if (a) a.run = next;
        }
      }
      ctx.db.afterCommit(() => {
        const w = this.approvalWaiters.get(approvalId);
        if (!w) return;
        this.approvalWaiters.delete(approvalId);
        w.resolve(decision);
      });
      return approval;
    });
  }

  // ------------------------------------------------------------------ lifecycle

  /** Start queued runs while slots (and workspace locks) are available. */
  pump(): void {
    if (this.closed) return;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        this.pumpOnce();
      } while (this.pumpAgain && !this.closed);
    } finally {
      this.pumping = false;
    }
  }

  private pumpOnce(): void {
    const { ctx } = this;
    const max = ctx.settings.get().maxConcurrentRuns;
    const removed = new Set<string>();
    for (const id of [...this.queue]) {
      const run = ctx.repos.runs.get(id);
      if (!run || run.status !== 'queued') {
        removed.add(id);
        continue;
      }
      if (this.active.size >= max) break;
      const lock = this.tryLock(run);
      if (lock.kind === 'busy') {
        this.noteLockWait(run);
        continue;
      }
      removed.add(id);
      if (lock.kind === 'error') {
        this.terminate(run, 'failed', 'workspace_unavailable', SYSTEM, toErrorInfo(lock.error));
        continue;
      }
      this.launch(run, lock.lock);
    }
    if (removed.size > 0) this.queue = this.queue.filter((id) => !removed.has(id));
  }

  private tryLock(
    run: Run,
  ):
    | { kind: 'ok'; lock: WorkspaceLock | null }
    | { kind: 'busy' }
    | { kind: 'error'; error: unknown } {
    if (!run.workspaceId || !this.ctx.hasService('workspaces')) return { kind: 'ok', lock: null };
    const ws = this.ctx.service('workspaces');
    try {
      if (ws.isLocked(run.workspaceId)) return { kind: 'busy' };
      return { kind: 'ok', lock: ws.acquire(run.workspaceId, run.id) };
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict') return { kind: 'busy' };
      return { kind: 'error', error: err };
    }
  }

  private noteLockWait(run: Run): void {
    if (this.lockWaitNoted.has(run.id)) return;
    this.lockWaitNoted.add(run.id);
    this.updateActivity(run.id, 'ワークスペースの解放を待っています', SYSTEM);
  }

  private launch(run: Run, lock: WorkspaceLock | null): void {
    const { ctx } = this;
    this.lockWaitNoted.delete(run.id);
    const a: ActiveRun = {
      runId: run.id,
      run,
      abort: new AbortController(),
      abortKind: null,
      lock,
      deltaIndex: new Map(),
      toolStarts: new Map(),
      usageReported: false,
      settled: false,
      done: Promise.resolve(),
      forceTimer: null,
      reservations: new Set(),
    };
    this.active.set(run.id, a);
    try {
      a.run = ctx.db.transaction(() => {
        let next = this.transition(run, 'running', null, SYSTEM, {
          startedAt: run.startedAt ?? ctx.clock.iso(),
        });
        if (next.activity) next = this.updateActivity(run.id, null, SYSTEM) ?? next;
        return next;
      });
    } catch (err) {
      ctx.log.error('failed to start run', { runId: run.id, err });
      this.cleanup(a);
      return;
    }
    // Start the executor on a later tick so callers of start() see the run first.
    a.done = Promise.resolve().then(() => this.execute(a));
  }

  private async execute(a: ActiveRun): Promise<void> {
    const executor = this.executors.get(a.run.kind);
    let ok = false;
    let error: unknown = null;
    try {
      if (!executor) {
        throw new ApiError(
          'not_found',
          `この種類の Run（${a.run.kind}）を実行する仕組みがまだありません`,
          { kind: a.run.kind },
        );
      }
      await executor(this.controller(a));
      ok = true;
    } catch (err) {
      error = err;
    }
    this.finalize(a, ok, error);
  }

  private finalize(a: ActiveRun, ok: boolean, error: unknown): void {
    if (a.settled || this.detached) return;
    try {
      const cur = this.ctx.repos.runs.get(a.runId);
      if (cur && !isTerminalRunStatus(cur.status)) {
        if (a.abortKind === 'shutdown') {
          a.run = this.terminate(cur, 'interrupted', 'daemon_shutdown', SYSTEM);
        } else if (a.abortKind === 'budget') {
          a.run = this.terminate(cur, 'failed', 'budget_exhausted', SYSTEM, {
            code: 'budget_exceeded',
            message: '予算の上限に達したため停止しました',
          });
        } else if (a.abortKind === 'cancel') {
          a.run = this.terminate(cur, 'cancelled', 'cancelled', SYSTEM);
        } else if (ok) {
          a.run = this.terminate(cur, 'completed', null, SYSTEM);
        } else if (error instanceof ApiError && error.code === 'budget_exceeded') {
          // Refused before an LLM call (nothing left / reservation did not fit).
          a.run = this.terminate(cur, 'failed', 'budget_exhausted', SYSTEM, toErrorInfo(error));
        } else {
          a.run = this.terminate(cur, 'failed', 'error', SYSTEM, toErrorInfo(error));
        }
      }
    } catch (err) {
      this.ctx.log.error('failed to finalize run', { runId: a.runId, err });
    }
    this.cleanup(a);
  }

  /** Free the slot and resources of an active run, then start the next queued ones. */
  private cleanup(a: ActiveRun): void {
    if (a.settled) return;
    a.settled = true;
    if (a.forceTimer) clearTimeout(a.forceTimer);
    this.rejectApprovalWaiters(a.runId, abortErr('Run ended'));
    if (!this.detached) {
      try {
        a.lock?.release();
      } catch (err) {
        this.ctx.log.error('failed to release workspace lock', { runId: a.runId, err });
      }
      // An executor that stopped mid-call (or never settled) must not keep money reserved.
      for (const r of a.reservations) {
        try {
          this.ctx.service('budget').cancelReservation(r);
        } catch (err) {
          this.ctx.log.error('failed to cancel budget reservation', { runId: a.runId, err });
        }
      }
      a.reservations.clear();
    }
    this.active.delete(a.runId);
    this.pump();
  }

  private rejectApprovalWaiters(runId: string, err: unknown): void {
    for (const [id, w] of this.approvalWaiters) {
      if (w.runId !== runId) continue;
      this.approvalWaiters.delete(id);
      w.reject(err);
    }
  }

  /** Persist a status change + run.status_changed. */
  private transition(
    run: Run,
    to: RunStatus,
    reason: string | null,
    actor: Actor,
    patch: Partial<Run> = {},
  ): Run {
    const { ctx } = this;
    return ctx.db.transaction(() => {
      const cur = ctx.repos.runs.require(run.id);
      const next = ctx.repos.runs.update(run.id, (r) => ({
        ...r,
        ...patch,
        status: to,
        statusReason: reason,
        updatedAt: ctx.clock.iso(),
      }));
      ctx.bus.emit({
        type: 'run.status_changed',
        actor,
        payload: { runId: run.id, from: cur.status, to, reason },
        refs: {
          projectId: next.projectId,
          sessionId: next.sessionId,
          runId: next.id,
          taskId: next.taskId,
        },
      });
      return next;
    });
  }

  /**
   * Move a run to a terminal status: emits run.completed / run.failed where applicable,
   * cancels its pending approvals, clears session.activeRunId and wakes waitForEnd callers.
   */
  private terminate(
    run: Run,
    to: 'completed' | 'failed' | 'cancelled' | 'interrupted',
    reason: string | null,
    actor: Actor,
    error: ErrorInfo | null = null,
  ): Run {
    const { ctx } = this;
    const next = ctx.db.transaction(() => {
      const now = ctx.clock.iso();
      const ended = this.transition(run, to, reason, actor, {
        endedAt: now,
        activity: null,
        ...(error ? { error } : {}),
      });
      if (to === 'completed') {
        ctx.bus.emit({ type: 'run.completed', actor, payload: { run: ended } });
      } else if (to === 'failed') {
        ctx.bus.emit({
          type: 'run.failed',
          actor,
          payload: { run: ended, error: error ?? { code: 'internal', message: '失敗しました' } },
        });
      }
      for (const ap of ctx.repos.approvals.find({ where: { run_id: run.id, status: 'pending' } })) {
        const approval = ctx.repos.approvals.update(ap.id, (x) => ({
          ...x,
          status: 'cancelled',
          resolvedBy: actor,
          resolutionNote: 'Run が終了したため取り消されました',
          resolvedAt: now,
        }));
        ctx.bus.emit({ type: 'approval.resolved', actor, payload: { approval } });
      }
      const session = ctx.repos.sessions.get(run.sessionId);
      if (session?.activeRunId === run.id && ctx.hasService('sessions')) {
        ctx.service('sessions').setActiveRun(session.id, null, actor);
      }
      return ended;
    });
    ctx.db.afterCommit(() => {
      const set = this.waiters.get(run.id);
      if (!set) return;
      this.waiters.delete(run.id);
      for (const fn of set) fn(next);
    });
    return next;
  }

  /** Set the activity line (emits run.updated when it changed). */
  private updateActivity(runId: string, text: string | null, actor: Actor): Run | null {
    const { ctx } = this;
    const value = text?.trim().slice(0, MAX_ACTIVITY_CHARS) || null;
    return ctx.db.transaction(() => {
      const cur = ctx.repos.runs.get(runId);
      if (!cur || isTerminalRunStatus(cur.status) || (cur.activity ?? null) === value) return null;
      const run = ctx.repos.runs.update(runId, (r) => ({
        ...r,
        activity: value,
        updatedAt: ctx.clock.iso(),
      }));
      ctx.bus.emit({ type: 'run.updated', actor, payload: { run, changes: ['activity'] } });
      return run;
    });
  }

  // ------------------------------------------------------------------ controller

  private controller(a: ActiveRun): RunController {
    const { ctx } = this;
    const actor: AgentActor = { kind: 'agent', sessionId: a.run.sessionId, runId: a.runId };
    const refs = () => ({
      projectId: a.run.projectId,
      sessionId: a.run.sessionId,
      runId: a.runId,
      taskId: a.run.taskId,
    });
    const live = () => !this.detached;
    const ended = () => a.settled || isTerminalRunStatus(a.run.status);

    return {
      get run() {
        return a.run;
      },
      signal: a.abort.signal,
      actor,

      emitDelta: (messageId, text, kind = 'text') => {
        if (ended() || !text) return;
        const index = a.deltaIndex.get(messageId) ?? 0;
        a.deltaIndex.set(messageId, index + 1);
        ctx.bus.publishDelta({
          runId: a.runId,
          sessionId: a.run.sessionId,
          messageId,
          kind,
          text,
          index,
        });
      },

      appendMessage: (input) => {
        if (!live()) return;
        ctx.service('sessions').appendMessage({
          sessionId: a.run.sessionId,
          role: input.role,
          content: input.content,
          author: actor,
          runId: a.runId,
          model: input.model ?? null,
          ...(input.id ? { id: input.id } : {}),
        });
      },

      toolCalled: (call) => {
        if (!live()) return;
        a.toolStarts.set(call.toolCallId, ctx.clock.now());
        ctx.bus.emit({
          type: 'tool.called',
          actor,
          payload: { runId: a.runId, ...call },
          refs: refs(),
        });
      },

      toolResult: (result) => {
        if (!live()) return;
        const startedAt = a.toolStarts.get(result.toolCallId);
        a.toolStarts.delete(result.toolCallId);
        ctx.bus.emit({
          type: 'tool.result',
          actor,
          payload: {
            runId: a.runId,
            toolCallId: result.toolCallId,
            name: result.name,
            output: result.output,
            isError: result.isError ?? false,
            durationMs:
              startedAt === undefined ? null : Math.max(0, Math.round(ctx.clock.now() - startedAt)),
          },
          refs: refs(),
        });
      },

      requestApproval: (req: ApprovalRequest) => {
        if (a.abort.signal.aborted || ended()) {
          return Promise.reject(abortErr('Run is not active'));
        }
        const approval = ctx.db.transaction(() => {
          const run = ctx.repos.runs.require(a.runId);
          const created = ctx.repos.approvals.insert({
            id: ctx.ids.next('approval'),
            kind: req.kind,
            status: 'pending',
            title: req.title,
            detail: req.detail ?? null,
            payload: req.payload ?? null,
            projectId: run.projectId,
            sessionId: run.sessionId,
            runId: run.id,
            taskId: run.taskId,
            integrationId: null,
            requestedBy: actor,
            resolvedBy: null,
            resolutionNote: null,
            createdAt: ctx.clock.iso(),
            resolvedAt: null,
          });
          ctx.bus.emit({ type: 'approval.requested', actor, payload: { approval: created } });
          if (run.status === 'running') {
            a.run = this.transition(run, 'awaiting_approval', 'approval_requested', actor);
          }
          return created;
        });
        return new Promise<ApprovalDecision>((resolve, reject) => {
          this.approvalWaiters.set(approval.id, { runId: a.runId, resolve, reject });
        });
      },

      reportUsage: (delta) => {
        if (!live()) return;
        const run = this.recordUsage(a, delta, actor);
        const cost = delta.costUsd ?? 0;
        if (cost > 0 && run.budgetId && ctx.hasService('budget')) {
          this.spend(a, run.budgetId, (budget, id) => budget.recordSpend(id, cost));
        }
      },

      reserveBudget: (estimateUsd) => this.reserveBudget(a, actor, estimateUsd),

      assertBudgetLeft: () => {
        const budgetId = a.run.budgetId;
        if (!budgetId || !ctx.hasService('budget')) return;
        if (remainingMicroUsd(ctx.service('budget').get(budgetId)) <= 0) {
          throw budgetExceeded('予算の上限に達したため、これ以上実行できません', { budgetId });
        }
      },

      setActivity: (text) => {
        if (!live() || ended()) return;
        const run = this.updateActivity(a.runId, text, actor);
        if (run) a.run = run;
      },
    };
  }

  // ------------------------------------------------------------------ usage & budget

  /** Add usage to the run (run.updated `["usage"]`). */
  private recordUsage(a: ActiveRun, delta: Partial<Usage>, actor: Actor): Run {
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
  private spend(
    a: ActiveRun,
    budgetId: string,
    book: (budget: BudgetService, budgetId: string) => void,
  ): void {
    const budget = this.ctx.service('budget');
    let exhausted = false;
    try {
      book(budget, budgetId);
      exhausted = remainingMicroUsd(budget.get(budgetId)) <= 0;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'budget_exceeded') exhausted = true;
      else this.ctx.log.error('failed to record run spend', { runId: a.runId, err });
    }
    if (exhausted) this.stopForBudget(a);
  }

  private stopForBudget(a: ActiveRun): void {
    if (isTerminalRunStatus(a.run.status) || a.abortKind || a.settled) return;
    a.abortKind = 'budget';
    this.rejectApprovalWaiters(a.runId, abortErr('Budget exhausted'));
    a.abort.abort(abortErr('Budget exhausted'));
  }

  private reserveBudget(a: ActiveRun, actor: Actor, estimateUsd?: number): BudgetHold {
    const { ctx } = this;
    const report = (usage: Partial<Usage>) => {
      if (this.detached) return null;
      return this.recordUsage(a, usage, actor);
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
      return a.reservations.delete(reservation) && !this.detached;
    };
    return {
      amountUsd: reservation.amountUsd,
      settle: (u) => {
        if (!take()) return;
        report(u);
        this.spend(a, budgetId, (b) => b.settle(reservation, Math.max(0, u.costUsd ?? 0)));
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

  // ------------------------------------------------------------------ shutdown

  /** Daemon shutdown: interrupt everything, give executors a moment to unwind. */
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const reason = 'daemon_shutdown';
    try {
      for (const id of this.queue) {
        const run = this.ctx.repos.runs.get(id);
        if (run && !isTerminalRunStatus(run.status)) {
          this.terminate(run, 'interrupted', reason, SYSTEM);
        }
      }
      this.queue = [];
      for (const a of this.active.values()) {
        const run = this.ctx.repos.runs.get(a.runId);
        a.abortKind ??= 'shutdown';
        if (run && !isTerminalRunStatus(run.status)) {
          a.run = this.terminate(run, 'interrupted', reason, SYSTEM);
        }
        this.rejectApprovalWaiters(a.runId, abortErr('Daemon is shutting down'));
        a.abort.abort(abortErr('Daemon is shutting down'));
      }
    } catch (err) {
      this.ctx.log.error('failed to interrupt runs on shutdown', { err });
    }
    const pending = [...this.active.values()].map((a) => a.done);
    if (pending.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((r) => {
          timer = setTimeout(r, this.shutdownGraceMs);
        }),
      ]);
      clearTimeout(timer);
    }
    for (const a of [...this.active.values()]) {
      if (!a.settled) this.cleanup(a);
    }
    this.detached = true;
  }
}
