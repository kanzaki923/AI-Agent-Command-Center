import type { ContentPart } from '@acc/protocol';
import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';
import { conflict, invalidParams } from '../../core/errors';
import { resolveChatModel } from '../chat';
import { sessionBudgetId, sessionScope } from './shared';

/**
 * session.send: append the user message and start a run. T1 turns this into
 * `inbox.deliver` (never refused while busy: injected at the next step or queued).
 */
export function sessionSend(ctx: DaemonContext) {
  const { repos, db } = ctx;
  return defineMethod('session.send', {
    scope: (p) => sessionScope(ctx, p.sessionId),
    handler: (p, call) => {
      // Outside the transaction, so a refusal stays on the audit trail (policy.denied).
      if (ctx.hasService('policy')) {
        ctx
          .service('policy')
          .assertAgentMayStartRun(call.actor, repos.sessions.require(p.sessionId), 'session.send');
      }
      return db.transaction(() => {
        const session = repos.sessions.require(p.sessionId);
        if (session.archivedAt) {
          throw conflict('アーカイブ済みのセッションには送信できません');
        }
        const content: ContentPart[] =
          typeof p.content === 'string' ? [{ type: 'text', text: p.content }] : p.content;
        if (content.some((c) => c.type === 'tool_result' || c.type === 'tool_call')) {
          throw invalidParams('User messages may only contain text parts');
        }
        // A chat whose grants allow starting workers runs as an orchestrator (concept §3.1:
        // orchestration is a role given by capabilities, not a session type).
        const kind =
          session.kind === 'agent'
            ? 'agent'
            : ctx.hasService('policy') &&
                ctx.service('policy').sessionAllows(session.id, 'task.spawnWorker')
              ? 'orchestrator'
              : 'chat';
        const message = ctx.service('sessions').appendMessage({
          sessionId: session.id,
          role: 'user',
          content,
          author: call.actor,
        });
        // Rolls back the message too if the session is busy (conflict).
        const run = ctx.service('runs').start({
          sessionId: session.id,
          kind,
          createdBy: call.actor,
          triggerMessageId: message.id,
          trigger: 'user',
          model:
            kind === 'agent'
              ? (p.model ?? session.model)
              : resolveChatModel(ctx, session.model, p.model),
          runtime: session.runtime,
          workspaceId: kind === 'agent' ? session.workspaceId : null,
          budgetId: sessionBudgetId(ctx, session.id),
        });
        return { messageId: message.id, runId: run.id, delivery: 'started' as const };
      });
    },
  });
}
