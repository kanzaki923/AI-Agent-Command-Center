import type { Actor, Attention, AttentionChoice, Message, RunKind, Session } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { conflict } from '../core/errors';
import { ACTIVE_RUN_STATUSES } from '../runs/manager';
import { resolveChatModel, sessionBudgetId } from '../sessions';
import type { AttentionManager } from './service';

/** The message body the asking session reads (LLM-facing; the UI renders `meta.answer`). */
export function answerText(choice: AttentionChoice | null, text: string | null): string {
  return `回答: ${[choice?.label, text].filter(Boolean).join('\n')}`;
}

/**
 * Answer a question (spec 20261029 §3.6): resolve it and hand the answer to the session
 * that asked, as a user message (`meta.answer`) delivered through its inbox — a new run
 * when it is idle (an agent resumes its runtime session), the running one's next step or
 * after it otherwise. Both happen in one transaction: an answer is never half-given.
 */
export function deliverAnswer(
  ctx: DaemonContext,
  manager: AttentionManager,
  att: Attention,
  answer: { choice: AttentionChoice | null; text: string | null },
  actor: Actor,
): Attention {
  // Assigned inside the transaction callback (TS cannot see that).
  let after = null as { runId: string; messageId: string } | null;
  const resolved = ctx.db.transaction(() => {
    const session = ctx.repos.sessions.require(att.sessionId);
    if (session.archivedAt) {
      throw conflict('アーカイブ済みの会話には回答を届けられません');
    }
    const resolved = manager.close(att.id, 'resolved', {
      choiceId: answer.choice?.id ?? null,
      text: answer.text,
      by: actor,
    });
    const busy = activeRunId(ctx, session.id);
    const message = ctx.service('sessions').appendMessage({
      sessionId: session.id,
      role: 'user',
      content: [{ type: 'text', text: answerText(answer.choice, answer.text) }],
      author: actor,
      delivery: busy ? 'queued' : 'delivered',
      meta: { kind: 'answer', attentionId: att.id, choiceLabel: answer.choice?.label ?? null },
    });
    const r = ctx.service('inbox').deliver(session.id, {
      kind: 'answer',
      refs: { messageId: message.id, attentionId: att.id },
      actor,
    });
    if (r.item || r.runId) return resolved;
    // The inbox did not take it (the Supervisor track's inbox is not in yet): start the
    // run here, or once the running one ends.
    if (busy) after = { runId: busy, messageId: message.id };
    else startAnswerRun(ctx, session, message, actor);
    return resolved;
  });
  if (after) startAfterRun(ctx, after.runId, after.messageId, actor);
  return resolved;
}

function activeRunId(ctx: DaemonContext, sessionId: string): string | null {
  return (
    ctx.repos.runs.findOne({
      where: { session_id: sessionId, status: [...ACTIVE_RUN_STATUSES] },
    })?.id ?? null
  );
}

/**
 * Start the run that takes the answer, like `session.send` does (kind from the session and
 * its grants). A run that cannot start (e.g. its budget was returned) leaves the answer in
 * the conversation, where the next run reads it.
 */
function startAnswerRun(
  ctx: DaemonContext,
  session: Session,
  message: Message,
  actor: Actor,
): void {
  const kind: RunKind =
    session.kind === 'agent'
      ? 'agent'
      : ctx.hasService('policy') &&
          ctx.service('policy').sessionAllows(session.id, 'task.spawnWorker')
        ? 'orchestrator'
        : 'chat';
  try {
    ctx.db.transaction(() =>
      ctx.service('runs').start({
        sessionId: session.id,
        kind,
        createdBy: actor,
        triggerMessageId: message.id,
        trigger: actor.kind === 'human' ? 'user' : 'wake',
        model: kind === 'agent' ? session.model : resolveChatModel(ctx, session.model),
        runtime: session.runtime,
        workspaceId: kind === 'agent' ? session.workspaceId : null,
        budgetId: sessionBudgetId(ctx, session.id),
      }),
    );
  } catch (err) {
    ctx.log.warn('could not start a run for an answer', {
      sessionId: session.id,
      error: (err as Error).message,
    });
  }
}

/** Hand a queued answer over when the session's running run ends. */
function startAfterRun(ctx: DaemonContext, runId: string, messageId: string, actor: Actor): void {
  ctx
    .service('runs')
    .waitForEnd(runId)
    .then(() => {
      const message = ctx.repos.messages.get(messageId);
      if (!message || message.delivery !== 'queued') return;
      const busy = activeRunId(ctx, message.sessionId);
      if (busy) return startAfterRun(ctx, busy, messageId, actor);
      ctx.db.transaction(() => {
        const session = ctx.repos.sessions.require(message.sessionId);
        if (session.archivedAt) return;
        const delivered = ctx.repos.messages.update(messageId, (m) => ({
          ...m,
          delivery: 'delivered',
        }));
        ctx.bus.emit({
          type: 'message.updated',
          actor,
          payload: { message: delivered, changes: ['delivery'] },
        });
        startAnswerRun(ctx, session, delivered, actor);
      });
    })
    .catch(() => {
      // Shutdown (the DB is closed), or the run vanished: the answer stays in the
      // conversation as queued, where the next run reads it.
    });
}
