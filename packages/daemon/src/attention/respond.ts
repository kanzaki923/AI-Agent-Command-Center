import type { Actor, Attention, AttentionChoice } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { conflict, forbidden, invalidParams } from '../core/errors';
import { deliverAnswer } from './answer';
import type { AttentionManager } from './service';

export interface RespondInput {
  choiceId?: string | null;
  text?: string | null;
}

/** `add_1` → 1, `add_2.5` → 2.5 (the budget choices). */
const ADD_CHOICE = /^add_(\d+(?:\.\d+)?)$/;

/**
 * Act on an attention item (`attention.respond`, spec 20261029 §3.6). Humans answer every
 * kind; an agent (a supervisor) only questions asked further down its own tree. The choice
 * is routed to the method that removes the cause, called as the responder (so its own
 * rules apply), and the item is then resolved:
 *
 * | kind     | choice           | routed to                                                   |
 * |----------|------------------|-------------------------------------------------------------|
 * | question | any / text       | an answer message to the asking session (answer.ts)         |
 * | approval | approve / reject | approval.respond                                            |
 * | failure  | retry            | task.retry (the item's task) or run.retry (its run)         |
 * | review   | accept           | integration.approve (an integration) or artifact.review     |
 * | review   | redo / text      | artifact.review redo, else task.retry, else integration.reject |
 * | budget   | add_N            | budget.raise (+$N)                                          |
 * | stuck    | continue         | session.resume                                              |
 * | *        | stop             | session.stop                                                |
 * | *        | text only        | session.send (an instruction to the session)                |
 *
 * A routed call that fails leaves the item open (nothing happened).
 */
export async function respondToAttention(
  ctx: DaemonContext,
  manager: AttentionManager,
  attentionId: string,
  input: RespondInput,
  actor: Actor,
): Promise<Attention> {
  const att = ctx.repos.attention.require(attentionId);
  if (att.status !== 'open') {
    throw conflict('この出番はすでに対応済みです', { status: att.status });
  }
  if (actor.kind === 'agent') {
    // A supervisor answers its children's questions; decisions on tools, money and code
    // stay with humans (the tree scope itself is checked by the dispatcher).
    if (att.kind !== 'question') {
      throw forbidden('エージェントが答えられるのは、自分が任せた会話からの質問だけです');
    }
    if (att.sessionId === actor.sessionId) {
      throw forbidden('自分の質問には答えられません');
    }
  }
  const choice = input.choiceId ? att.choices.find((c) => c.id === input.choiceId) : undefined;
  if (input.choiceId && !choice) {
    throw invalidParams(`この出番に選択肢「${input.choiceId}」はありません`, {
      choices: att.choices.map((c) => c.id),
    });
  }
  const text = input.text?.trim() ? input.text.trim() : null;
  if (text && !att.allowText) throw invalidParams('この出番には文章では答えられません');
  if (!choice && !text) throw invalidParams('選択肢か文章のどちらかで答えてください');

  const resolution = { choiceId: choice?.id ?? null, text, by: actor };
  if (att.kind === 'question') {
    return deliverAnswer(ctx, manager, att, { choice: choice ?? null, text }, actor);
  }
  await route(ctx, att, choice ?? null, text, actor);
  // The cause usually went away already (sync.ts saw the event); otherwise close it here.
  const cur = ctx.repos.attention.require(att.id);
  return cur.status === 'open' ? manager.close(att.id, 'resolved', resolution) : cur;
}

async function route(
  ctx: DaemonContext,
  att: Attention,
  choice: AttentionChoice | null,
  text: string | null,
  actor: Actor,
): Promise<void> {
  const { refs } = att;
  const sessionId = att.sessionId;
  const id = choice?.id ?? null;

  if (id === 'stop') {
    await ctx.call(actor, 'session.stop', {
      sessionId,
      ...(text ? { reason: text.slice(0, 1000) } : {}),
    });
    return;
  }
  if (id === null) {
    // A reply without a choice: review → redo with the note, otherwise an instruction.
    if (att.kind === 'review') return redo(ctx, att, text, actor);
    await ctx.call(actor, 'session.send', { sessionId, content: text ?? '' });
    return;
  }

  switch (att.kind) {
    case 'approval': {
      if (!refs.approvalId) throw conflict('この出番には答える承認がありません');
      if (id !== 'approve' && id !== 'reject') break;
      await ctx.call(actor, 'approval.respond', {
        approvalId: refs.approvalId,
        decision: id,
        ...(text ? { note: text } : {}),
      });
      return;
    }
    case 'failure': {
      if (id !== 'retry') break;
      if (refs.taskId) {
        await ctx.call(actor, 'task.retry', {
          taskId: refs.taskId,
          ...(text ? { feedback: text } : {}),
        });
      } else if (refs.runId) {
        await ctx.call(actor, 'run.retry', { runId: refs.runId });
      } else {
        throw conflict('再試行する作業が見つかりません');
      }
      return;
    }
    case 'review': {
      if (id === 'redo') return redo(ctx, att, text, actor);
      if (id !== 'accept') break;
      if (refs.integrationId) {
        await ctx.call(actor, 'integration.approve', {
          integrationId: refs.integrationId,
          ...(text ? { note: text } : {}),
        });
      } else if (refs.artifactId) {
        await ctx.call(actor, 'artifact.review', {
          artifactId: refs.artifactId,
          decision: 'accept',
          ...(text ? { note: text } : {}),
        });
      } else {
        throw conflict('採用する成果物が見つかりません');
      }
      return;
    }
    case 'budget': {
      const add = ADD_CHOICE.exec(id);
      if (!add) break;
      if (!refs.budgetId) throw conflict('この出番には増やせる予算がありません');
      await ctx.call(actor, 'budget.raise', { budgetId: refs.budgetId, addUsd: Number(add[1]) });
      return;
    }
    case 'stuck': {
      if (id !== 'continue') break;
      await ctx.call(actor, 'session.resume', {
        sessionId,
        ...(text ? { message: text } : {}),
      });
      return;
    }
    case 'question':
      break;
  }
  throw invalidParams(`選択肢「${id}」の扱いが決まっていません`);
}

/** Send the work back with a note: the output's review, else the task, else the integration. */
async function redo(
  ctx: DaemonContext,
  att: Attention,
  note: string | null,
  actor: Actor,
): Promise<void> {
  const { refs } = att;
  const withNote = note ? { note } : {};
  if (refs.artifactId) {
    await ctx.call(actor, 'artifact.review', {
      artifactId: refs.artifactId,
      decision: 'redo',
      ...withNote,
    });
  } else if (refs.taskId) {
    await ctx.call(actor, 'task.retry', {
      taskId: refs.taskId,
      ...(note ? { feedback: note } : {}),
    });
  } else if (refs.integrationId) {
    await ctx.call(actor, 'integration.reject', { integrationId: refs.integrationId, ...withNote });
  } else {
    throw conflict('やり直す作業が見つかりません');
  }
}
