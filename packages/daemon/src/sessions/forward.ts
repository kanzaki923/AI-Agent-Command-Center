import type { ForwardedView, Message, TextPart } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { invalidParams } from '../core/errors';
import { textOfParts } from '../llm/messages';
import { framedTitle, quote } from './framing';

/** Longest answer passed on as it is (a speaker's turn is far shorter). */
export const MAX_FORWARDED_CHARS = 8000;

/** The latest finished answer of a conversation (assistant text), if it has one. */
export function latestAnswer(ctx: DaemonContext, sessionId: string): Message | undefined {
  return ctx.repos.messages
    .find({
      where: { session_id: sessionId },
      sql: { clause: "json_extract(data, '$.role') = 'assistant'" },
      direction: 'desc',
      limit: 20,
    })
    .find((m) => textOfParts(m.content).trim() !== '');
}

/**
 * `session.send` `forward`: the latest answer of each conversation as a quoted text part with
 * its name (`<<<「名前」の発言ここから>>>` …), so a supervisor passes on what a speaker said
 * without writing it again (output tokens) or retelling it (drift). The quote markers cannot be
 * faked from inside, and the whole message is still labeled as the sender's.
 */
export function forwardedParts(
  ctx: DaemonContext,
  ids: readonly string[],
): { parts: TextPart[]; items: ForwardedView[] } {
  const parts: TextPart[] = [];
  const items: ForwardedView[] = [];
  for (const id of [...new Set(ids)]) {
    const session = ctx.repos.sessions.require(id);
    const answer = latestAnswer(ctx, id);
    if (!answer) {
      throw invalidParams(`「${framedTitle(session.title)}」にはまだ渡せる発言がありません`, {
        sessionId: id,
      });
    }
    const full = textOfParts(answer.content).trim();
    const text =
      full.length > MAX_FORWARDED_CHARS
        ? `${full.slice(0, MAX_FORWARDED_CHARS - 1)}…（長いため途中まで）`
        : full;
    parts.push({ type: 'text', text: quote(text, `「${framedTitle(session.title)}」の発言`) });
    items.push({ sessionId: id, title: session.title });
  }
  return { parts, items };
}
