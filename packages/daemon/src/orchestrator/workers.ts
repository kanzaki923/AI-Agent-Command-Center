import {
  type Actor,
  type Artifact,
  type AttentionKind,
  type CapabilityGrant,
  type Event,
  type Integration,
  type IntegrationStep,
  type Params,
  type Result,
  type Run,
  type Session,
  type SystemActor,
  type Task,
  type TaskStatus,
  type Workspace,
  isTerminalRunStatus,
} from '@acc/protocol';
import type { FinalizeResult } from '../contracts';
import type { DaemonContext } from '../core/context';
import { conflict, invalidParams } from '../core/errors';
import { textOfParts } from '../llm/messages';
import { anyPatternContains } from '../policy/patterns';
import { freeUsd } from '../policy/budget';
import { truncate } from '../runtime/tools';
import { sessionBudgetId } from '../sessions/methods/shared';
import { carveChildBudget } from '../sessions/spawn';

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
} as const;

/** statusReason of a `ready` task whose worker run was cut off by a daemon stop / restart. */
export const INTERRUPTED = 'interrupted';

/** statusReason of a task whose worker completed without changing anything. */
export const NO_CHANGES = 'no_changes';

/**
 * statusReason of a spawned child's task (spec 20261029 §3.4): `waiting_for_human` (it
 * finished with a question open), `stopped` (its run was cancelled: paused, resumable),
 * the run's own stop reasons (`budget_exhausted`, `turn_limit`, `loop_detected`,
 * `daily_limit`), else `worker_failed`.
 */
export const CHILD_REASONS = {
  waitingForHuman: 'waiting_for_human',
  stopped: 'stopped',
} as const;

/** Run stop reasons that ask a human for more budget / to look at a stuck child. */
const BUDGET_REASONS = new Set(['budget_exhausted']);
const STUCK_REASONS = new Set(['turn_limit', 'loop_detected']);

