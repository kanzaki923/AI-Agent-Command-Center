import type { Actor, Run, Session } from '@acc/protocol';
import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';
import { conflict } from '../../core/errors';
import { subtreeIds } from '../../home/tree';
import { runKindFor, setSupervision } from '../../inbox';
import { ACTIVE_RUN_STATUSES } from '../../runs/manager';
import { resolveChatModel } from '../chat';
import { sessionBudgetId, sessionScope } from './shared';
import { STOPPED_BY_USER } from './stop';

/** First message of a run that continues stopped work. */
export const RESUME_TEXT = '止めていた作業を、止めたところから再開してください。';

/**
 * session.resume (spec 20261029 §2.2): undo session.stop for a session and (by default) its
 * stopped descendants. Supervision becomes active again; work cut off by the stop restarts
 * in the same session (an agent's runtime resumes its own conversation, a chat answers
 * again) with trigger `resume`; paused tasks run again. A supervisor is not run right away:
 * it is woken by what gathered in its inbox, or by `message`.
 */
export function sessionResume(ctx: DaemonContext) {
  return defineMethod('session.resume', {
    scope: (p) => sessionScope(ctx, p.sessionId),
    handler: (p, call) => {
      const root = ctx.repos.sessions.require(p.sessionId);
      if (root.archivedAt) throw conflict('アーカイブ済みのセッションは再開できません');
      const ids = (p.tree ? subtreeIds(ctx, root.id) : [root.id]).filter((id) =>
        isStopped(ctx, ctx.repos.sessions.require(id)),
      );
      // Agents may only restart sessions the policy lets them start runs in (checked before
      // anything changes, outside the transaction so a refusal stays on the audit trail).
      if (ctx.hasService('policy')) {
        for (const id of ids) {
          const s = ctx.repos.sessions.require(id);
          if (needsRun(ctx, s)) {
            ctx.service('policy').assertAgentMayStartRun(call.actor, s, 'session.resume');
          }
        }
      }
      return ctx.db.transaction(() => {
        const runIds: string[] = [];
        for (const id of ids) {
          const run = resumeOne(ctx, id, call.actor);
          if (run) runIds.push(run.id);
        }
        if (p.message) {
          const r = sendResumeMessage(ctx, root, p.message, call.actor);
          if (r && !runIds.includes(r)) runIds.push(r);
        }
        return { resumedSessionIds: ids, runIds };
      });
    },
  });
}

/** Stopped by session.stop (or paused by the wake limit / a runaway stop). */
function isStopped(ctx: DaemonContext, s: Session): boolean {
  if (s.supervision === 'paused') return true;
  return ctx.repos.tasks.count({ where: { assignee_session_id: s.id, status: 'paused' } }) > 0;
}

/** The latest run was cut off by a stop and nothing runs now: resuming starts a run. */
function needsRun(ctx: DaemonContext, s: Session): boolean {
  if (runKindFor(ctx, s) === 'orchestrator') return false;
  const last = ctx.repos.runs.findOne({ where: { session_id: s.id } });
  if (!last || (ACTIVE_RUN_STATUSES as readonly string[]).includes(last.status)) return false;
  const pausedTask =
    ctx.repos.tasks.count({ where: { assignee_session_id: s.id, status: 'paused' } }) > 0;
  return (last.status === 'cancelled' && last.statusReason === STOPPED_BY_USER) || pausedTask;
}

function resumeOne(ctx: DaemonContext, sessionId: string, actor: Actor): Run | null {
  const { repos } = ctx;
  const inbox = ctx.service('supervisorInbox');
  const session = repos.sessions.require(sessionId);
  const restart = needsRun(ctx, session);
  setSupervision(ctx, session.id, 'active', actor);
  inbox.forgetReported(session.id);
  for (const task of repos.tasks.find({
    where: { assignee_session_id: session.id, status: 'paused' },
  })) {
    ctx.service('tasks').setStatus(task.id, restart ? 'running' : 'ready', actor, null);
  }
  if (!restart) {
    inbox.poke(session.id);
    return null;
  }
  const kind = runKindFor(ctx, session);
  const message = ctx.service('sessions').appendMessage({
    sessionId: session.id,
    role: 'user',
    content: [{ type: 'text', text: RESUME_TEXT }],
    author: actor,
  });
  const last = repos.runs.findOne({ where: { session_id: session.id } });
  return ctx.service('runs').start({
    sessionId: session.id,
    kind,
    createdBy: actor,
    triggerMessageId: message.id,
    trigger: 'resume',
    taskId: last?.taskId ?? null,
    projectId: last?.projectId ?? session.projectId,
    workspaceId: kind === 'agent' ? (last?.workspaceId ?? session.workspaceId) : null,
    model: kind === 'agent' ? (last?.model ?? session.model) : resolveChatModel(ctx, session.model),
    runtime: last?.runtime ?? session.runtime,
    budgetId: activeBudget(ctx, last?.budgetId ?? null) ?? sessionBudgetId(ctx, session.id),
  });
}

function activeBudget(ctx: DaemonContext, budgetId: string | null): string | null {
  if (!budgetId) return null;
  return ctx.repos.budgets.get(budgetId)?.status === 'active' ? budgetId : null;
}

/** `message`: delivered to the resumed session like any message (it starts or waits). */
function sendResumeMessage(
  ctx: DaemonContext,
  session: Session,
  text: string,
  actor: Actor,
): string | null {
  const busy = ctx.repos.runs.findOne({
    where: { session_id: session.id, status: [...ACTIVE_RUN_STATUSES] },
  });
  const message = ctx.service('sessions').appendMessage({
    sessionId: session.id,
    role: 'user',
    content: [{ type: 'text', text }],
    author: actor,
    delivery: busy ? 'queued' : 'delivered',
  });
  return ctx.service('inbox').deliver(session.id, {
    kind: 'user_message',
    refs: { messageId: message.id },
    actor,
  }).runId;
}
