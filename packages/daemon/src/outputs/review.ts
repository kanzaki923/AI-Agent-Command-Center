import {
  type Actor,
  type Artifact,
  type ArtifactReview,
  type Integration,
  type Params,
  type Result,
  isTerminalRunStatus,
} from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { conflict, forbidden, invalidParams } from '../core/errors';
import { truncate } from '../runtime/tools';
import { asCurrentKind } from './legacy';
import { OUTPUTS_SYSTEM } from './finalize';

type ReviewResult = Result<'artifact.review'>;

/** Code changes whose acceptance is creating its integration right now. */
const accepting = new Set<string>();

/** Integrations still on their way (an acceptance in flight). */
const IN_FLIGHT: Integration['status'][] = ['pending', 'running', 'verifying', 'awaiting_approval'];

/**
 * `artifact.review` (spec 20261029 §2.2, §3.5).
 *
 * - `accept` (humans only): a code change (`diff`) is integrated on its own — an integration
 *   of just that change, verified with the project's test command, applied once the tests
 *   pass (`preApprovedBy`: the human already decided). The artifact stays `pending` until the
 *   change is applied (then `accepted`; see `onIntegrationUpdated`). Any other output is
 *   accepted at once; when nothing else of that run waits, its task becomes `done`.
 * - `redo` (humans, and agents within their own tree — the requester): sends the work back
 *   to the same child (`task.retry` with the note: same session and workspace), or as a
 *   message when there is no task. The output and its run's other waiting outputs become
 *   `rejected`.
 */
export async function reviewArtifact(
  ctx: DaemonContext,
  p: Params<'artifact.review'>,
  actor: Actor,
): Promise<ReviewResult> {
  const artifacts = ctx.service('artifacts');
  const a = artifacts.getStored(p.artifactId);
  if (a.role !== 'output') {
    throw invalidParams(
      'コミットやテスト結果は確認の記録です。採用・やり直しは成果物（文書・表・リンク・ファイル・コードの変更）にしてください',
    );
  }
  if (p.decision === 'accept') {
    if (actor.kind !== 'human') {
      throw forbidden(
        '成果物を採用できるのは人間だけです（コードの変更は反映を伴うため）。やり直しは redo で依頼できます',
      );
    }
    return a.kind === 'diff'
      ? acceptCode(ctx, a, actor, p.note)
      : acceptOutput(ctx, a, actor, p.note);
  }
  return redo(ctx, a, actor, p.note);
}

// ---- accept ------------------------------------------------------------------

function acceptOutput(
  ctx: DaemonContext,
  a: Artifact,
  actor: Actor,
  note: string | undefined,
): ReviewResult {
  const artifacts = ctx.service('artifacts');
  if (a.review.state === 'accepted') return { artifact: asCurrentKind(a), integrationId: null };
  const res = ctx.db.transaction(() => {
    const artifact = artifacts.setReview(a.id, decided('accepted', actor, ctx, note), actor);
    const doneSessionId = finishTaskIfSettled(ctx, a, actor);
    resolveAttention(ctx, { artifactId: a.id }, actor, 'accept');
    return { artifact, doneSessionId };
  });
  if (res.doneSessionId) releaseChildBudget(ctx, res.doneSessionId);
  return { artifact: res.artifact, integrationId: null };
}