const SPAWNABLE: Task['status'][] = ['ready', 'failed', 'blocked'];
/** Statuses task.retry accepts (plus review: send finished work back). */
const RETRYABLE: Task['status'][] = ['review', ...SPAWNABLE];
/** Characters of failed test output passed back to a worker. */
const FAILURE_TAIL = 4000;
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

  async spawn(
    p: Params<'task.spawnWorker'>,
    actor: Actor,
    opts: { allowReview?: boolean } = {},
  ): Promise<Result<'task.spawnWorker'>> {
    const { ctx } = this;
    const policy = ctx.service('policy');
    const task = ctx.repos.tasks.require(p.taskId);
    this.assertSpawnable(task, opts.allowReview);
    // Fail fast (before creating a worktree); checked again right before the run starts.
    policy.assertCanSpawnWorker(actor, { projectId: task.projectId });

    const workspace = await this.workspaceFor(task, actor);
    const runtime = p.runtime ?? ctx.service('runtimes').defaultId();
    // Validate the runtime name before anything is created.
    ctx.service('runtimes').get(runtime);

    return ctx.db.transaction(() => {
      const cur = ctx.repos.tasks.require(task.id);
      this.assertSpawnable(cur, opts.allowReview);
      // Synchronous from here to runs.start: two spawns cannot both take the last slot.
      const parentGrant = policy.assertCanSpawnWorker(actor, { projectId: cur.projectId });
      const callerRun = actor.kind === 'agent' ? ctx.repos.runs.get(actor.runId) : undefined;
      const callerSessionId = actor.kind === 'agent' ? actor.sessionId : null;

      const session = ctx.service('sessions').create(
        {
          kind: 'agent',
          projectId: cur.projectId,
          title: truncate(cur.title, 120),
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
            active: parentGrant ? policy.activeWorkerCount(parentGrant.subject) : null,
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
   * task.retry: send a task back to its original worker — a new run in the same worker
   * session and worktree (branch and commits kept; the runtime resumes its own session)
   * whose prompt adds review feedback and, with `integrationId`, the failed integration's
   * error and test output tail. Falls back to a fresh worker when the task never had one.
   */
  async retry(p: Params<'task.retry'>, actor: Actor): Promise<Result<'task.retry'>> {
    const { ctx } = this;
    const policy = ctx.service('policy');
    const task = ctx.repos.tasks.require(p.taskId);
    this.assertRetryable(task);
    const assignee = task.assigneeSessionId
      ? ctx.repos.sessions.get(task.assigneeSessionId)
      : undefined;
    // A spawned child (session.spawn) is sent back in its own session and workspace.
    if (assignee?.brief && assignee.taskId === task.id) {
      return this.retryChild(p, task, assignee, actor);
    }
    policy.assertCanSpawnWorker(actor, { projectId: task.projectId });
    const feedback = this.retryFeedback(task, p.feedback, p.integrationId);

    // Only the task's own worker session (made for this task, in its project, running on
    // nothing but per-run grants) is "the original worker": any other session would lend
    // the retry its project, budget and session grants.
    const session =
      assignee &&
      assignee.kind === 'agent' &&
      assignee.taskId === task.id &&
      assignee.projectId === task.projectId &&
      !policy.hasSessionGrants(assignee.id)
        ? assignee
        : undefined;
    const ws = task.workspaceId ? ctx.repos.workspaces.get(task.workspaceId) : undefined;
    if (!session || !ws || ws.status !== 'ready' || ws.projectId !== task.projectId) {
      return this.spawn(
        {
          taskId: task.id,
          instructions: feedback,
          ...(p.model ? { model: p.model } : {}),
          ...(p.runtime ? { runtime: p.runtime } : {}),
        },
        actor,
        { allowReview: true },
      );
    }
    if (ctx.service('workspaces').isLocked(ws.id)) {
      throw conflict('このタスクのワークスペースは別の Run が使用中です', { workspaceId: ws.id });
    }
    const runtime = p.runtime ?? session.runtime ?? ctx.service('runtimes').defaultId();
    ctx.service('runtimes').get(runtime);

    return ctx.db.transaction(() => {
      const cur = ctx.repos.tasks.require(task.id);
      this.assertRetryable(cur);
      const parentGrant = policy.assertCanSpawnWorker(actor, { projectId: cur.projectId });
      const callerRun = actor.kind === 'agent' ? ctx.repos.runs.get(actor.runId) : undefined;
      const prev = ctx.repos.runs.findOne({
        where: { session_id: session.id },
        direction: 'desc',
      });
      const message = ctx.service('sessions').appendMessage({
        sessionId: session.id,
        role: 'user',
        content: [{ type: 'text', text: feedback }],
        author: actor,
      });
      const kept = prev?.budgetId ? ctx.repos.budgets.get(prev.budgetId) : undefined;
      const own = kept?.subject.kind === 'session' && kept.subject.id === session.id;
      // A child's unused budget went back to its parent when it ended (cost/returns.ts):
      // a retry carves it again from that parent.
      const budget =
        own && kept.status === 'active'
          ? kept
          : ((own && kept.parentId && !callerRun?.budgetId
              ? ctx.service('budget').reallocate(kept.id, actor)
              : null) ?? this.carveBudget(undefined, callerRun, parentGrant, session.id, actor));
      const run = ctx.service('runs').start({
        sessionId: session.id,
        kind: 'agent',
        createdBy: actor,
        taskId: cur.id,
        projectId: cur.projectId,
        workspaceId: ws.id,
        parentRunId: callerRun?.id ?? null,
        retryOfRunId: prev?.id ?? null,
        model: p.model ?? session.model ?? null,
        runtime,
        budgetId: budget?.id ?? null,
        triggerMessageId: message.id,
      });
      this.grantWorker(run, parentGrant, undefined, actor);
      ctx.service('tasks').setStatus(cur.id, 'running', actor, null, {
        assigneeSessionId: session.id,
        workspaceId: ws.id,
        resultSummary: null,
      });
      this.decide(
        {
          decision: `Task を元の Worker に差し戻しました: ${truncate(cur.title, 80)}`,
          rationale: `同じ worktree（${ws.branch ?? ws.id}）と Worker セッションで作業をやり直します。指摘: ${truncate(feedback.replace(/\s+/g, ' '), 300)}`,
          taskIds: [cur.id],
          sessionIds: [session.id],
          runIds: [run.id],
        },
        {
          projectId: cur.projectId,
          sessionId: actor.kind === 'agent' ? actor.sessionId : session.id,
          runId: callerRun?.id ?? run.id,
          taskId: cur.id,
        },
      );
      return {
        sessionId: session.id,
        runId: run.id,
        workspaceId: ws.id,
        budgetId: budget?.id ?? null,
      };
    });
  }

  /**
   * integration.resolveWithAgent: re-create the conflicting merge in the integration
   * worktree and start an integrator agent there (an `agent` run without a task; the same
   * grant, depth and budget rules as a worker). The integrations service resumes the
   * integration when the run ends.
   */
  async resolveIntegration(
    p: Params<'integration.resolveWithAgent'>,
    actor: Actor,
  ): Promise<Result<'integration.resolveWithAgent'>> {
    const { ctx } = this;
    const policy = ctx.service('policy');
    const integrations = ctx.service('integrations');
    const integ = integrations.get(p.integrationId);
    policy.assertCanSpawnWorker(actor, { projectId: integ.projectId });
    const runtime = p.runtime ?? ctx.service('runtimes').defaultId();
    ctx.service('runtimes').get(runtime);

    const prepared = await integrations.prepareResolution(integ.id, actor);
    if (prepared.merged) {
      return {
        integration: integrations.resumeAfterCleanMerge(integ.id, actor),
        sessionId: null,
        runId: null,
      };
    }
    try {
      return ctx.db.transaction(() => {
        const parentGrant = policy.assertCanSpawnWorker(actor, { projectId: integ.projectId });
        const callerRun = actor.kind === 'agent' ? ctx.repos.runs.get(actor.runId) : undefined;
        const current = integrations.get(integ.id);
        const session = ctx.service('sessions').create(
          {
            kind: 'agent',
            projectId: integ.projectId,
            // What a person reads in the sidebar and on home: what it does, no role names.
            title: `競合の解消: ${truncate(integ.title, 120)}`,
            model: p.model ?? null,
            runtime,
            workspaceId: integ.workspaceId,
            taskId: null,
            parentSessionId: actor.kind === 'agent' ? actor.sessionId : null,
          },
          actor,
        );
        const budget = this.carveBudget(undefined, callerRun, parentGrant, session.id, actor);
        const message = ctx.service('sessions').appendMessage({
          sessionId: session.id,
          role: 'user',
          content: [
            { type: 'text', text: this.integratorPrompt(current, prepared.step, p.instructions) },
          ],
          author: actor,
        });
        const run = ctx.service('runs').start({
          sessionId: session.id,
          kind: 'agent',
          createdBy: actor,
          projectId: integ.projectId,
          workspaceId: integ.workspaceId,
          parentRunId: callerRun?.id ?? null,
          model: p.model ?? null,
          runtime,
          budgetId: budget?.id ?? null,
          triggerMessageId: message.id,
        });
        this.grantWorker(run, parentGrant, undefined, actor);
        const integration = integrations.attachResolver(integ.id, actor, run.id);
        this.decide(
          {
            decision: `競合の解消を任せました: ${truncate(integ.title, 80)}`,
            rationale: `${fixFiles(integration).join('、')} が競合しました。両方の変更の目的を渡して解消させ、終わったらテストで確かめてから反映を待ちます。`,
            taskIds: integ.taskIds,
            sessionIds: [session.id],
            runIds: [run.id],
          },
          {
            projectId: integ.projectId,
            sessionId: actor.kind === 'agent' ? actor.sessionId : session.id,
            runId: callerRun?.id ?? run.id,
          },
        );
        return { integration, sessionId: session.id, runId: run.id };
      });
    } catch (err) {
      await integrations.abandonResolution(
        integ.id,
        actor,
        `競合の解消を始められませんでした: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /** The integrator's instructions: the conflict, both sides' goals, and the rules. */
  private integratorPrompt(
    integ: Integration,
    step: IntegrationStep,
    instructions: string | undefined,
  ): string {
    const { repos } = this.ctx;
    const describeTask = (taskId: string | null, branch: string | null) => {
      const t = taskId ? repos.tasks.get(taskId) : undefined;
      if (!t) return [`- ブランチ \`${branch ?? '?'}\``];
      const lines = [`- Task「${t.title}」（ブランチ \`${branch ?? '?'}\`）`];
      for (const c of t.acceptanceCriteria) lines.push(`  - 完了条件: ${c}`);
      if (t.resultSummary) lines.push(`  - 作業の要約: ${oneLine(t.resultSummary, 300)}`);
      return lines;
    };
    const ours = integ.steps.filter(
      (s) => s.kind === 'merge' && s.index < step.index && s.status === 'succeeded',
    );
    const files = fixFiles(integ);
    const project = repos.projects.get(integ.projectId);
    const parts = [
      `# 統合のコンフリクト解消: ${integ.title}`,
      '',
      `統合ブランチ \`${integ.branch}\`（反映先 \`${integ.targetRef}\`）に \`${step.branch}\` をマージしたところ、コンフリクトしました。マージは途中の状態（コンフリクトマーカー入り）でこの作業ディレクトリに残っています。`,
      '',
      '## コンフリクトしたファイル',
      ...files.map((f) => `- ${f}`),
      '',
      '## 統合ブランチ側（ours）にすでに入っている変更',
      ...(ours.length > 0
        ? ours.flatMap((s) => describeTask(s.taskId, s.branch))
        : [`- 反映先 \`${integ.targetRef}\` の内容のみ`]),
      '',
      `## マージ中の変更（theirs）`,
      ...describeTask(step.taskId, step.branch),
      '',
      '## やること',
      '1. 各ファイルのコンフリクトマーカー（<<<<<<< / ======= / >>>>>>>）をすべて取り除き、両方の変更の意図が保たれる内容にする',
      '2. コンフリクトしたファイル以外は、両立させるのに必要なときだけ変更する',
      `3. git の操作（commit・merge --abort・reset など）はしない。完了すると解消した内容がマージコミットとして記録され、統合が再開されてテスト（${project?.testCommand ?? 'テストコマンド未設定'}）で検証されます`,
    ];
    if (instructions?.trim()) parts.push('', '## 追加の指示', instructions.trim());
    return parts.join('\n');
  }

  /**
   * task.retry of a spawned agent child (spec 20261029 §3.5 redo): a new run in the child's
   * session and workspace with the feedback, under the same rules as a message to it (the
   * caller must have spawned it; a child slot). Its budget is kept while active, else carved
   * again from the caller's.
   */
  private async retryChild(
    p: Params<'task.retry'>,
    task: Task,
    child: Session,
    actor: Actor,
  ): Promise<Result<'task.retry'>> {
    const { ctx } = this;
    if (child.kind !== 'agent') {
      throw conflict('会話の子にやり直しを伝えるときは session.send を使ってください', {
        sessionId: child.id,
      });
    }
    ctx.service('policy').assertAgentMayStartRun(actor, child, 'task.retry');
    const feedback = this.retryFeedback(task, p.feedback, p.integrationId);
    const ws = child.workspaceId ? ctx.repos.workspaces.get(child.workspaceId) : undefined;
    if (!ws || ws.status !== 'ready') {
      throw conflict('この子の作業場所がなくなったため、やり直せません', {
        sessionId: child.id,
      });
    }
    if (ctx.service('workspaces').isLocked(ws.id)) {
      throw conflict('この子の作業場所は別の実行が使用中です', { workspaceId: ws.id });
    }
    const runtime = p.runtime ?? child.runtime ?? ctx.service('runtimes').defaultId();
    ctx.service('runtimes').get(runtime);

    return ctx.db.transaction(() => {
      const cur = ctx.repos.tasks.require(task.id);
      this.assertRetryable(cur);
      const callerRun = actor.kind === 'agent' ? ctx.repos.runs.get(actor.runId) : undefined;
      const prev = ctx.repos.runs.findOne({ where: { session_id: child.id }, direction: 'desc' });
      const message = ctx.service('sessions').appendMessage({
        sessionId: child.id,
        role: 'user',
        content: [{ type: 'text', text: feedback }],
        author: actor,
      });
      const kept = sessionBudgetId(ctx, child.id);
      // Its unused budget went back to the parent when it ended (cost/returns.ts): a redo by
      // someone without a budget of their own (a person) carves the same amount again.
      const returned = kept || callerRun?.budgetId ? null : this.returnedBudgetOf(child.id);
      const budgetId =
        kept ??
        (returned ? ctx.service('budget').reallocate(returned, actor)?.id : undefined) ??
        carveChildBudget(ctx, {
          budgetUsd: undefined,
          callerRun,
          grant: null,
          childSessionId: child.id,
          actor,
        })?.id ??
        null;
      const run = ctx.service('runs').start({
        sessionId: child.id,
        kind: 'agent',
        createdBy: actor,
        taskId: cur.id,
        projectId: child.projectId,
        workspaceId: ws.id,
        parentRunId: callerRun?.id ?? null,
        retryOfRunId: prev?.id ?? null,
        model: p.model ?? child.model ?? null,
        runtime,
        budgetId,
        triggerMessageId: message.id,
        trigger: 'retry',
      });
      ctx.service('tasks').setStatus(cur.id, 'running', actor, null, { resultSummary: null });
      this.decide(
        {
          decision: `「${truncate(cur.title, 60)}」にやり直しを頼みました`,
          rationale: truncate(firstLineOf(p.feedback ?? feedback), 200),
          taskIds: [cur.id],
          sessionIds: [child.id],
          runIds: [run.id],
        },
        {
          projectId: child.projectId,
          sessionId: child.parentSessionId ?? child.id,
          runId: callerRun?.id ?? run.id,
          taskId: cur.id,
        },
      );
      return { sessionId: child.id, runId: run.id, workspaceId: ws.id, budgetId };
    });
  }

  /** Feedback message of a retry (review notes + the failed integration's test output). */
  private retryFeedback(
    task: Task,
    feedback: string | undefined,
    integrationId: string | undefined,
  ): string {
    const { repos } = this.ctx;
    const parts = ['差し戻し: 前回の作業を見直し、次の点を直してください。'];
    if (feedback?.trim()) parts.push('', feedback.trim());
    if (integrationId) {
      const integ = repos.integrations.require(integrationId);
      if (integ.projectId !== task.projectId) {
        throw invalidParams('別のプロジェクトの統合は指定できません', { integrationId });
      }
      parts.push('', `統合 ${integ.id}（${integ.title}）が「${integ.status}」で止まりました。`);
      if (integ.error) parts.push(`理由: ${integ.error.message}`);
      const verify = integ.steps.find((s) => s.kind === 'verify');
      const artifact = verify?.artifactId ? repos.artifacts.get(verify.artifactId) : undefined;
      if (artifact?.kind === 'test_result') {
        parts.push(`テストコマンド: ${artifact.data.command}（${artifact.data.summary}）`);
        const out = artifact.data.output?.trim();
        if (out) {
          const tail = out.length > FAILURE_TAIL ? `…${out.slice(-FAILURE_TAIL)}` : out;
          parts.push('', '出力（末尾）:', '```', tail, '```');
        }
      }
      parts.push(
        '',
        'この Task の変更を他の Task の変更と合わせても、テストが通るようにしてください。',
      );
    }
    if (parts.length === 1) {
      parts.push('', '前回の Run は最後まで終わりませんでした。続きから作業を完了させてください。');
    }
    return parts.join('\n');
  }

  private assertRetryable(task: Task): void {
    if (task.status === 'blocked' && task.statusReason?.startsWith('dependency_')) {
      throw conflict(`タスク「${task.title}」は依存タスクの失敗で止まっています`, {
        taskId: task.id,
        status: task.status,
      });
    }
    if (!RETRYABLE.includes(task.status)) {
      throw conflict(`タスク「${task.title}」はこの状態（${task.status}）では差し戻せません`, {
        taskId: task.id,
        status: task.status,
      });
    }
  }

  /**
   * React to the end of an agent run that works on a task it is assigned to: completed →
   * review (or review with `no_changes`), anything else → failed with the reason. Tasks
   * moved on by someone else (cancelled, already reviewed …) are left alone.
   */
  onRunEnded(run: Run): void {
    const { ctx } = this;
    if (!run.taskId || !isTerminalRunStatus(run.status)) return;
    const task = ctx.repos.tasks.get(run.taskId);
    if (!task || task.status !== 'running' || task.assigneeSessionId !== run.sessionId) return;
    const session = ctx.repos.sessions.get(run.sessionId);
    if (session?.brief) {
      const done = this.onChildRunEnded(run, task, session).catch((err: unknown) => {
        ctx.log.error('failed to settle a finished child', { runId: run.id, err });
      });
      this.settling.add(done);
      void done.finally(() => this.settling.delete(done));
      return;
    }
    if (run.kind !== 'agent') return;
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
      if (run.status === 'interrupted') {
        // Cut off by a daemon stop / restart, not a failure: ready to resume on the same
        // worktree and branch (task.retry keeps the session, so the runtime resumes too).
        ctx.service('tasks').setStatus(task.id, 'ready', ORCHESTRATION_SYSTEM, INTERRUPTED, {
          resultSummary:
            'デーモンの停止・再起動で Worker の作業が中断されました。task.retry で同じ worktree とブランチから再開できます。',
        });
        this.decide(
          {
            decision: `中断された Task を再開待ちにしました: ${truncate(task.title, 80)}`,
            rationale:
              'Worker の Run がデーモンの停止・再起動で中断されました。worktree・ブランチ・コミット済みの変更は残っており、task.retry で同じ Worker セッションから再開できます。',
            ...ids,
          },
          refs,
        );
        return;
      }
      const status = run.status as 'failed' | 'cancelled';
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

  /** Children whose end is being settled (outputs.finalize is async). */
  private readonly settling = new Set<Promise<void>>();

  /** Resolves once every child end seen so far has been settled (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.settling.size > 0) await Promise.all([...this.settling]);
  }

  /**
   * The end of a spawned child's run (spec 20261029 §3.4): settle its outputs
   * (`outputs.finalize`), then move its task — done, review, waiting for a human, failed,
   * paused, or ready again after a restart — open the attention item a person must act on,
   * and tell the parent (`child_update`), except when the parent stopped it itself.
   */
  async onChildRunEnded(run: Run, task: Task, child: Session): Promise<void> {
    const { ctx } = this;
    if (run.status === 'cancelled' && run.statusReason === 'superseded') return;
    let outputs: FinalizeResult = { needsReview: false, artifactIds: [] };
    if (run.status === 'completed' && ctx.hasService('outputs')) {
      try {
        outputs = await ctx.service('outputs').finalize(run);
      } catch (err) {
        ctx.log.warn('outputs could not be settled', { runId: run.id, err });
      }
    }
    ctx.db.transaction(() => {
      const cur = ctx.repos.tasks.get(task.id);
      if (!cur || cur.status !== 'running' || cur.assigneeSessionId !== child.id) return;
      // A newer run of the child took over (a message right after): its end decides.
      const latest = ctx.repos.runs.findOne({ where: { session_id: child.id } });
      if (latest && latest.id !== run.id) return;
      const end = this.childEnd(run, cur, child, outputs);
      const updated = ctx
        .service('tasks')
        .setStatus(cur.id, end.status, ORCHESTRATION_SYSTEM, end.reason, {
          resultSummary: end.summary,
        });
      const title = truncate(child.title || updated.title, 40);
      if (end.attention && ctx.hasService('attention')) {
        ctx.service('attention').open({
          kind: end.attention,
          sessionId: child.id,
          title: attentionTitle(end.attention, title, run.statusReason, run.error?.message),
          detail: end.detail,
          refs: {
            runId: run.id,
            taskId: cur.id,
            ...(end.attention === 'budget' && run.budgetId ? { budgetId: run.budgetId } : {}),
          },
          actor: ORCHESTRATION_SYSTEM,
        });
      }
      // The inbox reports every other outcome to a supervising parent itself (it follows the
      // task / attention / state events and derives the child's state, once per state and
      // run); only a stop that did not come through session.stop is left to tell here.
      if (
        end.notifyParent &&
        run.status === 'cancelled' &&
        child.parentSessionId &&
        ctx.hasService('inbox')
      ) {
        ctx.service('inbox').deliver(child.parentSessionId, {
          kind: 'child_update',
          refs: { childSessionId: child.id, runId: run.id },
          actor: ORCHESTRATION_SYSTEM,
        });
      }
      if (end.decision) {
        this.decide(
          {
            decision: end.decision.replace('{title}', title),
            rationale: end.detail ?? '',
            taskIds: [cur.id],
            sessionIds: [child.id],
            runIds: [run.id],
          },
          {
            projectId: cur.projectId,
            sessionId: child.parentSessionId ?? child.id,
            runId: run.id,
            taskId: cur.id,
          },
        );
      }
    });
  }

  /** The §3.4 table: what a child's run end means for its task, a person and its parent. */
  private childEnd(
    run: Run,
    task: Task,
    child: Session,
    outputs: FinalizeResult,
  ): {
    status: TaskStatus;
    reason: string | null;
    summary: string | null;
    attention: AttentionKind | null;
    detail: string | null;
    notifyParent: boolean;
    decision: string | null;
  } {
    const { ctx } = this;
    const base = { attention: null, detail: null, notifyParent: true, decision: null };
    const summary = this.lastAssistantText(run);
    switch (run.status) {
      case 'completed': {
        const asked =
          ctx.repos.attention.count({
            where: { session_id: child.id, status: 'open', kind: 'question' },
          }) > 0;
        if (asked) {
          return {
            ...base,
            status: 'blocked',
            reason: CHILD_REASONS.waitingForHuman,
            summary,
          };
        }
        const review =
          outputs.needsReview || child.brief?.reviewBy === 'human' || this.changedCode(task, run);
        if (review) {
          // A supervisor decides on its children's outputs together; otherwise a person does.
          const supervised =
            !!child.parentSessionId &&
            ctx.service('policy').sessionAllows(child.parentSessionId, 'session.spawn');
          return {
            ...base,
            status: 'review',
            reason: null,
            summary,
            attention: supervised ? null : 'review',
            notifyParent: supervised,
            decision: '「{title}」の成果物が確認待ちになりました',
          };
        }
        return {
          ...base,
          status: 'done',
          reason: null,
          summary,
          decision: '「{title}」が完了しました',
        };
      }
      case 'failed': {
        const why = run.error?.message ?? 'Run が失敗しました';
        const reason = run.statusReason ?? run.error?.code ?? null;
        const failed = { ...base, status: 'failed' as const, summary: truncate(why, MAX_SUMMARY) };
        // A run stopped by its budget gets the cost module's budget item (refs budgetId, for
        // every kind of run), so this end opens none of its own.
        if (reason && BUDGET_REASONS.has(reason)) return { ...failed, reason, detail: why };
        if (reason && STUCK_REASONS.has(reason)) {
          return { ...failed, reason, attention: 'stuck', detail: why };
        }
        // The daily limit is one attention item for everything (the cost module opens it).
        if (reason === 'daily_limit') return { ...failed, reason, detail: why };
        return {
          ...failed,
          reason: WORKER_REASONS.failed,
          attention: 'failure',
          detail: why,
          decision: '「{title}」が失敗しました',
        };
      }
      case 'cancelled':
        return {
          ...base,
          status: 'paused',
          reason: CHILD_REASONS.stopped,
          summary,
          notifyParent: !this.stoppedByParent(run, child),
        };
      default:
        // Interrupted by a daemon stop / restart: ready to resume in the same workspace
        // (the supervisor track resumes it once, spec §3.10).
        return { ...base, status: 'ready', reason: INTERRUPTED, summary, notifyParent: false };
    }
  }

  /** The latest carved (parented) budget of a session that was released, if any. */
  private returnedBudgetOf(sessionId: string): string | null {
    const b = this.ctx.repos.budgets.findOne({
      where: { subject_kind: 'session', subject_id: sessionId, status: 'released' },
      direction: 'desc',
    });
    return b?.parentId ? b.id : null;
  }

  /** The child's own run left committed code changes (a non-empty diff of this run). */
  private changedCode(task: Task, run: Run): boolean {
    const diff = this.ctx.repos.artifacts.findOne({
      where: { task_id: task.id, run_id: run.id, kind: 'diff' },
      direction: 'desc',
    });
    return diff?.kind === 'diff' && diff.data.stats.files > 0;
  }

  /** Whether the parent session itself cancelled this run (then it needs no update). */
  private stoppedByParent(run: Run, child: Session): boolean {
    if (!child.parentSessionId) return false;
    const row = this.ctx.db.get<{ actor: string }>(
      "SELECT actor FROM events WHERE run_id = ? AND type = 'run.status_changed' ORDER BY seq DESC LIMIT 1",
      [run.id],
    );
    if (!row) return false;
    try {
      const actor = JSON.parse(row.actor) as Actor;
      return actor.kind === 'agent' && actor.sessionId === child.parentSessionId;
    } catch {
      return false;
    }
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

  private assertSpawnable(task: Task, allowReview = false): void {
    if (task.status === 'running') {
      throw conflict(`タスク「${task.title}」はすでに実行中です`, { taskId: task.id });
    }
    if (task.status === 'blocked' && task.statusReason?.startsWith('dependency_')) {
      throw conflict(`タスク「${task.title}」は依存タスクの失敗で止まっています`, {
        taskId: task.id,
        status: task.status,
      });
    }
    if (!SPAWNABLE.includes(task.status) && !(allowReview && task.status === 'review')) {
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
    if (!task.projectId) {
      throw invalidParams('プロジェクトのないタスクには worktree を作れません', {
        taskId: task.id,
      });
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
        // An equal share among the worker slots left plus one kept by the caller, which
        // still needs budget for its own (reserved) LLM calls while it supervises.
        const active = grant ? this.ctx.service('policy').activeWorkerCount(grant.subject) : 0;
        const slots = Math.max(1, (grant?.limits.maxWorkers ?? 2) - active) + 1;
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
  // No branch or runtime names (spec 20261029 §4): what matters is where and how much.
  const parts = ['専用の作業場所で作業します。'];
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

/** Files of the integration's latest fix step (what the integrator resolves). */
function fixFiles(integ: Integration): string[] {
  return integ.steps.filter((s) => s.kind === 'fix').at(-1)?.conflictFiles ?? [];
}

/**
 * One line (<= 80 chars, no ids) for a child's attention item (spec §1.6), e.g.
 * "「FAQ を書く」の予算が尽きました". A failure says why it failed (the row already names the
 * child), falling back to "「FAQ を書く」が失敗しました" when the run gave no message.
 */
export function attentionTitle(
  kind: AttentionKind,
  title: string,
  reason: string | null,
  error?: string | null,
): string {
  switch (kind) {
    case 'budget':
      return `「${title}」の予算が尽きました`;
    case 'stuck':
      return reason === 'turn_limit'
        ? `「${title}」が手順の上限に達しました`
        : `「${title}」が同じ操作を繰り返したため止めました`;
    case 'review':
      return `「${title}」の成果物を確認`;
    case 'failure': {
      const why = error ? firstLineOf(error) : '';
      return why ? truncate(why, 80) : `「${title}」が失敗しました`;
    }
    default:
      return `「${title}」`;
  }
}

function firstLineOf(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  );
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
