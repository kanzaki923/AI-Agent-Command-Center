import type {
  Actor,
  BudgetAllocation,
  CapabilityGrant,
  ContentPart,
  Message,
  MessageMeta,
  Params,
  Result,
  Run,
  Session,
  SessionBrief,
  SystemActor,
  Task,
  Workspace,
  WorkspaceSpec,
} from '@acc/protocol';
import { isTerminalRunStatus } from '@acc/protocol';
import type { SpawnOptions, SpawnerService } from '../contracts';
import type { DaemonContext } from '../core/context';
import { budgetExceeded, conflict, forbidden, invalidParams } from '../core/errors';
import { runKindFor } from '../inbox/supervision';
import { delegateSession } from '../orchestrator/grant';
import { freeUsd } from '../policy/budget';
import { CHILD_DEFAULT_PERMISSIONS, CHILD_GRANT_REASON } from '../policy/grants';
import { isInside } from '../runtime/policy';
import { truncate } from '../runtime/tools';
import { resolveChatModel } from './chat';
import { sessionBudgetId } from './methods/shared';

/** Actor of what the spawner does on its own (the children's baseline grant, auto-starts). */
export const SPAWNER_SYSTEM: SystemActor = { kind: 'system', component: 'spawner' };

/** Children a supervising schedule firing may lead at once (the session.delegate default). */
const SUPERVISED_FIRING_MAX_CHILDREN = 4;

/** `reason` of grants a caller passes to a child explicitly (`permissions`). */
export const DELEGATED_CHILD_GRANT_REASON = 'delegated';

/** Task statuses a run of a spawned child moves back to `running` (it works on it again). */
const REOPENABLE: readonly Task['status'][] = [
  'pending',
  'ready',
  'blocked',
  'review',
  'failed',
  'paused',
];

/**
 * Where a child (or an agent session) will work, prepared before the transaction that creates
 * it: `scratch` is created inside it (its path needs the session id); `folder` / `worktree`
 * already exist (`created`: a worktree made for this call, removed if creation fails).
 */
export type PreparedWorkspace =
  | { kind: 'nothing' }
  | { kind: 'scratch' }
  | { kind: 'ready'; workspace: Workspace; created: boolean };

/**
 * The project a spawned child belongs to: the one asked for, else the worktree's, else the
 * parent's. Shared by the method's scope (grants) and the spawner, so both agree.
 */
export function spawnProjectId(
  ctx: DaemonContext,
  p: Pick<Params<'session.spawn'>, 'projectId' | 'workspace'>,
  parentSessionId: string | null,
): string | null {
  if (p.projectId) return p.projectId;
  if (p.workspace?.kind === 'worktree') return p.workspace.projectId;
  const parent = parentSessionId ? ctx.repos.sessions.get(parentSessionId) : undefined;
  return parent?.projectId ?? null;
}

/**
 * Children (spec 20261029 §3.3, architecture.md §2.14): `session.spawn` and schedule firings
 * create a child session that works on its own and finishes by leaving outputs.
 *
 * A child = a session (`chat` or `agent`, below its parent in the session tree, with the
 * request as `brief` and as its first message) + a Task recording its work (dependencies on
 * siblings via `after`) + for agents a workspace (scratch by default; a folder of the
 * user's; a git worktree only when asked) + a slice of the caller's budget + the children's
 * baseline grant. It starts right away unless it waits for siblings (`after`) or for a free
 * slot (`maxChildren`); the daemon starts it later (`startWaiting`). How it ends is decided
 * by `workers.onRunEnded` (orchestrator/workers.ts, §3.4).
 */
export class Spawner implements SpawnerService {
  constructor(private readonly ctx: DaemonContext) {}

