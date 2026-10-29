import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Actor,
  type Approval,
  type ErrorInfo,
  type Integration,
  type IntegrationStatus,
  type IntegrationStep,
  type Project,
  type Run,
  type Workspace,
  isTerminalRunStatus,
} from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { conflict, forbidden, invalidParams } from '../core/errors';
import type { Page } from '../core/repo';
import {
  branchExists,
  conflictedFiles,
  git,
  gitOut,
  gitTest,
  listWorktrees,
  resolveCommit,
  statusLines,
} from '../workspace/git';
import { KeyedMutex } from '../workspace/mutex';
import { shortId } from '../workspace/service';
import { redactSecrets, runShellCommand } from './command';

export interface IntegrationOptions {
  /** Kill the test command after this long (default 10 minutes). */
  testTimeoutMs: number;
  /** Bytes of test output kept (tail) for the test_result artifact (default 64 KiB). */
  maxOutputBytes: number;
}

export const DEFAULT_INTEGRATION_OPTIONS: IntegrationOptions = {
  testTimeoutMs: 10 * 60_000,
  maxOutputBytes: 64 * 1024,
};

/** Statuses from which `run` may (re)start an attempt. */
const RUNNABLE: IntegrationStatus[] = ['pending', 'conflict', 'failed', 'awaiting_approval'];
const ACTIVE: IntegrationStatus[] = ['running', 'verifying'];
const FINAL: IntegrationStatus[] = ['applied', 'rejected', 'cancelled'];

interface Source {
  workspace: Workspace;
  taskId: string | null;
  title: string | null;
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 8) : '');

/**
 * Integration Manager (concept §6): merges several work branches into a dedicated
 * integration branch, in order, verifies the result with the project's test command and —
 * only after a human approves — fast-forwards the target branch.
 *
 * - Every step is appended to `Integration.steps` and announced with `integration.updated`,
 *   so the UI can animate progress.
 * - Nothing is lost: conflicts abort the merge, failures keep every worktree and branch.
 * - Git and test commands run asynchronously; integrations of one project run one at a time.
 */
export class IntegrationService {
  private readonly projectQueue = new KeyedMutex();
  private readonly jobs = new Map<string, Promise<Integration>>();
  /**
   * Integrations being applied. Marked synchronously when approve is called (before any
   * await), so run / reject / resolveWithAgent cannot slip in while git moves the target.
   */
  private readonly applying = new Set<string>();
  /** Resolutions in progress: where the integration branch was before the re-created merge. */
  private readonly resolutions = new Map<string, { preSha: string | null; branch: string }>();
  private readonly shutdown = new AbortController();
  private readonly opts: IntegrationOptions;

  constructor(
    private readonly ctx: DaemonContext,
    opts: Partial<IntegrationOptions> = {},
  ) {
    this.opts = { ...DEFAULT_INTEGRATION_OPTIONS, ...opts };
  }

  private get workspaces() {
    return this.ctx.service('workspaceManager');
  }

  private get artifacts() {
    return this.ctx.service('artifacts');
  }

  // -------------------------------------------------------------------------
  // queries
  // -------------------------------------------------------------------------

  get(integrationId: string): Integration {
    return this.ctx.repos.integrations.require(integrationId);
  }

  list(q: {
    projectId?: string | undefined;
    status?: IntegrationStatus[] | undefined;
    limit: number;
    cursor?: string | undefined;
  }): Page<Integration> {
    return this.ctx.repos.integrations.page({
      where: { project_id: q.projectId, status: q.status },
      limit: q.limit,
      cursor: q.cursor,
    });
  }

