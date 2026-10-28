import type {
  BudgetAllocation,
  CapabilityGrant,
  Integration,
  IntegrationStep,
  Project,
  Task,
} from '@acc/protocol';
import { type OrchestratorGrantInput, grantParams } from '../model/grant';
import { type RepoInspection, failedInspection } from '../model/repo';
import { toast, toastError } from '../store/toast';
import { isConnectionError, isNotImplemented } from './errors';
import { qk } from './keys';
import type { AppRuntime } from './runtime';
import { patchIn, removeFrom, upsertIn } from './sync';

/**
 * Human-side operations of the vertical slice: grants (a chat becomes an orchestrator),
 * projects, task workers and integrations. Optimistic where the outcome is predictable,
 * rolled back with a toast when the daemon refuses (ui-design §1.2).
 */

type UntypedCall = (method: string, params: unknown) => Promise<unknown>;
const untyped = (rt: AppRuntime): UntypedCall =>
  rt.client.call.bind(rt.client) as unknown as UntypedCall;

/**
 * Convenience method a newer daemon may offer for the orchestrator preset. Probed via
 * system.info; grant.create (+ budget.allocate) is the contract fallback.
 */
export const ORCHESTRATOR_GRANT_METHODS = [
  'session.grantOrchestration',
  'grant.orchestrator',
  'orchestrator.grant',
] as const;

export function pickMethod(
  methods: ReadonlySet<string> | null | undefined,
  candidates: readonly string[],
): string | null {
  if (!methods) return null;
  return candidates.find((m) => methods.has(m)) ?? null;
}

const byCreatedAsc = (a: { createdAt: string }, b: { createdAt: string }) =>
  a.createdAt.localeCompare(b.createdAt);

let localSeq = 0;

function optimisticGrant(input: OrchestratorGrantInput, now: number): CapabilityGrant {
  const p = grantParams(input, now);
  localSeq++;
  return {
    id: `local_grant_${localSeq}`,
    subject: { kind: 'session', sessionId: input.sessionId },
    parentGrantId: null,
    permissions: p.permissions,
    scope: p.scope ?? {},
    limits: p.limits ?? {},
    depth: 0,
    lifetime: p.lifetime ?? 'run',
    expiresAt: p.expiresAt ?? null,
    revokedAt: null,
    reason: p.reason ?? null,
    grantedBy: { kind: 'human', client: 'desktop' },
    createdAt: new Date(now).toISOString(),
  };
}

function remainingUsd(b: BudgetAllocation): number {
  return b.limitUsd - b.allocatedUsd - b.reservedUsd - b.spentUsd;
}

/**
 * Make a chat an orchestrator. The chip appears in the same frame (optimistic grant); the
 * real grant replaces it when the daemon answers, or it disappears with a toast.
 * The budget pool is a root budget whose subject is the session (agents can carve worker
 * budgets out of budgets their session owns). A failed budget does not undo the grant.
 */