  async spawn(
    p: Params<'session.spawn'>,
    actor: Actor,
    opts: SpawnOptions = {},
  ): Promise<Result<'session.spawn'>> {
    const { ctx } = this;
    const parentId = p.parentSessionId ?? (actor.kind === 'agent' ? actor.sessionId : null);
    const parent = parentId ? ctx.repos.sessions.require(parentId) : null;
    if (parent?.archivedAt) throw conflict('アーカイブ済みの会話の下には子を作れません');
    const projectId = spawnProjectId(ctx, p, parentId);
    if (p.projectId && p.workspace?.kind === 'worktree' && p.workspace.projectId !== p.projectId) {
      throw invalidParams('projectId と作業場所（worktree）のプロジェクトが違います');
    }
    if (projectId) {
      const project = ctx.repos.projects.require(projectId);
      if (project.archivedAt) throw conflict('アーカイブ済みのプロジェクトには子を作れません');
    }
    // Fail fast (before a worktree or a scratch folder exists); checked again right before
    // the run starts.
    const allowed = parent
      ? this.policy()?.assertCanSpawnChild(actor, { parentSessionId: parent.id, projectId })
      : undefined;
    if (opts.supervise && p.mode !== 'chat') {
      throw invalidParams('子を率いる子（supervise）は普通の会話（mode: chat）だけです');
    }
    if (opts.budget) {
      this.assertFixedBudgetFits(opts.budget);
    } else {
      planChildBudget(ctx, {
        budgetUsd: p.budgetUsd,
        minUsd: this.minChildBudget(p.mode),
        callerRun: actor.kind === 'agent' ? ctx.repos.runs.get(actor.runId) : undefined,
        grant: allowed?.grant ?? null,
        actor,
      });
    }
    const after = this.siblings(p.after ?? [], parent?.id ?? null);
    const runtime = p.mode === 'agent' ? (p.runtime ?? ctx.service('runtimes').defaultId()) : null;
    if (runtime) ctx.service('runtimes').get(runtime);

    const prepared = await prepareWorkspace(ctx, {
      mode: p.mode,
      spec: p.workspace,
      projectId,
      label: p.title,
      actor,
    });
    try {
      return ctx.db.transaction(() =>
        this.create({ p, actor, opts, parent, projectId, after, runtime, prepared }),
      );
    } catch (err) {
      if (prepared.kind === 'ready' && prepared.created) {
        await ctx
          .service('workspaceManager')
          .remove(prepared.workspace.id, { force: true, actor: SPAWNER_SYSTEM })
          .catch(() => undefined);
      }
      throw err;
    }
  }

  /**
   * Start the children of `parentSessionId` that wait for nothing any more: never started,
   * auto-start on, their task `ready` (dependencies done), while a child slot is free.
   * Called when a sibling's task becomes ready and when a child's run ends.
   */
  startWaiting(parentSessionId: string): string[] {
    const started: string[] = [];
    const children = this.ctx.repos.sessions.find({
      where: { parent_session_id: parentSessionId, archived_at: null },
      direction: 'asc',
    });
    for (const child of children) {
      const r = this.tryStart(child.id);
      if (r === 'no_slot') break;
      if (r !== 'not_waiting') started.push(r.runId);
    }
    return started;
  }

  /**
   * Start one child if it waits for nothing any more and its parent has a free child slot.
   * Returns the started run, or why it did not start.
   */
  tryStart(childSessionId: string): { runId: string } | 'not_waiting' | 'no_slot' {
    const { ctx } = this;
    return ctx.db.transaction(() => {
      const child = ctx.repos.sessions.get(childSessionId);
      if (!child?.brief || !child.taskId || child.archivedAt) return 'not_waiting';
      const task = ctx.repos.tasks.get(child.taskId);
      if (!task || !this.isWaiting(task, child)) return 'not_waiting';
      if (child.parentSessionId && !this.slotFree(child.parentSessionId)) return 'no_slot';
      const run = this.startChild(child, task, task.createdBy, {
        parentRunId: null,
        trigger: 'spawn',
        triggerMessageId: this.briefMessage(child.id)?.id ?? null,
      });
      return { runId: run.id };
    });
  }

