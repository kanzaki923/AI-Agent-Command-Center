import type { AttentionChoice } from '@acc/protocol';
import { type AnyMethodImpl, defineMethod } from '../api/registry';
import type { DaemonContext } from '../core/context';
import { conflict, forbidden, invalidParams } from '../core/errors';
import { subtreeIds } from '../home/tree';
import type { AttentionManager } from './service';
import { MAX_ATTENTION_TITLE, oneLine } from './text';

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** Scope of a call on one session: its project and the session itself (agents: own tree). */
function sessionScope(ctx: DaemonContext, sessionId: string | undefined) {
  if (!sessionId) return { projectIds: [] };
  const s = ctx.repos.sessions.get(sessionId);
  return { projectIds: s?.projectId ? [s.projectId] : [], sessionIds: [sessionId] };
}

/** human.ask / attention.list / attention.respond / attention.dismiss (spec 20261029 §2.2). */
export function attentionMethods(ctx: DaemonContext, manager: AttentionManager): AnyMethodImpl[] {
  const { repos } = ctx;
  return [
    defineMethod('human.ask', {
      // The asker's own session: agents need `human.ask` in a grant that covers it.
      scope: (_p, call) =>
        sessionScope(ctx, call.actor.kind === 'agent' ? call.actor.sessionId : undefined),
      handler: (p, call) => {
        const { actor } = call;
        if (actor.kind !== 'agent') {
          throw forbidden('human.ask はエージェントが人に質問するためのものです');
        }
        const choices: AttentionChoice[] = (p.choices ?? []).map((label, i) => ({
          id: `c${i + 1}`,
          label: label.trim(),
          tone: i === 0 ? 'primary' : 'neutral',
        }));
        if (choices.some((c) => !c.label)) throw invalidParams('空の選択肢があります');
        if (new Set(choices.map((c) => c.label)).size !== choices.length) {
          throw invalidParams('同じ選択肢が重複しています');
        }
        if (choices.length === 0 && !p.allowText) {
          throw invalidParams('選択肢がないときは文章での回答を受けてください（allowText）');
        }
        const question = p.question.replace(/\s+/g, ' ').trim();
        if (!question) throw invalidParams('質問が空です');
        // The title is one line; a longer question is kept whole in the detail.
        const cut = question.length > MAX_ATTENTION_TITLE;
        const detail = [cut ? question : null, p.detail?.trim() || null]
          .filter(Boolean)
          .join('\n\n');
        const attention = manager.open({
          kind: 'question',
          sessionId: actor.sessionId,
          title: oneLine(question),
          detail: detail || null,
          choices,
          allowText: p.allowText,
          refs: { askedBySessionId: actor.sessionId, runId: actor.runId },
          actor,
        });
        if (!attention) throw conflict('質問を出せる会話が見つかりません');
        return { attentionId: attention.id, status: 'asked' as const };
      },
    }),

    defineMethod('attention.list', {
      // Without a filter an agent lists its own tree (scoped as its own session).
      scope: (p, call) =>
        sessionScope(
          ctx,
          p.sessionId ??
            p.rootSessionId ??
            (call.actor.kind === 'agent' ? call.actor.sessionId : undefined),
        ),
      handler: (p, call) => {
        const where = {
          status: p.status ?? ['open'],
          session_id: p.sessionId,
          root_session_id: p.rootSessionId,
        };
        // An agent sees its own tree only (the scope checked the filters it named).
        const own =
          call.actor.kind === 'agent' && !p.sessionId && !p.rootSessionId
            ? subtreeIds(ctx, call.actor.sessionId)
            : null;
        return repos.attention.page({
          where,
          ...(own
            ? {
                sql: {
                  clause: own.length ? `session_id IN (${placeholders(own.length)})` : '0',
                  params: own,
                },
              }
            : {}),
          orderBy: 'priority',
          direction: 'asc',
          limit: p.limit,
          cursor: p.cursor,
        });
      },
    }),

    defineMethod('attention.respond', {
      scope: (p) => sessionScope(ctx, repos.attention.get(p.attentionId)?.sessionId),
      handler: (p, call) =>
        manager.respond(p.attentionId, { choiceId: p.choiceId, text: p.text }, call.actor),
    }),

    defineMethod('attention.dismiss', {
      scope: (p) => sessionScope(ctx, repos.attention.get(p.attentionId)?.sessionId),
      handler: (p, call) => {
        if (call.actor.kind !== 'human') {
          throw forbidden('出番を閉じられるのは人間だけです');
        }
        const att = repos.attention.require(p.attentionId);
        // A run waits on the approval: hiding it would leave the run stuck.
        if (att.kind === 'approval' && att.status === 'open') {
          throw conflict('承認は「許可」か「拒否」で答えてください');
        }
        return manager.close(att.id, 'dismissed', { by: call.actor });
      },
    }),
  ];
}