async function acceptCode(
  ctx: DaemonContext,
  a: Extract<Artifact, { kind: 'diff' }>,
  actor: Actor,
  note: string | undefined,
): Promise<ReviewResult> {
  if (a.review.state === 'accepted') {
    throw conflict('このコードの変更はすでに反映されています', { artifactId: a.id });
  }
  const ws = a.workspaceId ? ctx.repos.workspaces.get(a.workspaceId) : undefined;
  if (!ws || ws.kind !== 'worktree' || ws.status !== 'ready' || !ws.projectId) {
    throw conflict('この変更の作業場所（コードの作業ツリー）が残っていないため反映できません', {
      artifactId: a.id,
    });
  }
  const latest = latestDiff(ctx, ws.id);
  if (latest && latest.id !== a.id) {
    throw conflict('この変更のあとに新しい変更があります。新しいほうを確認して採用してください', {
      artifactId: a.id,
      latestArtifactId: latest.id,
    });
  }
  const integrations = ctx.service('integrations');
  const inFlight = integrationsOf(ctx, ws.projectId, ws.id).find(
    (i) => IN_FLIGHT.includes(i.status) && i.preApprovedBy,
  );
  if (inFlight) return { artifact: asCurrentKind(a), integrationId: inFlight.id };
  if (ctx.service('workspaces').isLocked(ws.id)) {
    throw conflict('この変更の作業はまだ続いています。終わってから採用してください', {
      artifactId: a.id,
    });
  }
  // Creating the integration awaits git: a second accept meanwhile must not start another.
  if (accepting.has(a.id)) {
    throw conflict('この変更は反映の準備中です', { artifactId: a.id });
  }
  accepting.add(a.id);
  let integ: Integration;
  try {
    const task = a.taskId ? ctx.repos.tasks.get(a.taskId) : undefined;
    const byTask = task && task.workspaceId === ws.id && task.projectId === ws.projectId;
    const label = task?.title ?? a.title;
    integ = await integrations.create({
      projectId: ws.projectId,
      ...(byTask ? { taskIds: [task.id] } : { workspaceIds: [ws.id] }),
      title: truncate(`「${label}」の変更を反映`, 120),
      actor,
      preApprovedBy: actor,
    });
    integrations.run(integ.id, actor, { autoApply: true });
  } finally {
    accepting.delete(a.id);
  }
  const artifact = ctx
    .service('artifacts')
    .setReview(a.id, { state: 'pending', by: null, at: null, note: note?.trim() || null }, actor);
  resolveAttention(ctx, { artifactId: a.id }, actor, 'accept');
  return { artifact, integrationId: integ.id };
}

// ---- redo --------------------------------------------------------------------

async function redo(
  ctx: DaemonContext,
  a: Artifact,
  actor: Actor,
  note: string | undefined,
): Promise<ReviewResult> {
  const artifacts = ctx.service('artifacts');
  const text = note?.trim() || 'もう一度見直して、やり直してください。';
  const feedback = `成果物「${truncate(a.title, 80)}」へのやり直しの依頼:\n${text}`;
  let failedIntegration: Integration | undefined;
  if (a.kind === 'diff' && a.workspaceId && a.projectId) {
    const mine = integrationsOf(ctx, a.projectId, a.workspaceId);
    if (mine.some((i) => IN_FLIGHT.includes(i.status) && i.preApprovedBy)) {
      throw conflict('この変更は反映の途中です。終わってから、やり直しを依頼してください', {
        artifactId: a.id,
      });
    }
    failedIntegration = mine.find((i) => i.status === 'failed' || i.status === 'conflict');
  }

  if (a.taskId) {
    const tasks = ctx.service('tasks');
    const task = ctx.repos.tasks.require(a.taskId);
    // A done task (an output nobody had to review) is opened again for the redo.
    const reopened = task.status === 'done';
    if (reopened) tasks.setStatus(task.id, 'review', actor, 'redo');
    try {
      await ctx.service('workers').retry(
        {
          taskId: task.id,
          feedback,
          ...(failedIntegration ? { integrationId: failedIntegration.id } : {}),
        },
        actor,
      );
    } catch (err) {
      if (reopened) tasks.setStatus(task.id, 'done', OUTPUTS_SYSTEM, task.statusReason);
      throw err;
    }
  } else if (a.sessionId) {
    await ctx.call(actor, 'session.send', { sessionId: a.sessionId, content: feedback });
  } else {
    throw invalidParams('この成果物には、やり直しを頼める会話がありません');
  }

  const rejected = decided('rejected', actor, ctx, text);
  const artifact = ctx.db.transaction(() => {
    const out = artifacts.setReview(a.id, rejected, actor);
    // The run's other outputs that waited for a decision go back with it.
    if (a.runId) {
      for (const other of ctx.repos.artifacts.find({ where: { run_id: a.runId } })) {
        if (other.id !== a.id && other.role === 'output' && other.review.state === 'pending') {
          artifacts.setReview(other.id, rejected, actor);
        }
      }
    }
    resolveAttention(ctx, { artifactId: a.id }, actor, 'redo', text);
    return out;
  });
  return { artifact, integrationId: null };
}

// ---- integration outcomes ----------------------------------------------------

/**
 * Follow integrations (spec 20261029 §3.5):
 * - `applied`: every task it contains is `done`, the code changes of its workspaces are
 *   `accepted`, the children's unused budget goes back, and its attention items resolve;
 * - `awaiting_approval` that will not apply on its own (a supervisor's integration, a re-run)
 *   → attention `review` on the session that created it (accepting = integration.approve);
 * - an accepted change whose integration failed or conflicted → attention `failure` on the
 *   child (choices: redo, stop);
 * - `rejected` / `cancelled`: its attention items resolve;
 * - running again (an agent resolving its conflict, a re-run): the failure item it opened
 *   resolves, since the work moved on.
 */