  /**
   * Subscriptions (sessions module start): start waiting children when a sibling's task
   * becomes ready or a child's run ends, and move a spawned child's task back to `running`
   * when a new run of it starts (an answer, a retry, a message). At startup, start what was
   * left waiting.
   */
  start(): () => void {
    const { ctx } = this;
    const offTask = ctx.bus.subscribe({ types: ['task.updated'] }, (e) => {
      if (e.type !== 'task.updated') return;
      const { task, changes } = e.payload;
      if (task.status !== 'ready' || !changes.includes('status') || !task.assigneeSessionId) return;
      const childId = task.assigneeSessionId;
      this.safely(() => this.tryStart(childId));
    });
    const offRun = ctx.bus.subscribe({ types: ['run.created', 'run.status_changed'] }, (e) => {
      if (e.type === 'run.created') {
        this.safely(() => this.reopen(e.payload.run));
        return;
      }
      if (e.type !== 'run.status_changed' || !isTerminalRunStatus(e.payload.to)) return;
      const parent = e.sessionId ? ctx.repos.sessions.get(e.sessionId)?.parentSessionId : null;
      if (parent) this.safely(() => this.startWaiting(parent));
    });
    // After every module started (executors registered): what waited before the restart.
    const timer = setImmediate(() => {
      for (const task of ctx.repos.tasks.find({ where: { status: 'ready' }, direction: 'asc' })) {
        if (!task.autoStart || task.statusReason !== null || !task.assigneeSessionId) continue;
        const childId = task.assigneeSessionId;
        this.safely(() => this.tryStart(childId));
      }
    });
    return () => {
      offTask();
      offRun();
      clearImmediate(timer);
    };
  }

  // -------------------------------------------------------------------------

