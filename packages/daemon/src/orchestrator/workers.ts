import {
  type Actor,
  type Artifact,
  type CapabilityGrant,
  type Event,
  type Params,
  type Result,
  type Run,
  type SystemActor,
  type Task,
  type Workspace,
  isTerminalRunStatus,
} from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { conflict, invalidParams } from '../core/errors';
import { textOfParts } from '../llm/messages';
import { anyPatternContains } from '../policy/patterns';
import { freeUsd } from '../policy/budget';
import { truncate } from '../runtime/tools';

/** Actor of decisions the daemon makes on its own (shown as "system" in the timeline). */
export const ORCHESTRATION_SYSTEM: SystemActor = { kind: 'system', component: 'orchestrator' };

/**
 * Capabilities a worker gets by default when an agent spawns it: read its task and
 * workspace, nothing that changes the app. Narrowed to what the spawning grant holds.
 * Workers never get `task.spawnWorker` or `grant.create` unless the caller passes them
 * explicitly (and then the daemon still refuses by depth).
 */
export const WORKER_DEFAULT_PERMISSIONS = [
  'task.get',
  'workspace.get',
  'workspace.diff',
  'artifact.list',
  'artifact.get',
] as const;

/** statusReason of a task whose worker did not complete. */
export const WORKER_REASONS = {
  failed: 'worker_failed',
  cancelled: 'worker_cancelled',
  interrupted: 'worker_interrupted',
} as const;

/** statusReason of a task whose worker completed without changing anything. */
export const NO_CHANGES = 'no_changes';

const SPAWNABLE: Task['status'][] = ['ready', 'failed', 'blocked'];
const MAX_SUMMARY = 2000;

/**
 * Workers (concept §2.2, §11): `task.spawnWorker` and what happens when a worker ends.
 *
 * A worker = a git worktree + an `agent` session + an `agent` run for one task. The caller
 * may be a human (UI "このTaskを実行") or an orchestrating agent; for agents the daemon
 * enforces the grant (permission, project scope, maxWorkers, depth) and carves the worker's
 * grant and budget out of the caller's. When the worker run ends, the task moves to
 * `review` (completed) or `failed` — the worktree and branch are always kept.
 */
export class WorkerService {
  constructor(private readonly ctx: DaemonContext) {}

  async spawn(p: Params<'task.spawnWorker'>, actor: Actor): Promise<Result<'task.spawnWorker'>> {
    const { ctx } = this;
    const policy = ctx.service('policy');
    const task = ctx.repos.tasks.require(p.taskId);
    this.assertSpawnable(task);
    // Fail fast (before creating a worktree); checked again right before the run starts.
    policy.assertCanSpawnWorker(actor, { projectId: task.projectId });

    const workspace = await this.workspaceFor(task, actor);
    const runtime = p.runtime ?? ctx.service('runtimes').defaultId();
    // Validate the runtime name before anything is created.
    ctx.service('runtimes').get(runtime);

    return ctx.db.transaction(() => {
      const cur = ctx.repos.tasks.require(task.id);
      this.assertSpawnable(cur);
      // Synchronous from here to runs.start: two spawns cannot both take the last slot.
      const parentGrant = policy.assertCanSpawnWorker(actor, { projectId: cur.projectId });
      const callerRun = actor.kind === 'agent' ? ctx.repos.runs.get(actor.runId) : undefined;
      const callerSessionId = actor.kind === 'agent' ? actor.sessionId : null;

      const session = ctx.service('sessions').create(
        {
          kind: 'agent',
          projectId: cur.projectId,
          title: `Worker: ${truncate(cur.title, 120)}`,
          model: p.model ?? null,
          runtime,
          workspaceId: workspace.id,
          taskId: cur.id,
          parentSessionId: callerSessionId,
        },
        actor,
      );
      const budget = this.carveBudget(p.budgetUsd, callerRun, parentGrant, session.id, actor);
      let triggerMessageId: string | null = null;
      if (p.instructions?.trim()) {
        triggerMessageId = ctx.service('sessions').appendMessage({
          sessionId: session.id,
          role: 'user',
          content: [{ type: 'text', text: p.instructions.trim() }],
          author: actor,
        }).id;
      }
      const run = ctx.service('runs').start({
        sessionId: session.id,
        kind: 'agent',
        createdBy: actor,
        taskId: cur.id,
        projectId: cur.projectId,
        workspaceId: workspace.id,
        parentRunId: callerRun?.id ?? null,
        model: p.model ?? null,
        runtime,
        budgetId: budget?.id ?? null,
        triggerMessageId,
      });
      this.grantWorker(run, parentGrant, p.permissions, actor);
      ctx.service('tasks').setStatus(cur.id, 'running', actor, null, {
        assigneeSessionId: session.id,
        workspaceId: workspace.id,
        resultSummary: null,
      });
      this.decide(
        {
          decision: `Worker を起動しました: ${truncate(cur.title, 80)}`,
          rationale: spawnRationale({
            workspace,
            runtime,
            budgetUsd: budget?.limitUsd ?? null,
            grant: parentGrant,
            active: callerRun ? policy.activeWorkerCount(callerRun.id) : null,
          }),
          taskIds: [cur.id],
          sessionIds: [session.id],
          runIds: [run.id],
        },
        {
          projectId: cur.projectId,
          sessionId: callerSessionId ?? session.id,
          runId: callerRun?.id ?? run.id,
          taskId: cur.id,
        },
      );
      return {
        sessionId: session.id,
        runId: run.id,
        workspaceId: workspace.id,
        budgetId: budget?.id ?? null,
      };
    });
  }

