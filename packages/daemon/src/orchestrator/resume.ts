import type { Integration, Message, Run, Session, SystemActor, Task } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { isLegacyOrchestrator, isSupervisor } from '../inbox/supervision';
import { textOfParts } from '../llm/messages';
import { sessionBudgetId } from '../sessions/methods/shared';
import { truncate } from '../runtime/tools';
import { ORCHESTRATOR_RESUME_NOTICE } from './executor';
import { INTERRUPTED, ORCHESTRATION_SYSTEM, type WorkerService } from './workers';

/** Run.statusReason values of runs cut off by the daemon process ending. */
const DAEMON_REASONS = ['daemon_restart', 'daemon_shutdown'];

const TASK_STATUS_JA: Record<Task['status'], string> = {
  pending: '待機中',
  ready: '着手可能',
  running: '実行中',
  review: 'レビュー待ち',
  done: '完了',
  failed: '失敗',
  cancelled: 'キャンセル',
  blocked: 'ブロック中',
  paused: '停止中',
};

export interface ResumeReport {
  /** Interrupted orchestrator runs whose session got the notice. */
  notified: string[];
  /** New orchestrator runs started to continue them. */
  resumed: string[];
}

/**
 * Startup (concept §8.4): an orchestrator run cut off by the previous daemon process
 * (interrupted with `daemon_restart` / `daemon_shutdown`, and still the latest run of its
 * session) gets a system message in its session that summarizes where things stand. When
 * `settings.autoResumeOrchestrators` is on and the session's orchestrator grant is still
 * valid, a new orchestrator run starts right after it and continues from the persisted
 * task states (the model reads task.list; interrupted tasks are resumed with task.retry).
 *
 * The notice names the interrupted run, so each one is handled once.
 */
export function resumeInterruptedOrchestrators(
  ctx: DaemonContext,
  workers: WorkerService,
): ResumeReport {
  const report: ResumeReport = { notified: [], resumed: [] };
  const stale = ctx.repos.runs.find({
    where: { kind: 'orchestrator', status: 'interrupted' },
    direction: 'asc',
  });
  for (const run of stale) {
    if (!DAEMON_REASONS.includes(run.statusReason ?? '')) continue;
    const latest = ctx.repos.runs.findOne({
      where: { session_id: run.sessionId },
      direction: 'desc',
    });
    if (latest?.id !== run.id) continue;
    const session = ctx.repos.sessions.get(run.sessionId);
    if (!session || session.archivedAt || alreadyNotified(ctx, run)) continue;
    // Supervisors (session.delegate) are woken through their inbox instead.
    if (isSupervisor(ctx, session.id)) continue;
    try {
      const resumedRunId = resumeOne(ctx, workers, run);
      report.notified.push(run.id);
      if (resumedRunId) report.resumed.push(resumedRunId);
    } catch (err) {
      ctx.log.error('failed to resume an interrupted orchestrator', { runId: run.id, err });
    }
  }
  return report;
}

function resumeOne(ctx: DaemonContext, workers: WorkerService, run: Run): string | null {
  const settings = ctx.settings.get();
  const grantValid = ctx.service('policy').sessionAllows(run.sessionId, 'task.spawnWorker');
  const autoResume = settings.autoResumeOrchestrators && settings.autoResume;
  const resume = autoResume && grantValid;
  const why = !autoResume
    ? '設定で自動再開がオフになっているため、自動では再開しません。'
    : !grantValid
      ? 'Orchestrator の権限が有効ではない（Run の終了で失効した、または取り消された）ため、自動では再開しません。'
      : null;

  return ctx.db.transaction(() => {
    const message = ctx.service('sessions').appendMessage({
      sessionId: run.sessionId,
      role: 'system',
      content: [{ type: 'text', text: noticeText(ctx, run, resume ? null : why) }],
      author: ORCHESTRATION_SYSTEM,
    });
    let next: Run | null = null;
    if (resume) {
      const budget = run.budgetId ? ctx.repos.budgets.get(run.budgetId) : undefined;
      next = ctx.service('runs').start({
        sessionId: run.sessionId,
        kind: 'orchestrator',
        createdBy: ORCHESTRATION_SYSTEM,
        projectId: run.projectId,
        model: run.model,
        budgetId: budget?.status === 'active' ? budget.id : null,
        triggerMessageId: message.id,
      });
    }
    workers.decide(
      {
        decision: next
          ? '中断された Orchestrator を再開しました'
          : '中断された Orchestrator の状況を知らせました',
        rationale: next
          ? `デーモンの再起動で Run ${run.id} が中断されました。新しい Run ${next.id} が Task の状態を読み直し、続きから進めます。`
          : `デーモンの再起動で Run ${run.id} が中断されました。${why ?? ''}`,
        runIds: next ? [run.id, next.id] : [run.id],
        sessionIds: [run.sessionId],
      },
      { projectId: run.projectId, sessionId: run.sessionId, runId: next?.id ?? run.id },
    );
    return next?.id ?? null;
  });
}

