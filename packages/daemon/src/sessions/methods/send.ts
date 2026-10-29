import type { ContentPart } from '@acc/protocol';
import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';
import { conflict, invalidParams } from '../../core/errors';
import { ACTIVE_RUN_STATUSES } from '../../runs/manager';
import { sessionScope } from './shared';

/**
 * session.send: store the user message and hand it to the inbox (spec 20261029 §3.2, D9).
 * Never refused for being busy: an idle session starts a run (`started`), a busy chat or
 * supervisor takes it at its next step (`injected`), a busy agent after its current run
 * (`queued`) — or right away with `interrupt` (its current run ends as `superseded`).
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
        const active = repos.runs.findOne({
          where: { session_id: session.id, status: [...ACTIVE_RUN_STATUSES] },
        });
        const handsOverNow = !active || (p.interrupt === true && active.kind === 'agent');
        const message = ctx.service('sessions').appendMessage({
          sessionId: session.id,
          role: 'user',
          content,
          author: call.actor,
          delivery: handsOverNow ? 'delivered' : 'queued',
        });
        const r = ctx.service('inbox').deliver(session.id, {
          kind: 'user_message',
          refs: { messageId: message.id },
          actor: call.actor,
          ...(p.interrupt ? { interrupt: true } : {}),
          ...(p.model ? { model: p.model } : {}),
        });
        return { messageId: message.id, runId: r.runId, delivery: r.delivery };
      });
    },
  });
}