  /**
   * React to the end of an agent run that works on a task it is assigned to: completed →
   * review (or review with `no_changes`), anything else → failed with the reason. Tasks
   * moved on by someone else (cancelled, already reviewed …) are left alone.
   */
  onRunEnded(run: Run): void {
    const { ctx } = this;
    if (run.kind !== 'agent' || !run.taskId || !isTerminalRunStatus(run.status)) return;
    const task = ctx.repos.tasks.get(run.taskId);
    if (!task || task.status !== 'running' || task.assigneeSessionId !== run.sessionId) return;
    const session = ctx.repos.sessions.get(run.sessionId);
    const refs = {
      projectId: task.projectId,
      sessionId: session?.parentSessionId ?? run.sessionId,
      runId: run.parentRunId ?? run.id,
      taskId: task.id,
    };
    const ids = { taskIds: [task.id], sessionIds: [run.sessionId], runIds: [run.id] };
    ctx.db.transaction(() => {
      if (run.status === 'completed') {
        const diff = this.latestDiff(task.id, run.id);
        const stats = diff?.kind === 'diff' ? diff.data.stats : null;
        ctx
          .service('tasks')
          .setStatus(
            task.id,
            'review',
            ORCHESTRATION_SYSTEM,
            stats && stats.files > 0 ? null : NO_CHANGES,
            { resultSummary: this.lastAssistantText(run) },
          );
        this.decide(
          {
            decision: `Task をレビュー待ちにしました: ${truncate(task.title, 80)}`,
            rationale: stats
              ? `Worker の Run が完了し、変更（${stats.files} ファイル、+${stats.additions} −${stats.deletions}）がコミットされて差分が記録されました。`
              : 'Worker の Run は完了しましたが、ファイルの変更はありませんでした。',
            ...ids,
          },
          refs,
        );
        return;
      }
      const status = run.status as 'failed' | 'cancelled' | 'interrupted';
      const reason = WORKER_REASONS[status];
      const why =
        run.error?.message ??
        (status === 'cancelled' ? 'Run がキャンセルされました' : 'Run が中断されました');
      ctx.service('tasks').setStatus(task.id, 'failed', ORCHESTRATION_SYSTEM, reason, {
        resultSummary: truncate(why, MAX_SUMMARY),
      });
      this.decide(
        {
          decision: `Task を失敗にしました: ${truncate(task.title, 80)}`,
          rationale: `Worker の Run が ${status} で終わりました（${truncate(why, 300)}）。worktree とブランチは残しています。`,
          ...ids,
        },
        refs,
      );
    });
  }