export async function grantOrchestrator(
  rt: AppRuntime,
  input: OrchestratorGrantInput,
  methods: ReadonlySet<string> | null = null,
): Promise<CapabilityGrant | null> {
  const qc = rt.queryClient;
  const key = qk.grants(input.sessionId);
  const now = Date.now();
  const temp = optimisticGrant(input, now);
  qc.setQueryData<CapabilityGrant[]>(key, (cur) => [...(cur ?? []), temp]);

  // The daemon's own orchestrator preset (when offered) keeps grant + budget in one call;
  // other presets, and older daemons, use the contract methods.
  const convenience =
    input.preset === 'orchestrate' && input.projectId
      ? pickMethod(methods, ORCHESTRATOR_GRANT_METHODS)
      : null;
  let grant: CapabilityGrant | null = null;
  try {
    if (convenience) {
      try {
        const params = grantParams(input, now);
        const res = (await untyped(rt)(convenience, {
          sessionId: input.sessionId,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          maxWorkers: input.maxWorkers,
          ...(input.budgetUsd ? { budgetUsd: input.budgetUsd } : {}),
          lifetime: input.lifetime,
          ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
        })) as { grant?: CapabilityGrant; budget?: BudgetAllocation | null } | CapabilityGrant;
        const budget = 'budget' in res ? res.budget : null;
        grant = 'grant' in res && res.grant ? res.grant : (res as CapabilityGrant);
        if (!grant?.id) grant = null;
        if (budget) {
          qc.setQueryData<BudgetAllocation[]>(qk.sessionBudgets(input.sessionId), (cur) => [
            budget,
            ...(cur ?? []).filter((x) => x.id !== budget.id),
          ]);
        }
      } catch (err) {
        // Unknown shape on an older/newer daemon: fall through to the contract methods.
        if (!(isNotImplemented(err) || (err as { code?: string }).code === 'invalid_params'))
          throw err;
      }
    }
    if (!grant) {
      grant = await rt.client.call('grant.create', grantParams(input, now));
      if (input.budgetUsd && input.budgetUsd > 0)
        await ensureSessionBudget(rt, input.sessionId, input.budgetUsd);
    }
    const real = grant;
    qc.setQueryData<CapabilityGrant[]>(key, (cur) =>
      [...(cur ?? []).filter((g) => g.id !== temp.id && g.id !== real.id), real].sort(byCreatedAsc),
    );
    return real;
  } catch (err) {
    removeFrom(qc, key, temp.id);
    toastError(err, '権限を付与できませんでした');
    return null;
  }
}

/** Reuse the session's active budget when it still has room, else create a root budget. */
async function ensureSessionBudget(
  rt: AppRuntime,
  sessionId: string,
  limitUsd: number,
): Promise<void> {
  const cached =
    rt.queryClient.getQueryData<BudgetAllocation[]>(qk.sessionBudgets(sessionId)) ?? [];
  if (cached.some((b) => b.status === 'active' && remainingUsd(b) >= limitUsd)) return;
  try {
    const b = await rt.client.call('budget.allocate', {
      parentId: null,
      subject: { kind: 'session', id: sessionId },
      limitUsd,
    });
    rt.queryClient.setQueryData<BudgetAllocation[]>(qk.sessionBudgets(sessionId), (cur) => [
      b,
      ...(cur ?? []).filter((x) => x.id !== b.id),
    ]);
  } catch (err) {
    toastError(err, '予算を設定できませんでした（権限は付与済みです）');
  }
}