export function onIntegrationUpdated(
  ctx: DaemonContext,
  integ: Integration,
  changes: string[],
): void {
  const statusChanged = changes.includes('status');
  switch (integ.status) {
    case 'applied':
      if (statusChanged) settleApplied(ctx, integ);
      return;
    case 'awaiting_approval':
      if (
        (statusChanged || changes.includes('error')) &&
        !ctx.service('integrations').willAutoApply(integ.id)
      ) {
        openReview(ctx, integ);
      }
      return;
    case 'failed':
    case 'conflict':
      if (statusChanged && integ.preApprovedBy) openFailure(ctx, integ);
      return;
    case 'rejected':
    case 'cancelled':
      if (statusChanged) resolveAttention(ctx, { integrationId: integ.id }, OUTPUTS_SYSTEM, null);
      return;
    case 'pending':
    case 'running':
    case 'verifying':
      if (statusChanged) {
        attention(ctx)?.resolveWhere(
          { integrationId: integ.id },
          { choiceId: null, text: null, by: OUTPUTS_SYSTEM },
          ['failure'],
        );
      }
      return;
    default:
      return;
  }
}

function settleApplied(ctx: DaemonContext, integ: Integration): void {
  const artifacts = ctx.service('artifacts');
  const tasks = ctx.service('tasks');
  const by = integ.decidedBy ?? integ.preApprovedBy ?? OUTPUTS_SYSTEM;
  const at = integ.decidedAt ?? ctx.clock.iso();
  const sessions = new Set<string>();
  ctx.db.transaction(() => {
    for (const taskId of integ.taskIds) {
      const task = ctx.repos.tasks.get(taskId);
      if (!task) continue;
      if (task.assigneeSessionId) sessions.add(task.assigneeSessionId);
      if (task.status !== 'done' && task.status !== 'cancelled') {
        tasks.setStatus(task.id, 'done', OUTPUTS_SYSTEM, null);
      }
      resolveAttention(ctx, { taskId: task.id }, by, 'accept');
    }
    for (const wsId of integ.workspaceIds) {
      for (const d of diffsOf(ctx, wsId)) {
        if (d.review.state === 'accepted' || d.review.state === 'rejected') continue;
        artifacts.setReview(d.id, { state: 'accepted', by, at, note: d.review.note }, by);
        resolveAttention(ctx, { artifactId: d.id }, by, 'accept');
        if (d.sessionId) sessions.add(d.sessionId);
      }
    }
    resolveAttention(ctx, { integrationId: integ.id }, by, 'accept');
  });
  for (const s of sessions) releaseChildBudget(ctx, s);
}

function openReview(ctx: DaemonContext, integ: Integration): void {
  const sessionId =
    integ.createdBy.kind === 'agent'
      ? integ.createdBy.sessionId
      : integ.preApprovedBy
        ? childSessionOf(ctx, integ)
        : null;
  if (!sessionId || !ctx.repos.sessions.get(sessionId)) return;
  const n = integ.workspaceIds.length;
  const one = n === 1 ? taskTitleOf(ctx, integ) : null;
  attention(ctx)?.open({
    kind: 'review',
    sessionId,
    title: truncate(one ? `「${one}」の変更を反映` : `${n} 件のコードの変更を反映`, 80),
    detail: integ.error?.message ?? null,
    refs: { integrationId: integ.id },
    actor: OUTPUTS_SYSTEM,
  });
}

function openFailure(ctx: DaemonContext, integ: Integration): void {
  const sessionId = childSessionOf(ctx, integ);
  if (!sessionId) return;
  const title = taskTitleOf(ctx, integ) ?? 'コードの変更';
  const head =
    integ.error?.code === 'tests_failed' || integ.error?.code === 'tests_timed_out'
      ? `「${title}」のテストが失敗`
      : integ.status === 'conflict'
        ? `「${title}」を反映できません（競合）`
        : `「${title}」を反映できません`;
  const wsId = integ.workspaceIds[0];
  const diff = wsId ? latestDiff(ctx, wsId) : undefined;
  const taskId = integ.taskIds[0];
  attention(ctx)?.open({
    kind: 'failure',
    sessionId,
    title: truncate(head, 80),
    detail: integ.error?.message ?? null,
    choices: [
      { id: 'retry', label: 'やり直し', tone: 'primary' },
      { id: 'stop', label: '終える', tone: 'neutral' },
    ],
    allowText: true,
    refs: {
      integrationId: integ.id,
      ...(taskId ? { taskId } : {}),
      ...(diff ? { artifactId: diff.id } : {}),
    },
    actor: OUTPUTS_SYSTEM,
  });
}