  private create(i: {
    p: Params<'session.spawn'>;
    actor: Actor;
    opts: SpawnOptions;
    parent: Session | null;
    projectId: string | null;
    after: { session: Session; task: Task }[];
    runtime: string | null;
    prepared: PreparedWorkspace;
  }): Result<'session.spawn'> {
    const { ctx } = this;
    const { p, actor, opts, parent, projectId, prepared } = i;
    // Synchronous from here to runs.start: two spawns cannot both take the last slot.
    const allowed = parent
      ? (this.policy()?.assertCanSpawnChild(actor, { parentSessionId: parent.id, projectId }) ?? {
          grant: null,
          slotFree: true,
        })
      : { grant: null, slotFree: true };
    const callerRun = actor.kind === 'agent' ? ctx.repos.runs.get(actor.runId) : undefined;
    const now = ctx.clock.iso();
    const doneWhen = p.doneWhen ?? [];
    const brief: SessionBrief = {
      goal: p.goal,
      doneWhen,
      fromSessionId: actor.kind === 'agent' ? actor.sessionId : null,
      reviewBy: p.reviewBy,
      givenAt: now,
    };
    const workspaceId = prepared.kind === 'ready' ? prepared.workspace.id : null;
    const task = ctx.service('tasks').createChildTask({
      projectId,
      title: p.title,
      description: p.goal,
      acceptanceCriteria: doneWhen,
      dependsOn: i.after.map((a) => a.task.id),
      workspaceId,
      autoStart: p.start,
      actor,
    });
    let session = ctx.service('sessions').create(
      {
        kind: p.mode,
        projectId,
        title: p.title,
        model: p.model ?? null,
        runtime: i.runtime,
        workspaceId,
        taskId: task.id,
        parentSessionId: parent?.id ?? null,
        brief,
        scheduleId: opts.scheduleId ?? null,
      },
      actor,
    );
    session = attachWorkspace(ctx, session, prepared, actor);
    const budget = opts.budget
      ? this.fixedBudget(opts.budget, session.id, actor)
      : carveChildBudget(ctx, {
          budgetUsd: p.budgetUsd,
          minUsd: this.minChildBudget(p.mode),
          callerRun,
          grant: allowed.grant,
          childSessionId: session.id,
          actor,
        });
    this.grantChild(session.id, allowed.grant, p.permissions, actor);
    if (opts.supervise) {
      // A human-made schedule's firing that leads children of its own (spec §1.9 / §3.11):
      // the supervisor preset on the child itself (its children are depth 1 below it). Its
      // budget above is kept as the supervisor's budget.
      delegateSession(
        ctx,
        {
          sessionId: session.id,
          maxChildren: SUPERVISED_FIRING_MAX_CHILDREN,
          budgetUsd: opts.budget?.limitUsd ?? 1,
          allowSchedules: false,
          lifetime: 'work',
        },
        actor,
      );
    }
    const meta: MessageMeta =
      opts.scheduleId && opts.scheduledFor
        ? { kind: 'schedule', scheduleId: opts.scheduleId, scheduledFor: opts.scheduledFor }
        : { kind: 'brief', brief };
    const message = ctx.service('sessions').appendMessage({
      sessionId: session.id,
      role: 'user',
      content: briefContent(brief),
      author: actor,
      meta,
    });
    const assigned = ctx
      .service('tasks')
      .setStatus(task.id, task.status, actor, task.statusReason, {
        assigneeSessionId: session.id,
        workspaceId: session.workspaceId,
      });

    let run: Run | null = null;
    if (p.start && assigned.status === 'ready' && allowed.slotFree) {
      run = this.startChild(ctx.repos.sessions.require(session.id), assigned, actor, {
        parentRunId: callerRun?.id ?? null,
        trigger: opts.trigger ?? 'spawn',
        triggerMessageId: message.id,
      });
    }
    ctx.bus.emit({
      type: 'orchestrator.decision',
      actor: SPAWNER_SYSTEM,
      payload: {
        decision: `「${truncate(p.title, 60)}」を任せました`,
        rationale: truncate(firstLine(p.goal), 200),
        refs: {
          taskIds: [task.id],
          sessionIds: [session.id],
          ...(run ? { runIds: [run.id] } : {}),
        },
      },
      refs: {
        projectId,
        sessionId: parent?.id ?? session.id,
        runId: callerRun?.id ?? run?.id ?? null,
        taskId: task.id,
      },
    });
    return {
      session: ctx.repos.sessions.require(session.id),
      runId: run?.id ?? null,
      budgetId: budget?.id ?? null,
      waitingFor: i.after.filter((a) => a.task.status !== 'done').map((a) => a.session.id),
    };
  }

  /** A budget the daemon decided (schedules): it must fit before anything is created. */
  private assertFixedBudgetFits(b: NonNullable<SpawnOptions['budget']>): void {
    if (!b.parentBudgetId) return;
    const free = this.ctx.service('budget').available(b.parentBudgetId).freeUsd;
    if (free + 1e-9 < b.limitUsd) {
      throw budgetExceeded(
        `予算の空き（$${Math.max(0, free).toFixed(2)}）が足りないため、子を起こせません（$${b.limitUsd} が必要）`,
        { budgetId: b.parentBudgetId, freeUsd: free, limitUsd: b.limitUsd },
      );
    }
  }

  /** Carve the fixed amount from its parent budget, or a new root budget (human-made). */
  private fixedBudget(
    b: NonNullable<SpawnOptions['budget']>,
    sessionId: string,
    actor: Actor,
  ): BudgetAllocation {
    const budget = this.ctx.service('budget');
    const subject = { kind: 'session' as const, id: sessionId };
    return b.parentBudgetId
      ? budget.allocate({ parentId: b.parentBudgetId, subject, limitUsd: b.limitUsd, actor })
      : budget.createRoot({ subject, limitUsd: b.limitUsd, actor });
  }