  /** Startup: tasks still `running` whose worker run already ended (e.g. before a restart). */
  reconcile(): number {
    const { ctx } = this;
    let n = 0;
    for (const task of ctx.repos.tasks.find({ where: { status: 'running' } })) {
      if (!task.assigneeSessionId) continue;
      const run = ctx.repos.runs.findOne({
        where: { task_id: task.id, session_id: task.assigneeSessionId },
        direction: 'desc',
      });
      if (run && isTerminalRunStatus(run.status)) {
        this.onRunEnded(run);
        n++;
      }
    }
    return n;
  }

  /** Emit orchestrator.decision. */
  decide(
    d: {
      decision: string;
      rationale: string;
      taskIds?: string[];
      sessionIds?: string[];
      runIds?: string[];
    },
    refs: {
      projectId: string | null;
      sessionId: string | null;
      runId: string | null;
      taskId?: string | null;
    },
    actor: Actor = ORCHESTRATION_SYSTEM,
  ): void {
    const r: { taskIds?: string[]; sessionIds?: string[]; runIds?: string[] } = {};
    if (d.taskIds?.length) r.taskIds = d.taskIds;
    if (d.sessionIds?.length) r.sessionIds = d.sessionIds;
    if (d.runIds?.length) r.runIds = d.runIds;
    this.ctx.bus.emit({
      type: 'orchestrator.decision',
      actor,
      payload: {
        decision: d.decision,
        rationale: d.rationale,
        ...(Object.keys(r).length > 0 ? { refs: r } : {}),
      },
      refs: { taskId: null, ...refs },
    });
  }

  // -------------------------------------------------------------------------

  private assertSpawnable(task: Task): void {
    if (task.status === 'running') {
      throw conflict(`タスク「${task.title}」はすでに実行中です`, { taskId: task.id });
    }
    if (task.status === 'blocked' && task.statusReason?.startsWith('dependency_')) {
      throw conflict(`タスク「${task.title}」は依存タスクの失敗で止まっています`, {
        taskId: task.id,
        status: task.status,
      });
    }
    if (!SPAWNABLE.includes(task.status)) {
      const why =
        task.status === 'pending'
          ? '依存タスクがまだ終わっていません'
          : `この状態（${task.status}）では Worker を起動できません`;
      throw conflict(`タスク「${task.title}」: ${why}`, { taskId: task.id, status: task.status });
    }
  }

  /** The task's existing worktree (retry after a failure), else a new one named after it. */
  private async workspaceFor(task: Task, actor: Actor): Promise<Workspace> {
    const workspaces = this.ctx.service('workspaces');
    if (task.workspaceId) {
      const ws = this.ctx.repos.workspaces.get(task.workspaceId);
      if (ws && ws.status === 'ready' && ws.kind === 'worktree') {
        if (workspaces.isLocked(ws.id)) {
          throw conflict('このタスクのワークスペースは別の Run が使用中です', {
            workspaceId: ws.id,
          });
        }
        return ws;
      }
    }
    return workspaces.createWorktree({
      projectId: task.projectId,
      label: task.title,
      taskId: task.id,
      actor,
    });
  }