// ---- helpers -------------------------------------------------------------------

function decided(
  state: 'accepted' | 'rejected',
  by: Actor,
  ctx: DaemonContext,
  note: string | undefined | null,
): ArtifactReview {
  return { state, by, at: ctx.clock.iso(), note: note?.trim() || null };
}

/**
 * A task in review whose run has no other output waiting becomes `done`. Returns the child
 * session whose budget can go back, if the task finished.
 */
function finishTaskIfSettled(ctx: DaemonContext, a: Artifact, actor: Actor): string | null {
  if (!a.taskId) return null;
  const task = ctx.repos.tasks.get(a.taskId);
  if (!task || task.status !== 'review') return null;
  const waiting = ctx.repos.artifacts
    .find({ where: { task_id: task.id } })
    .some((o) => o.id !== a.id && o.role === 'output' && o.review.state === 'pending');
  if (waiting) return null;
  ctx.service('tasks').setStatus(task.id, 'done', actor, null);
  resolveAttention(ctx, { taskId: task.id }, actor, 'accept');
  return task.assigneeSessionId ?? a.sessionId;
}

/**
 * Give a finished child's unused budget back to its parent (§3.5: "子の予算を返す"). Only a
 * carved-out budget of the child session (it has a parent), and only once no run uses it.
 */
export function releaseChildBudget(ctx: DaemonContext, sessionId: string): void {
  const active = ctx.repos.runs
    .find({ where: { session_id: sessionId } })
    .some((r) => !isTerminalRunStatus(r.status));
  if (active) return;
  for (const b of ctx.repos.budgets.find({
    where: { subject_kind: 'session', subject_id: sessionId, status: 'active' },
  })) {
    if (!b.parentId) continue;
    try {
      ctx.service('budget').release(b.id, OUTPUTS_SYSTEM);
    } catch (err) {
      ctx.log.warn('could not return a child budget', {
        budgetId: b.id,
        error: (err as Error).message,
      });
    }
  }
}

function resolveAttention(
  ctx: DaemonContext,
  refs: Parameters<NonNullable<ReturnType<typeof attention>>['resolveWhere']>[0],
  by: Actor,
  choiceId: string | null,
  text: string | null = null,
): void {
  attention(ctx)?.resolveWhere(refs, { choiceId, text, by });
}

function attention(ctx: DaemonContext) {
  return ctx.hasService('attention') ? ctx.service('attention') : null;
}

function diffsOf(ctx: DaemonContext, workspaceId: string): Artifact[] {
  return ctx.repos.artifacts
    .find({
      where: { kind: 'diff' },
      sql: { clause: "json_extract(data, '$.workspaceId') = ?", params: [workspaceId] },
    })
    .filter((a) => a.role === 'output');
}

/** The newest code change recorded for a workspace (an integration's own diff excluded). */
function latestDiff(ctx: DaemonContext, workspaceId: string): Artifact | undefined {
  return diffsOf(ctx, workspaceId)[0];
}

/** Integrations of a project that merge this workspace, newest first. */
function integrationsOf(ctx: DaemonContext, projectId: string, workspaceId: string): Integration[] {
  return ctx.repos.integrations
    .find({ where: { project_id: projectId } })
    .filter((i) => i.workspaceIds.includes(workspaceId));
}

function taskTitleOf(ctx: DaemonContext, integ: Integration): string | null {
  const taskId = integ.taskIds[0];
  const task = taskId ? ctx.repos.tasks.get(taskId) : undefined;
  if (task) return task.title;
  const wsId = integ.workspaceIds[0];
  const ws = wsId ? ctx.repos.workspaces.get(wsId) : undefined;
  const wsTask = ws?.taskId ? ctx.repos.tasks.get(ws.taskId) : undefined;
  return wsTask?.title ?? null;
}

/** The child whose change the integration carries (its task's session, else the diff's). */
function childSessionOf(ctx: DaemonContext, integ: Integration): string | null {
  const taskId = integ.taskIds[0];
  const task = taskId ? ctx.repos.tasks.get(taskId) : undefined;
  if (task?.assigneeSessionId) return task.assigneeSessionId;
  const wsId = integ.workspaceIds[0];
  return (wsId ? latestDiff(ctx, wsId)?.sessionId : null) ?? null;
}