export async function revokeGrant(
  rt: AppRuntime,
  sessionId: string,
  grant: CapabilityGrant,
): Promise<boolean> {
  const qc = rt.queryClient;
  const key = qk.grants(sessionId);
  const at = new Date().toISOString();
  patchIn<CapabilityGrant>(qc, key, grant.id, (g) => ({ ...g, revokedAt: at }));
  if (grant.id.startsWith('local_')) return true;
  try {
    await rt.client.call('grant.revoke', { grantId: grant.id, reason: 'デスクトップから取り消し' });
    return true;
  } catch (err) {
    patchIn<CapabilityGrant>(qc, key, grant.id, (g) => ({ ...g, revokedAt: null }));
    toastError(err, '権限を取り消せませんでした');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface NewProjectInput {
  repoPath: string;
  name: string;
  defaultBranch?: string;
  testCommand?: string;
}

export type CreateProjectResult =
  { ok: true; project: Project; detectedBranch: string | null } | { ok: false; error: string };

/**
 * Create a project from a local repository. The daemon only checks that the path exists,
 * so registering the repository checkout (`workspace.create kind main`) is the git check:
 * a folder that is not a repository is archived again and reported inline. The checked-out
 * branch becomes the default branch unless one was given.
 */
export async function createProject(
  rt: AppRuntime,
  input: NewProjectInput,
): Promise<CreateProjectResult> {
  const qc = rt.queryClient;
  let project: Project;
  try {
    project = await rt.client.call('project.create', {
      name: input.name,
      repoPath: input.repoPath,
      ...(input.defaultBranch ? { defaultBranch: input.defaultBranch } : {}),
      ...(input.testCommand ? { testCommand: input.testCommand } : {}),
    });
  } catch (err) {
    return { ok: false, error: projectError(err) };
  }
  let detectedBranch: string | null = null;
  try {
    const main = await rt.client.call('workspace.create', { projectId: project.id, kind: 'main' });
    detectedBranch = main.branch;
  } catch (err) {
    if (!isNotImplemented(err)) {
      await rt.client
        .call('project.update', { projectId: project.id, archived: true })
        .catch(() => {});
      removeFrom(qc, qk.projects, project.id);
      return { ok: false, error: projectError(err) };
    }
  }
  if (!input.defaultBranch && detectedBranch) {
    project = await rt.client
      .call('project.update', { projectId: project.id, defaultBranch: detectedBranch })
      .catch(() => project);
  }
  upsertIn(qc, qk.projects, project, (a, b) => a.name.localeCompare(b.name));
  return { ok: true, project, detectedBranch };
}

/** The daemon's repository errors in one Japanese sentence (null when unrecognised). */
export function projectErrorText(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (/must be an absolute path|absolute/i.test(msg))
    return '絶対パスで指定してください（例: C:\\work\\my-repo）';
  if (/does not exist|no such file|ENOENT|見つかりません/i.test(msg))
    return 'フォルダが見つかりません。パスを確認してください';
  if (/not a git repository|git リポジトリではありません/i.test(msg))
    return 'git リポジトリではありません。リポジトリのルートフォルダを選んでください';
  if (/detached HEAD/.test(msg))
    return 'detached HEAD のため既定ブランチを決められません。既定ブランチを入力してください';
  return null;
}

function projectError(err: unknown): string {
  return projectErrorText(err) ?? toastError(err, 'プロジェクトを追加できませんでした').title;
}

/**
 * Look at a folder before creating a project (`project.inspectRepo`, read-only): repository
 * root or not, branches, uncommitted changes, a test command, a project already registered
 * for it. Null when the check cannot run (connection down, a daemon without the method):
 * the form then validates on create.
 */
export async function inspectRepo(rt: AppRuntime, path: string): Promise<RepoInspection | null> {
  try {
    return await rt.client.call('project.inspectRepo', { path });
  } catch (err) {
    if (isNotImplemented(err)) {
      rt.markUnimplemented('project.inspectRepo');
      return null;
    }
    if (isConnectionError(err)) return null;
    return failedInspection(
      projectErrorText(err) ?? (err instanceof Error ? err.message : String(err)),
    );
  }
}

export async function updateProject(
  rt: AppRuntime,
  project: Project,
  patch: { name?: string; defaultBranch?: string | null; testCommand?: string | null },
): Promise<boolean> {
  const qc = rt.queryClient;
  patchIn<Project>(qc, qk.projects, project.id, (p) => ({ ...p, ...patch }));
  try {
    const next = await rt.client.call('project.update', { projectId: project.id, ...patch });
    upsertIn(qc, qk.projects, next, (a, b) => a.name.localeCompare(b.name));
    return true;
  } catch (err) {
    upsertIn(qc, qk.projects, project, (a, b) => a.name.localeCompare(b.name));
    toastError(err, 'プロジェクトを更新できませんでした');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * "このTaskを実行": task.spawnWorker (worktree + worker session + run). The task shows as
 * running at once; the daemon's task.updated confirms it.
 */
export async function spawnWorker(
  rt: AppRuntime,
  task: Task,
): Promise<{ sessionId: string } | null> {
  const qc = rt.queryClient;
  patchIn<Task>(qc, qk.tasks, task.id, (t) => ({ ...t, status: 'running' }));
  try {
    const res = await rt.client.call('task.spawnWorker', { taskId: task.id });
    return { sessionId: res.sessionId };
  } catch (err) {
    patchIn<Task>(qc, qk.tasks, task.id, (t) =>
      t.status === 'running' ? { ...t, status: task.status } : t,
    );
    if (isNotImplemented(err)) {
      rt.markUnimplemented('task.spawnWorker');
      toast({
        title: 'この Core Daemon はまだ Worker を起動できません',
        detail: 'task.spawnWorker が実装されると、ここから Worker を起動できます',
        tone: 'info',
        sticky: false,
      });
    } else {
      toastError(err, 'Worker を起動できませんでした');
    }
    return null;
  }
}

/**
 * `task.retry`: a new run in the task's original worker session and worktree, so the
 * branch, its commits and the runtime's conversation carry over. One call — the daemon moves
 * the task to running in the same transaction that starts the run, so it never sits
 * half-moved between review and running. Shown as running at once; restored with a toast
 * when the daemon refuses.
 */
async function retryTask(
  rt: AppRuntime,
  task: Task,
  params: { feedback?: string; integrationId?: string },
  failure: string,
): Promise<{ sessionId: string } | null> {
  const qc = rt.queryClient;
  patchIn<Task>(qc, qk.tasks, task.id, (t) => ({ ...t, status: 'running', statusReason: null }));
  try {
    const res = await rt.client.call('task.retry', { taskId: task.id, ...params });
    return { sessionId: res.sessionId };
  } catch (err) {
    patchIn<Task>(qc, qk.tasks, task.id, (t) =>
      t.status === 'running' ? { ...t, status: task.status, statusReason: task.statusReason } : t,
    );
    toastError(err, failure);
    return null;
  }
}

/** "Worker に差し戻す": the worker continues with the human's review feedback. */
export function reworkTask(
  rt: AppRuntime,
  task: Task,
  feedback: string,
): Promise<{ sessionId: string } | null> {
  return retryTask(rt, task, { feedback: feedback.trim() }, 'Worker に差し戻せませんでした');
}

/**
 * "再開": a task whose worker was cut off by a daemon stop / restart (`ready` with
 * statusReason `interrupted`) continues on the same worktree, without new instructions.
 */
export function resumeTask(rt: AppRuntime, task: Task): Promise<{ sessionId: string } | null> {
  return retryTask(rt, task, {}, 'Task を再開できませんでした');
}

/** "Task を中止": the task, its subtasks and their running workers stop (worktrees stay). */
export async function cancelTask(rt: AppRuntime, task: Task): Promise<boolean> {
  const qc = rt.queryClient;
  patchIn<Task>(qc, qk.tasks, task.id, (t) => ({ ...t, status: 'cancelled' }));
  try {
    const next = await rt.client.call('task.cancel', { taskId: task.id, reason: 'デスクトップから中止' });
    upsertIn(qc, qk.tasks, next);
    return true;
  } catch (err) {
    upsertIn(qc, qk.tasks, task);
    toastError(err, 'Task を中止できませんでした');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

/** Create an integration candidate for tasks (in merge order) and start merging + testing. */
export async function startIntegration(
  rt: AppRuntime,
  projectId: string,
  taskIds: string[],
): Promise<Integration | null> {
  try {
    const created = await rt.client.call('integration.create', { projectId, taskIds });
    upsertIn(rt.queryClient, qk.integrations, created);
    const running = await rt.client.call('integration.run', { integrationId: created.id });
    upsertIn(rt.queryClient, qk.integrations, running);
    return running;
  } catch (err) {
    toastError(err, '統合を開始できませんでした');
    return null;
  }
}

export async function rerunIntegration(rt: AppRuntime, integ: Integration): Promise<void> {
  const qc = rt.queryClient;
  patchIn<Integration>(qc, qk.integrations, integ.id, (i) => ({
    ...i,
    status: 'running',
    error: null,
  }));
  try {
    const next = await rt.client.call('integration.run', { integrationId: integ.id });
    upsertIn(qc, qk.integrations, next);
  } catch (err) {
    upsertIn(qc, qk.integrations, integ);
    toastError(err, '統合を再実行できませんでした');
  }
}

/**
 * "Integrator に解消を任せる" (`integration.resolveWithAgent`, conflict only): the daemon
 * re-creates the conflicting merge on the integration branch and starts an integrator agent
 * with both tasks' goals; when it finishes, the merge is committed and the integration
 * resumes (remaining merges, tests) — or returns to conflict with the reason. The target
 * branch is never touched: applying still needs the human's approval.
 * Shown as running at once; the daemon's integration.updated events carry the fix step.
 */
export async function resolveWithAgent(
  rt: AppRuntime,
  integ: Integration,
  instructions?: string,
): Promise<{ integration: Integration; sessionId: string | null } | null> {
  const qc = rt.queryClient;
  const optimistic: Integration = { ...integ, status: 'running', error: null };
  upsertIn(qc, qk.integrations, optimistic);
  qc.setQueryData(['integration.get', integ.id], optimistic);
  try {
    const res = await rt.client.call('integration.resolveWithAgent', {
      integrationId: integ.id,
      ...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
    });
    // An event may already have moved it further; never step back to the call's snapshot.
    const cur = qc.getQueryData<Integration[]>(qk.integrations)?.find((i) => i.id === integ.id);
    if (!cur || cur.updatedAt <= res.integration.updatedAt) {
      upsertIn(qc, qk.integrations, res.integration);
      qc.setQueryData(['integration.get', integ.id], res.integration);
    }
    return { integration: res.integration, sessionId: res.sessionId };
  } catch (err) {
    upsertIn(qc, qk.integrations, integ);
    qc.setQueryData(['integration.get', integ.id], integ);
    toastError(err, 'Integrator に任せられませんでした');
    return null;
  }
}

function patchApplyStep(
  steps: IntegrationStep[],
  patch: Partial<IntegrationStep>,
): IntegrationStep[] {
  return steps.map((s) => (s.kind === 'apply' ? { ...s, ...patch } : s));
}

/**
 * Approve = fast-forward the target branch (human only). Shown as applied immediately;
 * rolled back with the daemon's reason (e.g. the target moved on) if it refuses.
 */
export async function approveIntegration(
  rt: AppRuntime,
  integ: Integration,
  note?: string,
): Promise<boolean> {
  const qc = rt.queryClient;
  const now = new Date().toISOString();
  const optimistic: Integration = {
    ...integ,
    status: 'applied',
    decidedBy: { kind: 'human', client: 'desktop' },
    decidedAt: now,
    decisionNote: note ?? null,
    steps: patchApplyStep(integ.steps, { status: 'succeeded', endedAt: now }),
  };
  upsertIn(qc, qk.integrations, optimistic);
  qc.setQueryData(['integration.get', integ.id], optimistic);
  try {
    const next = await rt.client.call('integration.approve', {
      integrationId: integ.id,
      ...(note ? { note } : {}),
    });
    upsertIn(qc, qk.integrations, next);
    // No success toast: the review screen the human is looking at already says so (§8.5).
    return true;
  } catch (err) {
    upsertIn(qc, qk.integrations, integ);
    qc.setQueryData(['integration.get', integ.id], integ);
    toastError(err, '反映できませんでした');
    return false;
  }
}

export async function rejectIntegration(
  rt: AppRuntime,
  integ: Integration,
  note?: string,
): Promise<boolean> {
  const qc = rt.queryClient;
  const optimistic: Integration = {
    ...integ,
    status: 'rejected',
    decidedBy: { kind: 'human', client: 'desktop' },
    decidedAt: new Date().toISOString(),
    decisionNote: note ?? null,
  };
  upsertIn(qc, qk.integrations, optimistic);
  try {
    const next = await rt.client.call('integration.reject', {
      integrationId: integ.id,
      ...(note ? { note } : {}),
    });
    upsertIn(qc, qk.integrations, next);
    return true;
  } catch (err) {
    upsertIn(qc, qk.integrations, integ);
    toastError(err, '却下できませんでした');
    return false;
  }
}
