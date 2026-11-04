import type { ContentPart } from '@acc/protocol';
import { defineMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';
import { conflict, invalidParams } from '../../core/errors';
import { assertRosterModel } from '../../llm/roster';
import { ACTIVE_RUN_STATUSES } from '../../runs/manager';
import { forwardedParts } from '../forward';
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
    // Passing on an answer reads that conversation: it must be in the caller's reach too.
    scope: (p) => {
      const scope = sessionScope(ctx, p.sessionId);
      return p.forward
        ? { ...scope, sessionIds: [...new Set([...(scope.sessionIds ?? []), ...p.forward])] }
        : scope;
    },
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
        if (p.model) {
          assertRosterModel(ctx, call.actor, p.model, {
            agentRuntime: session.kind === 'agent' && session.runtime !== 'mock',
          });
        }
        const own: ContentPart[] =
          typeof p.content === 'string' ? [{ type: 'text', text: p.content }] : p.content;
        if (own.some((c) => c.type === 'tool_result' || c.type === 'tool_call')) {
          throw invalidParams('User messages may only contain text parts');
        }
        if (p.forward?.length && (p.hint || p.workModel || p.workPlace)) {
          throw invalidParams('forward は hint・workModel・workPlace と一緒には使えません');
        }
        const forwarded = p.forward?.length ? forwardedParts(ctx, p.forward) : null;
        const content: ContentPart[] = forwarded ? [...forwarded.parts, ...own] : own;
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
          ...(forwarded ? { meta: { kind: 'forward', items: forwarded.items } } : {}),
          ...(p.hint || p.workModel || p.workPlace
            ? {
                meta: {
                  kind: 'hint',
                  text: p.hint ?? '',
                  ...(p.workModel ? { model: p.workModel } : {}),
                  ...(p.workPlace ? { place: p.workPlace } : {}),
                },
              }
            : {}),
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