  /** Start a child's run (chat or agent) and mark its task running. */
  private startChild(
    session: Session,
    task: Task,
    actor: Actor,
    opts: {
      parentRunId: string | null;
      trigger: NonNullable<SpawnOptions['trigger']>;
      triggerMessageId: string | null;
    },
  ): Run {
    const { ctx } = this;
    const agent = session.kind === 'agent';
    const run = ctx.service('runs').start({
      sessionId: session.id,
      // A chat child that leads children (a supervising schedule firing) runs as a supervisor.
      kind: runKindFor(ctx, session),
      createdBy: actor,
      taskId: task.id,
      projectId: session.projectId,
      workspaceId: agent ? session.workspaceId : null,
      parentRunId: opts.parentRunId,
      model: agent ? session.model : resolveChatModel(ctx, session.model),
      runtime: session.runtime,
      budgetId: sessionBudgetId(ctx, session.id),
      triggerMessageId: opts.triggerMessageId,
      trigger: opts.trigger,
    });
    ctx.service('tasks').setStatus(task.id, 'running', actor, null, {
      assigneeSessionId: session.id,
      resultSummary: null,
    });
    return run;
  }

  /** A run started in a spawned child whose task had moved on: it works on it again. */
  private reopen(run: Run): void {
    const { ctx } = this;
    const session = ctx.repos.sessions.get(run.sessionId);
    if (!session?.brief || !session.taskId) return;
    const task = ctx.repos.tasks.get(session.taskId);
    if (!task || task.assigneeSessionId !== session.id || !REOPENABLE.includes(task.status)) return;
    if (task.status === 'blocked' && task.statusReason?.startsWith('dependency_')) return;
    const cur = ctx.repos.runs.get(run.id);
    if (!cur || isTerminalRunStatus(cur.status)) return;
    ctx
      .service('tasks')
      .setStatus(task.id, 'running', SPAWNER_SYSTEM, null, { resultSummary: null });
  }

  /** Never started, set to start by itself, dependencies done. */
  private isWaiting(task: Task, child: Session): boolean {
    const { ctx } = this;
    return (
      task.status === 'ready' &&
      task.autoStart &&
      task.statusReason === null &&
      task.assigneeSessionId === child.id &&
      ctx.repos.runs.count({ where: { session_id: child.id } }) === 0
    );
  }

  private slotFree(parentSessionId: string): boolean {
    const policy = this.policy();
    if (!policy) return true;
    const limit = policy.childLimitOfSession(parentSessionId);
    return limit === undefined || policy.activeChildCount(parentSessionId) < limit;
  }

  private briefMessage(sessionId: string): Message | undefined {
    return this.ctx.repos.messages.find({
      where: { session_id: sessionId },
      orderBy: 'id',
      direction: 'asc',
      limit: 1,
    })[0];
  }

  /** `after`: children of the same parent, each with its task. */
  private siblings(ids: string[], parentId: string | null): { session: Session; task: Task }[] {
    const { repos } = this.ctx;
    return [...new Set(ids)].map((id) => {
      const session = repos.sessions.get(id);
      const task = session?.taskId ? repos.tasks.get(session.taskId) : undefined;
      if (!session || !task || !session.brief || session.parentSessionId !== parentId) {
        throw invalidParams(`after に指定できるのは同じ親の子だけです: ${id}`, { sessionId: id });
      }
      return { session, task };
    });
  }

  /**
   * The child's capabilities (§3.3-6): the daemon's baseline for every child (publish its
   * outputs, ask a human, read itself; lifetime `work`, no children of its own), plus what
   * the caller passes in `permissions` — delegated from the caller's grant under the subset
   * rules (depth + 1, maxChildren 0).
   */
  private grantChild(
    childSessionId: string,
    parentGrant: CapabilityGrant | null,
    requested: string[] | undefined,
    actor: Actor,
  ): void {
    if (!this.ctx.hasService('policy')) return;
    const policy = this.ctx.service('policy');
    const noChildren = { maxChildren: 0, maxWorkers: 0, maxDepth: 0 };
    policy.createGrant(
      {
        subject: { kind: 'session', sessionId: childSessionId },
        permissions: [...CHILD_DEFAULT_PERMISSIONS],
        limits: noChildren,
        lifetime: 'work',
        reason: CHILD_GRANT_REASON,
      },
      SPAWNER_SYSTEM,
    );
    if (!requested?.length) return;
    policy.createGrant(
      {
        subject: { kind: 'session', sessionId: childSessionId },
        permissions: requested,
        limits: noChildren,
        lifetime: 'work',
        parentGrantId: parentGrant?.id ?? null,
        reason: DELEGATED_CHILD_GRANT_REASON,
      },
      actor,
      { via: 'session.spawn' },
    );
  }