/** The system message: what was interrupted, the state of its tasks and integrations. */
function noticeText(ctx: DaemonContext, run: Run, notResumingBecause: string | null): string {
  const mine = <T extends { createdBy: { kind: string } }>(items: T[]) =>
    items.filter(
      (x) =>
        x.createdBy.kind === 'agent' &&
        (x.createdBy as { sessionId?: string }).sessionId === run.sessionId,
    );
  const tasks: Task[] = run.projectId
    ? mine(ctx.repos.tasks.find({ where: { project_id: run.projectId }, direction: 'asc' }))
    : [];
  const integrations: Integration[] = run.projectId
    ? mine(ctx.repos.integrations.find({ where: { project_id: run.projectId }, direction: 'asc' }))
    : [];
  const lines = [`${ORCHESTRATOR_RESUME_NOTICE}（Run ${run.id}）。`];
  if (tasks.length > 0) {
    lines.push('', '中断時点の Task:');
    for (const t of tasks) {
      const reason =
        t.statusReason === INTERRUPTED
          ? '（Worker の作業が中断。task.retry で同じ worktree から再開できます）'
          : t.statusReason
            ? `（${t.statusReason}）`
            : '';
      lines.push(`- ${t.id}「${truncate(t.title, 80)}」: ${TASK_STATUS_JA[t.status]}${reason}`);
    }
  }
  if (integrations.length > 0) {
    lines.push('', '統合:');
    for (const i of integrations) {
      lines.push(`- ${i.id}: ${i.status}${i.error ? `（${truncate(i.error.message, 120)}）` : ''}`);
    }
  }
  lines.push(
    '',
    notResumingBecause
      ? `${notResumingBecause}続けるときは、このチャットに指示を送ってください。`
      : 'Task の状態を確認して、計画の続きから再開します。',
  );
  return lines.join('\n');
}

function alreadyNotified(ctx: DaemonContext, run: Run): boolean {
  const recent: Message[] = ctx.repos.messages.find({
    where: { session_id: run.sessionId },
    orderBy: 'id',
    direction: 'desc',
    limit: 50,
  });
  return recent.some(
    (m) =>
      m.role === 'system' &&
      textOfParts(m.content).startsWith(ORCHESTRATOR_RESUME_NOTICE) &&
      textOfParts(m.content).includes(run.id),
  );
}

// ---------------------------------------------------------------------------
// Supervisors and their children (spec 20261029 §3.10)
// ---------------------------------------------------------------------------

const RESUME_SYSTEM: SystemActor = { kind: 'system', component: 'resume' };

/** First message of a child agent's run that continues after a restart. */
export const RESTART_RESUME_TEXT =
  'デーモンの再起動で作業が中断されました。中断したところから続けてください。';

export interface RestartReport {
  /** Supervisors that got a `resume` item (they are woken through their inbox). */
  woken: string[];
  /** Child agent runs started again (trigger `resume`). */
  resumed: string[];
}