  /** Resolves when the integration's background attempt (if any) has finished. */
  async settled(integrationId: string): Promise<Integration> {
    const job = this.jobs.get(integrationId);
    if (job) await job;
    return this.get(integrationId);
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  async create(input: {
    projectId: string;
    taskIds?: string[] | undefined;
    workspaceIds?: string[] | undefined;
    title?: string | undefined;
    targetRef?: string | undefined;
    actor: Actor;
  }): Promise<Integration> {
    const { ctx } = this;
    const project = ctx.repos.projects.require(input.projectId);
    const repo = this.workspaces.requireRepo(project);
    const sources = this.resolveSources(project, input.taskIds, input.workspaceIds);

    const target = input.targetRef ?? (await this.workspaces.defaultBranch(project));
    if (!(await branchExists(repo, target))) {
      throw invalidParams(`反映先ブランチ「${target}」が見つかりません`);
    }
    const id = ctx.ids.next('integration');
    const branch = `acc/integration-${shortId(id)}`;
    const workspace = await this.workspaces.createWorktree({
      projectId: project.id,
      branch,
      baseRef: target,
      label: 'integration',
      actor: input.actor,
    });
    const baseSha = await resolveCommit(workspace.path, 'HEAD');

    return ctx.db.transaction(() => {
      const now = ctx.clock.iso();
      const integration = ctx.repos.integrations.insert({
        id,
        projectId: project.id,
        title: input.title?.trim() || defaultTitle(sources, target),
        status: 'pending',
        taskIds: sources.flatMap((s) => (s.taskId ? [s.taskId] : [])),
        workspaceIds: sources.map((s) => s.workspace.id),
        branch,
        targetRef: target,
        workspaceId: workspace.id,
        steps: planSteps(sources, project, target),
        baseSha,
        headSha: null,
        approvalId: null,
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
        error: null,
        createdBy: input.actor,
        createdAt: now,
        updatedAt: now,
      });
      ctx.bus.emit({ type: 'integration.created', actor: input.actor, payload: { integration } });
      return integration;
    });
  }

  private resolveSources(
    project: Project,
    taskIds: string[] | undefined,
    workspaceIds: string[] | undefined,
  ): Source[] {
    const { repos } = this.ctx;
    if ((taskIds?.length ?? 0) > 0 === (workspaceIds?.length ?? 0) > 0) {
      throw invalidParams('taskIds か workspaceIds のどちらか一方を指定してください');
    }
    const ids = taskIds ?? workspaceIds ?? [];
    if (new Set(ids).size !== ids.length) throw invalidParams('統合対象が重複しています');

    const sources: Source[] = [];
    if (taskIds) {
      for (const taskId of taskIds) {
        const task = repos.tasks.require(taskId);
        if (task.projectId !== project.id) {
          throw invalidParams(`タスク「${task.title}」は別のプロジェクトに属しています`);
        }
        const ws =
          (task.workspaceId ? repos.workspaces.get(task.workspaceId) : undefined) ??
          repos.workspaces.findOne({ where: { task_id: task.id, status: 'ready' } });
        if (!ws) throw invalidParams(`タスク「${task.title}」にはワークスペースがありません`);
        sources.push({ workspace: ws, taskId: task.id, title: task.title });
      }
    } else {
      for (const workspaceId of workspaceIds ?? []) {
        const ws = repos.workspaces.require(workspaceId);
        const task = ws.taskId ? repos.tasks.get(ws.taskId) : undefined;
        sources.push({ workspace: ws, taskId: ws.taskId, title: task?.title ?? null });
      }
    }
    for (const s of sources) {
      if (s.workspace.projectId !== project.id) {
        throw invalidParams('別のプロジェクトのワークスペースは統合できません');
      }
      if (s.workspace.kind !== 'worktree' || !s.workspace.branch) {
        throw invalidParams(
          '統合できるのは worktree のワークスペース（ブランチを持つもの）だけです',
        );
      }
    }
    return sources;
  }

  // -------------------------------------------------------------------------
  // run
  // -------------------------------------------------------------------------

  /** Start (or restart) an attempt in the background and return the `running` integration. */
  run(integrationId: string, actor: Actor): Integration {
    const cur = this.get(integrationId);
    if (this.applying.has(integrationId)) {
      throw conflict('この統合は反映中です', { integrationId });
    }
    if (this.jobs.has(integrationId) || ACTIVE.includes(cur.status)) {
      throw conflict('この統合はすでに実行中です', { integrationId });
    }
    if (!RUNNABLE.includes(cur.status)) {
      throw conflict(`この統合は実行できる状態ではありません（${cur.status}）`, {
        integrationId,
        status: cur.status,
      });
    }
    const project = this.ctx.repos.projects.require(cur.projectId);
    const started = this.update(
      integrationId,
      actor,
      ['status', 'steps', 'error', 'headSha'],
      (i) => ({
        ...i,
        status: 'running',
        error: null,
        headSha: null,
        // A fresh attempt re-merges everything from the target tip, so earlier fixes are
        // dropped. The test command may have changed since the last attempt.
        steps: renumber(i.steps.filter((s) => s.kind !== 'fix'))
          .map(resetStep)
          .map((s) => (s.kind === 'verify' ? { ...s, title: verifyTitle(project) } : s)),
      }),
    );
    this.startJob(integrationId, cur.projectId, actor, 'fresh');
    return started;
  }

  private startJob(id: string, projectId: string, actor: Actor, mode: 'fresh' | 'resume'): void {
    const job = this.projectQueue
      .run(projectId, () => this.execute(id, actor, mode))
      .catch((err: unknown) => this.failUnexpected(id, actor, err))
      .finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
  }

  /**
   * One attempt. `fresh` starts from the current tip of the target branch and merges every
   * source; `resume` continues on the integration branch as it is (after an integrator
   * committed a conflict resolution): sources it already contains count as merged.
   */
  private async execute(id: string, actor: Actor, mode: 'fresh' | 'resume'): Promise<Integration> {
    const integ = this.get(id);
    // Queued behind other work of the project: only an attempt still marked running may go on.
    if (integ.status !== 'running') return integ;
    const project = this.ctx.repos.projects.require(integ.projectId);
    const repo = this.workspaces.requireRepo(project);
    if (!integ.workspaceId || !integ.branch || !integ.targetRef) {
      return this.finish(id, actor, 'failed', {
        code: 'invalid_state',
        message: '統合ブランチの情報がありません',
      });
    }
    const wsId = integ.workspaceId;
    const wsPath = this.workspaces.get(wsId).path;
    if (!existsSync(wsPath)) {
      return this.finish(id, actor, 'failed', {
        code: 'workspace_missing',
        message: `統合用ワークスペースが見つかりません: ${wsPath}`,
      });
    }
    const release = this.workspaces.hold(wsId, `integration:${id}`);
    try {
      let baseSha: string;
      if (mode === 'resume') {
        const head = await resolveCommit(wsPath, 'HEAD');
        if (
          !integ.baseSha ||
          !head ||
          !(await gitTest(wsPath, ['merge-base', '--is-ancestor', integ.baseSha, head]))
        ) {
          return this.finish(id, actor, 'failed', {
            code: 'invalid_state',
            message:
              '統合ブランチが想定外の状態のため再開できません。もう一度統合を実行してください',
          });
        }
        baseSha = integ.baseSha;
      } else {
        // A fresh attempt starts from the current tip of the target branch.
        const tip = await resolveCommit(repo, `refs/heads/${integ.targetRef}`);
        if (!tip) {
          return this.finish(id, actor, 'failed', {
            code: 'target_missing',
            message: `反映先ブランチ「${integ.targetRef}」が見つかりません`,
          });
        }
        baseSha = tip;
        await git(wsPath, ['merge', '--abort'], { okCodes: [0, 128] });
        await git(wsPath, ['reset', '--hard', '--quiet', baseSha]);
        await git(wsPath, ['clean', '-fdq']);
        this.update(id, actor, ['baseSha'], (i) => ({ ...i, baseSha }));
      }

      const env = this.workspaces.identityEnv(project.id);
      for (const step of this.get(id).steps) {
        if (step.kind !== 'merge' || step.status === 'succeeded') continue;
        if (mode === 'resume' && (await this.alreadyMerged(wsPath, repo, step.branch))) {
          this.setStep(id, actor, step.index, {
            status: 'succeeded',
            detail: '統合ブランチに取り込み済みです（Integrator がコンフリクトを解消しました）',
            endedAt: this.ctx.clock.iso(),
          });
          continue;
        }
        const outcome = await this.mergeStep(id, actor, step, wsPath, repo, integ.branch, env);
        if (outcome) return outcome;
      }

      const verifyFailed = await this.verifyStep(id, actor, project, wsPath, wsId);
      if (verifyFailed) return verifyFailed;

      const headSha = await gitOut(wsPath, ['rev-parse', 'HEAD']);
      await this.artifacts
        .recordDiff({
          workspaceId: wsId,
          baseRef: baseSha,
          title: `統合結果の差分: ${integ.branch} ← ${integ.targetRef}`,
          createdBy: actor,
        })
        .catch((err: unknown) =>
          this.ctx.log.warn('integration diff artifact failed', { id, err }),
        );
      this.update(id, actor, ['headSha'], (i) => ({ ...i, headSha }));
      return this.finish(id, actor, 'awaiting_approval', null);
    } finally {
      release();
    }
  }

  /** Merge one source. Returns the finished integration when the attempt must stop. */
  private async mergeStep(
    id: string,
    actor: Actor,
    step: IntegrationStep,
    wsPath: string,
    repo: string,
    integrationBranch: string,
    env: Record<string, string>,
  ): Promise<Integration | null> {
    const branch = step.branch!;
    this.setStep(id, actor, step.index, { status: 'running', startedAt: this.ctx.clock.iso() });

    if (!(await resolveCommit(repo, `refs/heads/${branch}`))) {
      const message = `ブランチ「${branch}」が見つかりません`;
      this.setStep(id, actor, step.index, {
        status: 'failed',
        detail: message,
        endedAt: this.ctx.clock.iso(),
      });
      return this.finish(id, actor, 'failed', { code: 'branch_not_found', message });
    }

    const notes: string[] = [];
    const src = step.workspaceId ? this.ctx.repos.workspaces.get(step.workspaceId) : undefined;
    if (src && src.status === 'ready' && existsSync(src.path)) {
      const dirty = await statusLines(src.path).catch(() => []);
      if (dirty.length > 0) {
        notes.push(`未コミットの変更 ${dirty.length} 件は統合に含まれていません`);
      }
      if (this.workspaces.isLocked(src.id))
        notes.push('作業中の実行があるため、最新でない可能性があります');
    }

    const r = await git(
      wsPath,
      [
        'merge',
        '--no-ff',
        '--no-edit',
        '--no-verify',
        '-m',
        `Merge ${branch} into ${integrationBranch}`,
        branch,
      ],
      { okCodes: [0, 1, 128], env },
    );
    if (r.code === 0) {
      const upToDate = /already up[ -]to[ -]date/i.test(r.stdout);
      const sha = await gitOut(wsPath, ['rev-parse', 'HEAD']);
      const detail = [
        upToDate ? '取り込む変更はありませんでした' : `マージしました（${short(sha)}）`,
        ...notes,
      ].join('\n');
      this.setStep(id, actor, step.index, {
        status: 'succeeded',
        detail,
        endedAt: this.ctx.clock.iso(),
      });
      return null;
    }

    const files = await conflictedFiles(wsPath).catch(() => []);
    await git(wsPath, ['merge', '--abort'], { okCodes: [0, 128] });
    await git(wsPath, ['reset', '--hard', '--quiet', 'HEAD']);
    if (files.length > 0) {
      const detail = [
        `コンフリクトが発生しました（${files.length} ファイル）。マージを中止し、統合ブランチを直前の状態に戻しました`,
        ...notes,
      ].join('\n');
      this.setStep(id, actor, step.index, {
        status: 'failed',
        detail,
        conflictFiles: files,
        endedAt: this.ctx.clock.iso(),
      });
      return this.finish(id, actor, 'conflict', {
        code: 'merge_conflict',
        message: `「${branch}」のマージでコンフリクトが発生しました: ${files.join(', ')}`,
      });
    }
    const reason = (r.stderr.trim() || r.stdout.trim()).split(/\r?\n/).slice(-5).join('\n');
    this.setStep(id, actor, step.index, {
      status: 'failed',
      detail: reason || 'マージに失敗しました',
      endedAt: this.ctx.clock.iso(),
    });
    return this.finish(id, actor, 'failed', {
      code: 'merge_failed',
      message: `「${branch}」のマージに失敗しました${reason ? `: ${reason}` : ''}`,
    });
  }

  /** Run the project's test command. Returns the finished integration when it failed. */
  private async verifyStep(
    id: string,
    actor: Actor,
    project: Project,
    wsPath: string,
    wsId: string,
  ): Promise<Integration | null> {
    const step = this.get(id).steps.find((s) => s.kind === 'verify');
    if (!step) return null;
    const command = project.testCommand;
    if (!command) {
      this.setStep(id, actor, step.index, {
        status: 'skipped',
        detail: 'テストコマンドが設定されていないため検証を省略しました',
        endedAt: this.ctx.clock.iso(),
      });
      return null;
    }
    this.update(id, actor, ['status', 'steps'], (i) => ({
      ...i,
      status: 'verifying',
      steps: patchSteps(i.steps, step.index, {
        status: 'running',
        startedAt: this.ctx.clock.iso(),
      }),
    }));

    // The test command runs code agents wrote, as the user. An attempt a human started is
    // that human's decision. In the careful profile any other attempt waits for one; in the
    // standard / autonomous profiles the workers already ran the same code (their tests,
    // as the same user and environment) without asking, so waiting here protects nothing
    // more (docs/snapshot/20261029_auto-mode.md (e)).
    const profile = project.permissionProfile ?? this.ctx.settings.get().defaultPermissionProfile;
    if (actor.kind !== 'human' && profile === 'careful') {
      const consent = await this.awaitVerifyConsent(id, actor, project, command, step.index);
      if (consent !== 'approved') {
        const message =
          consent === 'rejected'
            ? 'テストの実行が却下されました'
            : 'テストの実行の承認を待つ間に中断されました';
        this.setStep(id, actor, step.index, {
          status: 'failed',
          detail: message,
          endedAt: this.ctx.clock.iso(),
        });
        return this.finish(id, actor, 'failed', {
          code: consent === 'rejected' ? 'tests_not_approved' : 'aborted',
          message,
        });
      }
      this.setStep(id, actor, step.index, { detail: null });
    }

    const res = await runShellCommand(command, {
      cwd: wsPath,
      timeoutMs: this.opts.testTimeoutMs,
      maxOutputBytes: this.opts.maxOutputBytes,
      signal: this.shutdown.signal,
    });
    const passed = res.exitCode === 0 && !res.timedOut && !res.aborted;
    const seconds = (res.durationMs / 1000).toFixed(1);
    const summary = passed
      ? `成功（${seconds} 秒）`
      : res.timedOut
        ? `タイムアウトしました（${Math.round(this.opts.testTimeoutMs / 1000)} 秒）`
        : res.aborted
          ? '中断されました'
          : `失敗しました（終了コード ${res.exitCode ?? '不明'}、${seconds} 秒）`;
    const artifact = this.artifacts.recordTestResult({
      projectId: project.id,
      workspaceId: wsId,
      command,
      passed,
      exitCode: res.exitCode,
      durationMs: res.durationMs,
      summary,
      // Agents read this artifact: never hand them the daemon's own credentials, even if the
      // code under test printed them.
      output: redactSecrets(res.output, this.daemonSecrets()),
      title: `統合後のテスト: ${command}`,
      createdBy: actor,
    });
    this.setStep(id, actor, step.index, {
      status: passed ? 'succeeded' : 'failed',
      detail: summary,
      artifactId: artifact.id,
      endedAt: this.ctx.clock.iso(),
    });
    if (passed) return null;
    return this.finish(id, actor, 'failed', {
      code: res.timedOut ? 'tests_timed_out' : res.aborted ? 'aborted' : 'tests_failed',
      message: `統合後のテストが${summary}`,
    });
  }

  /**
   * Ask a human whether the test command may run (an `integration` Approval with
   * `payload.action: "verify"`; only humans can answer it) and wait for the answer.
   */
  private async awaitVerifyConsent(
    id: string,
    actor: Actor,
    project: Project,
    command: string,
    stepIndex: number,
  ): Promise<'approved' | 'rejected' | 'aborted'> {
    const { ctx } = this;
    const approvalId = ctx.ids.next('approval');
    const answered = ctx.bus.waitFor(
      { types: ['approval.resolved'] },
      (e) => e.type === 'approval.resolved' && e.payload.approval.id === approvalId,
      { timeoutMs: 2 ** 31 - 1, signal: this.shutdown.signal },
    );
    ctx.db.transaction(() => {
      const approval = ctx.repos.approvals.insert({
        id: approvalId,
        kind: 'integration',
        status: 'pending',
        title: '統合後のテストを実行',
        detail: command,
        payload: { action: 'verify', command },
        projectId: project.id,
        sessionId: actor.kind === 'agent' ? actor.sessionId : null,
        runId: null,
        taskId: null,
        integrationId: id,
        requestedBy: actor,
        resolvedBy: null,
        resolutionNote: null,
        createdAt: ctx.clock.iso(),
        resolvedAt: null,
      });
      ctx.bus.emit({ type: 'approval.requested', actor, payload: { approval } });
    });
    this.setStep(id, actor, stepIndex, {
      detail: 'エージェントが書いたコードを実行するため、テストの前に人間の承認を待っています',
    });
    const event = await answered;
    if (event?.type === 'approval.resolved') {
      return event.payload.approval.status === 'approved' ? 'approved' : 'rejected';
    }
    try {
      this.cancelApprovals(id, { kind: 'system', component: 'integration' });
    } catch {
      // DB already closed (shutdown): the next start cancels it.
    }
    return 'aborted';
  }

  /** Cancel the integration's pending approvals (an attempt that can no longer use them). */
  private cancelApprovals(integrationId: string, actor: Actor): void {
    const { ctx } = this;
    ctx.db.transaction(() => {
      for (const ap of ctx.repos.approvals.find({
        where: { status: 'pending' },
      })) {
        if (ap.integrationId !== integrationId) continue;
        const approval: Approval = ctx.repos.approvals.update(ap.id, (x) => ({
          ...x,
          status: 'cancelled',
          resolvedBy: actor,
          resolvedAt: ctx.clock.iso(),
        }));
        ctx.bus.emit({ type: 'approval.resolved', actor, payload: { approval } });
      }
    });
  }

  /** Values that must never reach an agent-readable artifact. */
  private daemonSecrets(): string[] {
    const out: string[] = [];
    const key = this.ctx.settings.get().litellm.apiKey;
    if (key) out.push(key);
    try {
      const info = JSON.parse(readFileSync(this.ctx.paths.daemonInfo, 'utf8')) as {
        token?: unknown;
      };
      if (typeof info.token === 'string') out.push(info.token);
    } catch {
      // no daemon.json (tests, or not written yet)
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // approve / reject
  // -------------------------------------------------------------------------

  /**
   * Apply an `awaiting_approval` integration to its target branch (fast-forward only).
   * Humans only: agents (and daemon-internal actors) are refused regardless of grants
   * (concept §6.3: applying to a protected branch needs human approval).
   */
  async approve(integrationId: string, actor: Actor, note?: string): Promise<Integration> {
    if (actor.kind !== 'human') {
      throw forbidden(
        '保護されたブランチへの反映には人間の承認が必要です。エージェントは統合を承認できません',
      );
    }
    const cur = this.get(integrationId);
    if (this.applying.has(integrationId)) {
      throw conflict('この統合はすでに反映中です', { integrationId });
    }
    if (cur.status !== 'awaiting_approval' || this.jobs.has(integrationId)) {
      throw conflict(`この統合は承認できる状態ではありません（${cur.status}）`, {
        integrationId,
        status: cur.status,
      });
    }
    this.applying.add(integrationId);
    try {
      return await this.projectQueue.run(cur.projectId, () =>
        this.apply(integrationId, actor, note ?? null),
      );
    } finally {
      this.applying.delete(integrationId);
    }
  }

  private async apply(id: string, actor: Actor, note: string | null): Promise<Integration> {
    const integ = this.get(id);
    if (integ.status !== 'awaiting_approval') {
      throw conflict(`この統合は承認できる状態ではありません（${integ.status}）`, {
        integrationId: id,
        status: integ.status,
      });
    }
    const target = integ.targetRef!;
    const headSha = integ.headSha;
    const project = this.ctx.repos.projects.require(integ.projectId);
    const repo = this.workspaces.requireRepo(project);
    const step = integ.steps.find((s) => s.kind === 'apply');
    const stepIndex = step?.index ?? -1;
    this.setStep(id, actor, stepIndex, {
      status: 'running',
      startedAt: this.ctx.clock.iso(),
      detail: null,
    });

    const refuse = (message: string, data?: unknown): never => {
      this.setStep(id, actor, stepIndex, {
        status: 'failed',
        detail: message,
        endedAt: this.ctx.clock.iso(),
      });
      throw conflict(message, data);
    };

    const branchSha = await resolveCommit(repo, `refs/heads/${integ.branch}`);
    if (!headSha || branchSha !== headSha) {
      refuse('統合ブランチが検証後に変更されています。もう一度統合を実行してください');
    }
    const targetSha = await resolveCommit(repo, `refs/heads/${target}`);
    if (!targetSha) refuse(`反映先ブランチ「${target}」が見つかりません`);
    if (!(await gitTest(repo, ['merge-base', '--is-ancestor', targetSha!, headSha!]))) {
      refuse(
        `反映先ブランチ「${target}」が統合の開始後に進んでいるため、早送りで反映できません。もう一度統合を実行してください`,
      );
    }

    const checkedOut = (await listWorktrees(repo)).find((w) => w.branch === target);
    if (checkedOut) {
      const dirty = await statusLines(checkedOut.path, { untracked: false });
      if (dirty.length > 0) {
        refuse(
          `反映先ブランチ「${target}」をチェックアウトしている作業ツリーに未コミットの変更が ${dirty.length} 件あります。コミットするか退避してから、もう一度承認してください`,
          { path: checkedOut.path, files: dirty.length },
        );
      }
      try {
        await git(checkedOut.path, ['merge', '--ff-only', '--quiet', '--no-verify', headSha!]);
      } catch (err) {
        refuse(
          `「${target}」への早送りマージに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      // Not checked out anywhere: move the ref, guarded by its old value.
      await git(repo, [
        'update-ref',
        '-m',
        `acc: apply integration ${integ.branch}`,
        `refs/heads/${target}`,
        headSha!,
        targetSha!,
      ]);
    }

    const now = this.ctx.clock.iso();
    return this.update(
      id,
      actor,
      ['status', 'steps', 'decidedBy', 'decidedAt', 'decisionNote'],
      (i) => ({
        ...i,
        status: 'applied',
        decidedBy: actor,
        decidedAt: now,
        decisionNote: note,
        steps: patchSteps(i.steps, stepIndex, {
          status: 'succeeded',
          detail: `「${target}」を ${short(targetSha)} から ${short(headSha)} へ早送りしました`,
          endedAt: now,
        }),
      }),
    );
  }

  reject(integrationId: string, actor: Actor, note?: string): Integration {
    const cur = this.get(integrationId);
    if (
      ACTIVE.includes(cur.status) ||
      this.jobs.has(integrationId) ||
      this.applying.has(integrationId)
    ) {
      throw conflict('実行中の統合は却下できません。完了を待ってから却下してください', {
        integrationId,
      });
    }
    if (FINAL.includes(cur.status)) {
      throw conflict(`この統合はすでに確定しています（${cur.status}）`, {
        integrationId,
        status: cur.status,
      });
    }
    const now = this.ctx.clock.iso();
    return this.update(
      integrationId,
      actor,
      ['status', 'steps', 'decidedBy', 'decidedAt', 'decisionNote'],
      (i) => ({
        ...i,
        status: 'rejected',
        decidedBy: actor,
        decidedAt: now,
        decisionNote: note ?? null,
        steps: i.steps.map((s) =>
          s.status === 'pending' || s.status === 'running'
            ? {
                ...s,
                status: 'skipped' as const,
                endedAt: s.status === 'running' ? now : s.endedAt,
              }
            : s,
        ),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // conflict resolution by an integrator agent (concept §6.1 step 5)
  // -------------------------------------------------------------------------

  /**
   * Re-create the merge that conflicted in the integration worktree, leaving the conflict
   * markers for an agent to resolve. The integration becomes `running` with a `fix` step
   * after the conflicting merge, so integration.wait keeps waiting and no other attempt can
   * start meanwhile. `merged: true` means the merge no longer conflicts (a source changed):
   * the caller resumes with `resumeAfterCleanMerge` instead of starting an agent.
   */
  async prepareResolution(
    integrationId: string,
    actor: Actor,
  ): Promise<{ integration: Integration; step: IntegrationStep; merged: boolean }> {
    const cur = this.get(integrationId);
    if (
      this.jobs.has(integrationId) ||
      this.resolutions.has(integrationId) ||
      this.applying.has(integrationId)
    ) {
      throw conflict('この統合はすでに実行中です', { integrationId });
    }
    if (cur.status !== 'conflict') {
      throw conflict(
        `コンフリクトしている統合だけを Integrator に任せられます（現在: ${cur.status}）`,
        { integrationId, status: cur.status },
      );
    }
    const step = [...cur.steps]
      .reverse()
      .find((s) => s.kind === 'merge' && s.status === 'failed' && s.conflictFiles.length > 0);
    if (!step?.branch || !cur.workspaceId || !cur.branch) {
      throw conflict('コンフリクトしたマージの記録が見つかりません', { integrationId });
    }
    const wsPath = this.workspaces.get(cur.workspaceId).path;
    if (!existsSync(wsPath)) {
      throw conflict(`統合用ワークスペースが見つかりません: ${wsPath}`, { integrationId });
    }
    const branch = step.branch;
    const integrationBranch = cur.branch;
    const env = this.workspaces.identityEnv(cur.projectId);

    // Claim it before any await: status running + a fix step after the conflicting merge.
    this.resolutions.set(integrationId, { preSha: null, branch });
    const now = this.ctx.clock.iso();
    this.update(integrationId, actor, ['status', 'steps', 'error'], (i) => ({
      ...i,
      status: 'running',
      error: null,
      steps: insertAfter(
        i.steps.filter((s) => s.kind !== 'fix'),
        step.index,
        {
          index: 0,
          kind: 'fix',
          status: 'running',
          title: `Integrator がコンフリクトを解消（${step.conflictFiles.join(', ')}）`,
          taskId: step.taskId,
          artifactId: null,
          detail: 'コンフリクトしたマージを作業ツリーに再現しています',
          startedAt: now,
          endedAt: null,
          workspaceId: step.workspaceId,
          branch,
          conflictFiles: step.conflictFiles,
        },
      ),
    }));

    try {
      return await this.projectQueue.run(cur.projectId, async () => {
        await git(wsPath, ['merge', '--abort'], { okCodes: [0, 128] });
        await git(wsPath, ['reset', '--hard', '--quiet', 'HEAD']);
        await git(wsPath, ['clean', '-fdq']);
        const preSha = await gitOut(wsPath, ['rev-parse', 'HEAD']);
        this.resolutions.set(integrationId, { preSha, branch });
        const r = await git(
          wsPath,
          [
            'merge',
            '--no-ff',
            '--no-edit',
            '--no-verify',
            '-m',
            `Merge ${branch} into ${integrationBranch}`,
            branch,
          ],
          { okCodes: [0, 1, 128], env },
        );
        const files = r.code === 0 ? [] : await conflictedFiles(wsPath).catch(() => []);
        if (r.code !== 0 && files.length === 0) {
          const reason = (r.stderr.trim() || r.stdout.trim()).split(/\r?\n/).slice(-3).join('\n');
          throw new Error(reason || 'コンフリクトしたマージを再現できませんでした');
        }
        const integration = this.patchFix(integrationId, actor, {
          detail:
            r.code === 0
              ? 'マージはコンフリクトせずに完了しました'
              : `コンフリクト（${files.length} ファイル）の解消を Integrator に任せます`,
          conflictFiles: files.length > 0 ? files : step.conflictFiles,
        });
        return { integration, step, merged: r.code === 0 };
      });
    } catch (err) {
      await this.abandonResolution(integrationId, actor, errorMessage(err));
      throw err;
    }
  }

  /** Record the integrator run of a prepared resolution (in the transaction that starts it). */
  attachResolver(integrationId: string, actor: Actor, runId: string): Integration {
    return this.update(integrationId, actor, ['resolverRunId', 'steps'], (i) => ({
      ...i,
      resolverRunId: runId,
      steps: i.steps.map((s) =>
        s.kind === 'fix' && s.status === 'running'
          ? { ...s, detail: `Integrator（Run ${runId}）がコンフリクトを解消しています` }
          : s,
      ),
    }));
  }

  /**
   * Give up a resolution: abort the re-created merge (the integration branch returns to
   * where it was) and put the integration back to `conflict` with the reason.
   */
  async abandonResolution(
    integrationId: string,
    actor: Actor,
    message: string,
  ): Promise<Integration> {
    const res = this.resolutions.get(integrationId);
    this.resolutions.delete(integrationId);
    const integ = this.get(integrationId);
    const ws = integ.workspaceId ? this.ctx.repos.workspaces.get(integ.workspaceId) : undefined;
    if (ws && existsSync(ws.path)) {
      await this.projectQueue
        .run(integ.projectId, async () => {
          await git(ws.path, ['merge', '--abort'], { okCodes: [0, 128] });
          await git(ws.path, ['reset', '--hard', '--quiet', res?.preSha ?? 'HEAD']);
          await git(ws.path, ['clean', '-fdq']);
        })
        .catch((err: unknown) =>
          this.ctx.log.warn('failed to reset the integration worktree', { integrationId, err }),
        );
    }
    const now = this.ctx.clock.iso();
    return this.update(integrationId, actor, ['status', 'steps', 'error'], (i) => ({
      ...i,
      status: 'conflict',
      error: { code: 'resolution_failed', message },
      steps: i.steps.map((s) =>
        s.kind === 'fix' && s.status === 'running'
          ? { ...s, status: 'failed' as const, detail: message, endedAt: now }
          : s,
      ),
    }));
  }

  /** Resume at once when the re-created merge did not conflict (no agent needed). */
  resumeAfterCleanMerge(integrationId: string, actor: Actor): Integration {
    return this.completeResolution(integrationId, actor, 'マージはコンフリクトせずに完了しました');
  }

  /**
   * An integrator run ended. Completed with the merge committed and no conflict markers
   * left → resume the integration (remaining merges, then verification). Anything else →
   * back to `conflict` with the reason (the integration branch is reset to before the merge).
   */
  onRunEnded(run: Run): void {
    if (run.kind !== 'agent' || !isTerminalRunStatus(run.status)) return;
    const integ = this.ctx.repos.integrations
      .find({ where: { status: ['running'] } })
      .find((i) => i.resolverRunId === run.id);
    if (!integ || !this.resolutions.has(integ.id)) return;
    const actor: Actor = { kind: 'system', component: 'integration' };
    void this.finishResolution(integ, run, actor).catch(async (err: unknown) => {
      this.ctx.log.error('failed to finish an integrator resolution', { id: integ.id, err });
      await this.abandonResolution(integ.id, actor, errorMessage(err)).catch(() => {});
    });
  }

  private async finishResolution(integ: Integration, run: Run, actor: Actor): Promise<void> {
    const res = this.resolutions.get(integ.id);
    if (!res) return;
    if (run.status !== 'completed') {
      const why = run.error?.message ?? run.statusReason ?? run.status;
      await this.abandonResolution(
        integ.id,
        actor,
        `Integrator の Run が ${run.status} で終わったため、コンフリクトは解消されていません（${why}）`,
      );
      return;
    }
    const wsPath = this.workspaces.get(integ.workspaceId!).path;
    const fixFiles = this.get(integ.id).steps.find((s) => s.kind === 'fix')?.conflictFiles ?? [];
    const problem = await this.projectQueue.run(integ.projectId, async () => {
      if (await resolveCommit(wsPath, 'MERGE_HEAD')) return 'マージがコミットされていません';
      const unmerged = await conflictedFiles(wsPath).catch(() => []);
      if (unmerged.length > 0) return `未解決のファイルがあります: ${unmerged.join(', ')}`;
      if (!(await this.alreadyMerged(wsPath, wsPath, res.branch))) {
        return `「${res.branch}」が統合ブランチに取り込まれていません`;
      }
      const marked = await filesWithMarkers(wsPath, fixFiles);
      if (marked.length > 0) return `コンフリクトマーカーが残っています: ${marked.join(', ')}`;
      return null;
    });
    if (problem) {
      await this.abandonResolution(
        integ.id,
        actor,
        `Integrator の解消を確認できませんでした: ${problem}`,
      );
      return;
    }
    const sha = await gitOut(wsPath, ['rev-parse', 'HEAD']);
    this.completeResolution(
      integ.id,
      actor,
      `Integrator がコンフリクトを解消し、マージをコミットしました（${short(sha)}）`,
    );
  }

  /** Mark the fix step done and resume the attempt on the integration branch as it is. */
  private completeResolution(id: string, actor: Actor, detail: string): Integration {
    this.resolutions.delete(id);
    const now = this.ctx.clock.iso();
    const integ = this.update(id, actor, ['steps'], (i) => ({
      ...i,
      // Merges from the conflicting one on, verification and apply run again; the record of
      // where it conflicted (conflictFiles) is kept.
      steps: i.steps.map((s) =>
        s.kind === 'fix'
          ? s.status === 'running'
            ? { ...s, status: 'succeeded' as const, detail, endedAt: now }
            : s
          : s.status === 'succeeded'
            ? s
            : { ...resetStep(s), conflictFiles: s.conflictFiles },
      ),
    }));
    this.startJob(id, integ.projectId, actor, 'resume');
    return integ;
  }

  private patchFix(id: string, actor: Actor, patch: Partial<IntegrationStep>): Integration {
    return this.update(id, actor, ['steps'], (i) => ({
      ...i,
      steps: i.steps.map((s) =>
        s.kind === 'fix' && s.status === 'running' ? { ...s, ...patch } : s,
      ),
    }));
  }

  /** Whether a source branch's tip is already contained in the integration worktree's HEAD. */
  private async alreadyMerged(
    wsPath: string,
    repo: string,
    branch: string | null,
  ): Promise<boolean> {
    if (!branch) return false;
    const tip = await resolveCommit(repo, `refs/heads/${branch}`);
    return !!tip && (await gitTest(wsPath, ['merge-base', '--is-ancestor', tip, 'HEAD']));
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  /** Attempts cut off by a previous daemon process end as failed (their branches are kept). */
  recoverOnStart(): string[] {
    const actor: Actor = { kind: 'system', component: 'integration' };
    const stale = this.ctx.repos.integrations.find({ where: { status: ACTIVE } });
    for (const integ of stale) {
      this.cancelApprovals(integ.id, actor);
      this.update(integ.id, actor, ['status', 'steps', 'error'], (i) => ({
        ...i,
        status: 'failed',
        error: { code: 'daemon_restart', message: 'デーモンの再起動により統合が中断されました' },
        steps: i.steps.map(abandonStep(this.ctx.clock.iso())),
      }));
    }
    return stale.map((i) => i.id);
  }

  async stop(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled([...this.jobs.values()]);
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private update(
    id: string,
    actor: Actor,
    changes: string[],
    fn: (i: Integration) => Integration,
  ): Integration {
    return this.ctx.db.transaction(() => {
      const integration = this.ctx.repos.integrations.update(id, (i) => ({
        ...fn(i),
        updatedAt: this.ctx.clock.iso(),
      }));
      this.ctx.bus.emit({ type: 'integration.updated', actor, payload: { integration, changes } });
      return integration;
    });
  }

  private setStep(
    id: string,
    actor: Actor,
    index: number,
    patch: Partial<IntegrationStep>,
  ): Integration {
    return this.update(id, actor, ['steps'], (i) => ({
      ...i,
      steps: patchSteps(i.steps, index, patch),
    }));
  }

  /** End the attempt: final status, error, and every step not reached marked skipped. */
  private finish(
    id: string,
    actor: Actor,
    status: IntegrationStatus,
    error: ErrorInfo | null,
  ): Integration {
    return this.update(id, actor, ['status', 'steps', 'error'], (i) => ({
      ...i,
      status,
      error,
      steps: i.steps.map((s) =>
        s.status === 'pending' && (status !== 'awaiting_approval' || s.kind !== 'apply')
          ? { ...s, status: 'skipped' as const }
          : s,
      ),
    }));
  }

  private failUnexpected(id: string, actor: Actor, err: unknown): Integration {
    this.ctx.log.error('integration attempt failed', { id, err });
    const message = err instanceof Error ? err.message : String(err);
    try {
      return this.update(id, actor, ['status', 'steps', 'error'], (i) => ({
        ...i,
        status: 'failed',
        error: { code: 'internal', message },
        steps: i.steps.map(abandonStep(this.ctx.clock.iso(), message)),
      }));
    } catch {
      // DB already closed (shutdown): the next start recovers it.
      return this.ctx.repos.integrations.get(id) as Integration;
    }
  }
}

function defaultTitle(sources: Source[], target: string): string {
  const named = sources.map((s) => s.title).filter((t): t is string => !!t);
  if (named.length === sources.length && named.length <= 2) {
    return `統合: ${named.join('、')} → ${target}`;
  }
  return `統合: ${sources.length} 件の変更 → ${target}`;
}

function planSteps(sources: Source[], project: Project, target: string): IntegrationStep[] {
  const base = {
    status: 'pending' as const,
    artifactId: null,
    detail: null,
    startedAt: null,
    endedAt: null,
    conflictFiles: [],
  };
  const steps: IntegrationStep[] = sources.map((s, index) => ({
    ...base,
    index,
    kind: 'merge',
    title: s.title ? `「${s.title}」をマージ` : `「${s.workspace.branch}」をマージ`,
    taskId: s.taskId,
    workspaceId: s.workspace.id,
    branch: s.workspace.branch,
  }));
  steps.push({
    ...base,
    index: steps.length,
    kind: 'verify',
    title: verifyTitle(project),
    taskId: null,
    workspaceId: null,
    branch: null,
  });
  steps.push({
    ...base,
    index: steps.length,
    kind: 'apply',
    title: `「${target}」へ反映（要承認）`,
    taskId: null,
    workspaceId: null,
    branch: null,
  });
  return steps;
}

function verifyTitle(project: Project): string {
  return project.testCommand ? `テストを実行（${project.testCommand}）` : 'テストを実行';
}

function renumber(steps: IntegrationStep[]): IntegrationStep[] {
  return steps.map((s, index) => (s.index === index ? s : { ...s, index }));
}

/** Insert a step right after the step with `afterIndex`, renumbering the rest. */
function insertAfter(
  steps: IntegrationStep[],
  afterIndex: number,
  step: IntegrationStep,
): IntegrationStep[] {
  const at = steps.findIndex((s) => s.index === afterIndex) + 1;
  return renumber([...steps.slice(0, at), step, ...steps.slice(at)]);
}

const CONFLICT_MARKER = /^(<{7}|>{7})(\s|$)|^={7}\r?$/m;

/** Files (relative to `cwd`) that still contain conflict markers. */
async function filesWithMarkers(cwd: string, files: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    try {
      if (CONFLICT_MARKER.test(await readFile(join(cwd, f), 'utf8'))) out.push(f);
    } catch {
      // Deleted while resolving: nothing left to check.
    }
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resetStep(s: IntegrationStep): IntegrationStep {
  return {
    ...s,
    status: 'pending',
    artifactId: null,
    detail: null,
    startedAt: null,
    endedAt: null,
    conflictFiles: [],
  };
}

function abandonStep(now: string, message?: string) {
  return (s: IntegrationStep): IntegrationStep =>
    s.status === 'running'
      ? { ...s, status: 'failed', endedAt: now, detail: message ?? s.detail }
      : s.status === 'pending'
        ? { ...s, status: 'skipped' }
        : s;
}

function patchSteps(
  steps: IntegrationStep[],
  index: number,
  patch: Partial<IntegrationStep>,
): IntegrationStep[] {
  return steps.map((s) => (s.index === index ? { ...s, ...patch } : s));
}