  /** Chats reserve `llmCallReserveUsd` before each LLM call; agents report afterwards. */
  private minChildBudget(mode: 'chat' | 'agent'): number {
    return mode === 'chat' ? this.ctx.settings.get().llmCallReserveUsd : 0;
  }

  private policy() {
    return this.ctx.hasService('policy') ? this.ctx.service('policy') : null;
  }

  private safely(fn: () => unknown): void {
    try {
      fn();
    } catch (err) {
      this.ctx.log.error('spawner: failed to start or update a child', { err });
    }
  }
}

/**
 * Resolve where an agent works (§3.3): `none` (default) → a scratch folder; `folder` → a
 * folder of the user's (agents: only inside their project's folder); `worktree` → a new git
 * worktree of a code project. Chats have no workspace.
 */
export async function prepareWorkspace(
  ctx: DaemonContext,
  input: {
    mode: 'chat' | 'agent';
    spec: WorkspaceSpec | undefined;
    projectId: string | null;
    label: string;
    actor: Actor;
  },
): Promise<PreparedWorkspace> {
  const spec = input.spec ?? { kind: 'none' };
  if (input.mode === 'chat') {
    if (spec.kind !== 'none') {
      throw invalidParams(
        '普通の会話（chat）は作業場所を持ちません。mode: agent を指定してください',
      );
    }
    return { kind: 'nothing' };
  }
  if (spec.kind === 'none') return { kind: 'scratch' };
  if (spec.kind === 'folder') {
    if (input.actor.kind === 'agent') {
      // An agent must not hand a child write access to any folder it names (e.g. the
      // user's home): only the project's own folder, which a human chose.
      const project = input.projectId ? ctx.repos.projects.get(input.projectId) : undefined;
      if (!project?.folderPath || !isInside(spec.path, project.folderPath)) {
        throw forbidden(
          'エージェントが作業場所にできるフォルダは、プロジェクトのフォルダの中だけです',
        );
      }
    }
    const workspace = ctx
      .service('workspaceManager')
      .ensureDirectory({ path: spec.path, projectId: input.projectId, actor: input.actor });
    return { kind: 'ready', workspace, created: false };
  }
  const project = ctx.repos.projects.require(spec.projectId);
  if (!project.repoPath) {
    throw invalidParams(
      `プロジェクト「${project.name}」にはコード（リポジトリ）がないため、worktree を作れません`,
    );
  }
  const workspace = await ctx.service('workspaces').createWorktree({
    projectId: project.id,
    label: input.label,
    ...(spec.baseRef ? { baseRef: spec.baseRef } : {}),
    actor: input.actor,
  });
  return { kind: 'ready', workspace, created: true };
}

/**
 * After an agent session was created inside the transaction: give it the prepared
 * workspace (scratch is made now, named after the session). Returns the session.
 */
export function attachWorkspace(
  ctx: DaemonContext,
  session: Session,
  prepared: PreparedWorkspace,
  actor: Actor,
): Session {
  if (prepared.kind !== 'scratch') return session;
  const workspace = ctx
    .service('workspaceManager')
    .createScratch({ sessionId: session.id, projectId: session.projectId, actor });
  const updated = ctx.repos.sessions.update(session.id, (s) => ({
    ...s,
    workspaceId: workspace.id,
    updatedAt: ctx.clock.iso(),
  }));
  ctx.bus.emit({
    type: 'session.updated',
    actor,
    payload: { session: updated, changes: ['workspaceId'] },
  });
  return updated;
}