  /**
   * The worker's budget: a slice of the calling run's budget when it has one (the requested
   * amount, else an equal share of what is free among the worker slots left). A human may
   * give a worker its own root budget with `budgetUsd`.
   */
  private carveBudget(
    budgetUsd: number | undefined,
    callerRun: Run | undefined,
    grant: CapabilityGrant | null,
    workerSessionId: string,
    actor: Actor,
  ) {
    const budget = this.ctx.service('budget');
    const subject = { kind: 'session' as const, id: workerSessionId };
    if (callerRun?.budgetId) {
      const parent = budget.get(callerRun.budgetId);
      let amount = budgetUsd;
      if (amount === undefined) {
        const active = this.ctx.service('policy').activeWorkerCount(callerRun.id);
        const slots = Math.max(1, (grant?.limits.maxWorkers ?? 2) - active);
        amount = Math.floor((freeUsd(parent) / slots) * 1e6) / 1e6;
      }
      if (amount <= 0) {
        throw invalidParams('呼び出し元の予算に空きがないため Worker を起動できません', {
          budgetId: parent.id,
        });
      }
      return budget.allocate({ parentId: parent.id, subject, limitUsd: amount, actor });
    }
    if (budgetUsd === undefined) return null;
    if (actor.kind === 'agent') {
      throw invalidParams('この Run には予算がないため、Worker に予算を配分できません');
    }
    return budget.createRoot({ subject, limitUsd: budgetUsd, actor });
  }

  /**
   * Agents delegate a run-lifetime grant to the worker (subset of their own, depth + 1,
   * maxDepth 0, maxWorkers 0) so the worker can never spawn workers or delegate further.
   */
  private grantWorker(
    run: Run,
    parentGrant: CapabilityGrant | null,
    requested: string[] | undefined,
    actor: Actor,
  ): void {
    const policy = this.ctx.service('policy');
    if (actor.kind === 'agent' && parentGrant) {
      const permissions = (requested ?? [...WORKER_DEFAULT_PERMISSIONS]).filter(
        (p) => requested !== undefined || anyPatternContains(parentGrant.permissions, p),
      );
      if (permissions.length === 0) return;
      policy.createGrant(
        {
          subject: { kind: 'run', runId: run.id },
          permissions,
          limits: { maxWorkers: 0, maxDepth: 0 },
          lifetime: 'run',
          parentGrantId: parentGrant.id,
          reason: 'worker',
        },
        actor,
        { via: 'task.spawnWorker' },
      );
      return;
    }
    if (requested?.length) {
      policy.createGrant(
        {
          subject: { kind: 'run', runId: run.id },
          permissions: requested,
          limits: { maxWorkers: 0, maxDepth: 0 },
          lifetime: 'run',
          reason: 'worker',
        },
        actor,
      );
    }
  }

  private latestDiff(taskId: string, runId: string): Artifact | undefined {
    return (
      this.ctx.repos.artifacts.findOne({
        where: { task_id: taskId, run_id: runId, kind: 'diff' },
        direction: 'desc',
      }) ??
      this.ctx.repos.artifacts.findOne({
        where: { task_id: taskId, kind: 'diff' },
        direction: 'desc',
      })
    );
  }

  private lastAssistantText(run: Run): string | null {
    const msgs = this.ctx.repos.messages.find({
      where: { session_id: run.sessionId },
      orderBy: 'id',
      direction: 'desc',
      limit: 20,
    });
    for (const m of msgs) {
      if (m.role !== 'assistant' || m.runId !== run.id) continue;
      const text = textOfParts(m.content).trim();
      if (text) return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text;
    }
    return null;
  }
}

function spawnRationale(i: {
  workspace: Workspace;
  runtime: string;
  budgetUsd: number | null;
  grant: CapabilityGrant | null;
  active: number | null;
}): string {
  const parts = [
    `専用の worktree（${i.workspace.branch ?? i.workspace.id}）で、ランタイム ${i.runtime} を使って作業します。`,
  ];
  if (i.grant?.limits.maxWorkers !== undefined && i.active !== null) {
    parts.push(
      `同時に動かせる Worker は ${i.grant.limits.maxWorkers} 人まで（現在 ${i.active} 人）。`,
    );
  }
  if (i.budgetUsd !== null) parts.push(`予算 $${i.budgetUsd} を割り当てました。`);
  return parts.join('');
}

/** Whether an event ends a run (used to drive task status from worker runs). */
export function runEndedBy(e: Event): string | null {
  if (e.type !== 'run.status_changed') return null;
  return isTerminalRunStatus(e.payload.to) ? e.payload.runId : null;
}