/**
 * Startup, after every module started (spec §3.10): a run cut off by the last stop gets one
 * `resume` inbox item (per run id). With `settings.autoResume`:
 * - a supervisor is woken as usual (its wake says the last run was interrupted);
 * - a child agent (not a worker of the older preset, which resumes by task.retry) gets a new
 *   run in the same session and workspace (trigger `resume`; the runtime resumes its own
 *   conversation). Only once: a run that was itself such a resume is not resumed again, so a
 *   restart loop does not keep spending.
 * Ordinary chats are not resumed (their partial answer stays).
 */
export function resumeAfterRestart(ctx: DaemonContext): RestartReport {
  const report: RestartReport = { woken: [], resumed: [] };
  if (!ctx.settings.get().autoResume) return report;
  const inbox = ctx.service('supervisorInbox');
  const stale = ctx.repos.runs.find({ where: { status: 'interrupted' }, direction: 'asc' });
  for (const run of stale) {
    if (!DAEMON_REASONS.includes(run.statusReason ?? '')) continue;
    const latest = ctx.repos.runs.findOne({ where: { session_id: run.sessionId } });
    if (latest?.id !== run.id) continue;
    const session = ctx.repos.sessions.get(run.sessionId);
    if (!session || session.archivedAt || resumeRecorded(ctx, session.id, run.id)) continue;
    try {
      if (run.kind === 'orchestrator' && isSupervisor(ctx, session.id)) {
        inbox.deliver(session.id, {
          kind: 'resume',
          refs: { runId: run.id },
          actor: RESUME_SYSTEM,
        });
        report.woken.push(session.id);
      } else if (run.kind === 'agent' && isResumableChild(ctx, session)) {
        if (run.trigger === 'resume') continue;
        report.resumed.push(resumeChild(ctx, session, run).id);
      }
    } catch (err) {
      ctx.log.error('failed to resume after a restart', { runId: run.id, err });
    }
  }
  return report;
}

/** A child agent of a supervisor or a person, not stopped. */
function isResumableChild(ctx: DaemonContext, session: Session): boolean {
  if (session.kind !== 'agent' || !session.parentSessionId) return false;
  if (session.supervision === 'paused') return false;
  return !isLegacyOrchestrator(ctx, session.parentSessionId);
}

function resumeRecorded(ctx: DaemonContext, sessionId: string, runId: string): boolean {
  return (
    ctx.repos.inboxItems.count({
      where: { session_id: sessionId, kind: 'resume' },
      sql: { clause: "json_extract(data, '$.refs.runId') = ?", params: [runId] },
    }) > 0
  );
}

function resumeChild(ctx: DaemonContext, session: Session, interrupted: Run): Run {
  return ctx.db.transaction(() => {
    const message = ctx.service('sessions').appendMessage({
      sessionId: session.id,
      role: 'user',
      content: [{ type: 'text', text: RESTART_RESUME_TEXT }],
      author: RESUME_SYSTEM,
    });
    const budget = interrupted.budgetId ? ctx.repos.budgets.get(interrupted.budgetId) : undefined;
    const next = ctx.service('runs').start({
      sessionId: session.id,
      kind: 'agent',
      createdBy: RESUME_SYSTEM,
      trigger: 'resume',
      triggerMessageId: message.id,
      taskId: interrupted.taskId,
      projectId: interrupted.projectId,
      workspaceId: interrupted.workspaceId ?? session.workspaceId,
      model: interrupted.model,
      runtime: interrupted.runtime,
      retryOfRunId: interrupted.id,
      budgetId: budget?.status === 'active' ? budget.id : sessionBudgetId(ctx, session.id),
    });
    ctx
      .service('supervisorInbox')
      .record(session.id, 'resume', { runId: interrupted.id }, RESUME_SYSTEM, next.id);
    const task = interrupted.taskId
      ? ctx.repos.tasks.get(interrupted.taskId)
      : ctx.repos.tasks.findOne({ where: { assignee_session_id: session.id, status: 'ready' } });
    if (task && task.assigneeSessionId === session.id && task.status === 'ready') {
      ctx.service('tasks').setStatus(task.id, 'running', RESUME_SYSTEM, null);
    }
    return next;
  });
}