/**
 * A child's budget (spec 20261029 §3.3-5): a slice of the calling run's budget when it has
 * one — the amount asked for, else an equal share of what is free (keeping two LLM-call
 * reservations for the caller) among the child slots left plus one. A caller with a budget
 * cannot start a child outside it (budget_exceeded). A human (or the scheduler) may give a
 * child its own root budget; an agent without a budget gives none.
 */
export function carveChildBudget(
  ctx: DaemonContext,
  i: ChildBudgetInput & { childSessionId: string },
): BudgetAllocation | null {
  const plan = planChildBudget(ctx, i);
  if (!plan) return null;
  const budget = ctx.service('budget');
  const subject = { kind: 'session' as const, id: i.childSessionId };
  return 'parentId' in plan
    ? budget.allocate({
        parentId: plan.parentId,
        subject,
        limitUsd: plan.amountUsd,
        actor: i.actor,
      })
    : budget.createRoot({ subject, limitUsd: plan.amountUsd, actor: i.actor });
}

export interface ChildBudgetInput {
  budgetUsd: number | undefined;
  /** Smallest default share that lets the child run (a chat child's call reservation). */
  minUsd?: number;
  callerRun: Run | undefined;
  grant: CapabilityGrant | null;
  actor: Actor;
}

/**
 * What carveChildBudget would do, checked without changing anything (fail fast before a
 * worktree or a scratch folder exists). Throws budget_exceeded when it would not fit.
 */
export function planChildBudget(
  ctx: DaemonContext,
  i: ChildBudgetInput,
): { parentId: string; amountUsd: number } | { amountUsd: number } | null {
  if (i.callerRun?.budgetId) {
    const parent = ctx.service('budget').get(i.callerRun.budgetId);
    let amount = i.budgetUsd;
    if (amount === undefined) {
      const keep = ctx.settings.get().llmCallReserveUsd * 2;
      const limit = i.grant ? (i.grant.limits.maxChildren ?? i.grant.limits.maxWorkers ?? 2) : 2;
      const active = ctx.hasService('policy')
        ? ctx.service('policy').activeChildCount(i.callerRun.sessionId)
        : 0;
      const slots = Math.max(1, limit - active) + 1;
      amount = Math.floor(((freeUsd(parent) - keep) / slots) * 1e6) / 1e6;
      // A chat child reserves one LLM call's worth before each call: a smaller share could
      // never run, so it gets at least that much (or nothing when even that does not fit).
      const min = i.minUsd ?? 0;
      if (amount < min) amount = min <= freeUsd(parent) - keep ? min : 0;
    }
    if (amount <= 0 || amount > freeUsd(parent) || parent.status !== 'active') {
      throw budgetExceeded('依頼者の予算に空きがないため、子を起こせません', {
        budgetId: parent.id,
        freeUsd: Math.max(0, freeUsd(parent)),
        requestedUsd: amount,
      });
    }
    return { parentId: parent.id, amountUsd: amount };
  }
  if (i.budgetUsd === undefined) return null;
  if (i.actor.kind === 'agent') {
    throw invalidParams('この実行には予算がないため、子に予算を配分できません');
  }
  return { amountUsd: i.budgetUsd };
}

/** The child's first message: the request, then its completion criteria. */
export function briefContent(brief: Pick<SessionBrief, 'goal' | 'doneWhen'>): ContentPart[] {
  const parts = [brief.goal.trim()];
  if (brief.doneWhen.length > 0) {
    parts.push('', '## 完了条件', ...brief.doneWhen.map((c) => `- ${c}`));
  }
  return [{ type: 'text', text: parts.join('\n') }];
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find(Boolean) ?? ''
  );
}
