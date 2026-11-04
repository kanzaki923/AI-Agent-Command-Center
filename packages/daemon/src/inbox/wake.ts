import type { Artifact, InboxItem, Session, SessionState, WakeItemView } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { deriveSessionState, readStateFacts } from '../home/state';
import { textOfParts } from '../llm/messages';
import { latestAnswer } from '../sessions/forward';
import { framedTitle, quote } from '../sessions/framing';

/**
 * First line of the message that wakes a supervisor (stored as a system message with
 * `meta.wake`; sent to the model as a user turn so providers keep it in order). The mock
 * supervisor recognizes it too.
 */
export const WAKE_MARKER = '[状況の更新]';

/** Put before a message handed to a busy run at a step boundary (spec 20261029 R3). */
export const INJECTED_PREFIX = '（作業中に届いた発言）';

/** Child states that wake the parent (spec 20261029 §3.2). `stopped` is reported by session.stop. */
export const CHILD_UPDATE_STATES: readonly SessionState[] = [
  'done',
  'failed',
  'review',
  'needs_you',
];

type Change = WakeItemView['change'];

const CHANGE_JA: Record<Change, string> = {
  done: '完了',
  failed: '失敗',
  review: '確認待ち',
  needs_you: '人の判断を待っています',
  stopped: '停止中',
  answer: '回答が届きました',
  budget: '予算の上限に近づきました',
  resume: '再開',
};

/** Current derived state of a session (independent of whether `Session.state` is kept current). */
export function currentState(ctx: DaemonContext, session: Session): SessionState {
  return deriveSessionState(readStateFacts(ctx, session));
}

/** Latest output artifacts of a session (newest first). */
function outputsOf(ctx: DaemonContext, sessionId: string, limit = 3): Artifact[] {
  return ctx.repos.artifacts
    .find({ where: { session_id: sessionId }, direction: 'desc', limit: 20 })
    .filter((a) => a.role === 'output')
    .slice(0, limit);
}

/** Longest speaker's turn put in a wake message as it is (a turn is far shorter). */
export const MAX_REPLY_CHARS = 4000;

/**
 * What a speaker (a child with a persona) said in its latest run, or null for any other child
 * (their results are outputs) and when that run left no words (it failed or was stopped).
 */
export function speakerReply(
  ctx: DaemonContext,
  child: Session,
): { text: string; cut: boolean } | null {
  if (!child.persona) return null;
  const run = ctx.repos.runs.findOne({ where: { session_id: child.id } });
  const answer = latestAnswer(ctx, child.id);
  if (!run || !answer || answer.runId !== run.id) return null;
  const full = textOfParts(answer.content).trim();
  return full.length > MAX_REPLY_CHARS
    ? { text: `${full.slice(0, MAX_REPLY_CHARS - 1)}…`, cut: true }
    : { text: full, cut: false };
}

export interface WakeEntry {
  view: WakeItemView;
  /** LLM-facing line(s). */
  text: string;
}

/**
 * One entry of a wake message per item, or null when the item went stale (e.g. the child is
 * working again). Child updates read the child's state now, not when the item was stored.
 */
export function wakeEntry(ctx: DaemonContext, owner: Session, item: InboxItem): WakeEntry | null {
  const { repos } = ctx;
  if (item.kind === 'child_update') {
    const child = item.refs.childSessionId ? repos.sessions.get(item.refs.childSessionId) : null;
    if (!child) return null;
    const state = currentState(ctx, child);
    if (!CHILD_UPDATE_STATES.includes(state) && state !== 'stopped') return null;
    const change = state as Change;
    const outputs = outputsOf(ctx, child.id);
    const reply = change === 'done' ? speakerReply(ctx, child) : null;
    const lines = [
      `- 「${child.title || '無題'}」（${child.id}）: ${reply ? '発言' : CHANGE_JA[change]}`,
    ];
    if (reply) {
      // The words themselves, so the supervisor needs no tool call to read them.
      lines.push(quote(reply.text, `「${framedTitle(child.title)}」の発言`));
    }
    if (outputs.length > 0) {
      lines.push(
        `  成果物: ${outputs.map((a) => `「${a.title}」（${a.id}, ${a.kind}）`).join('、')}`,
      );
    }
    if (change === 'needs_you') {
      for (const a of repos.attention.find({
        where: { session_id: child.id, status: 'open' },
        direction: 'asc',
      })) {
        const choices = a.choices.map((c) => `${c.label}（${c.id}）`).join(' / ');
        lines.push(
          `  ${a.kind === 'question' ? '質問' : '出番'}: 「${a.title}」（${a.id}）${choices ? ` 選択肢: ${choices}` : ''}`,
        );
      }
    }
    if (change === 'failed') {
      const run = repos.runs.findOne({ where: { session_id: child.id } });
      if (run?.error) lines.push(`  理由: ${oneLine(run.error.message)}`);
    }
    return {
      view: {
        sessionId: child.id,
        title: child.title,
        change,
        artifactIds: outputs.map((a) => a.id),
        reply,
      },
      text: lines.join('\n'),
    };
  }
  if (item.kind === 'resume') {
    const run = item.refs.runId ? repos.runs.get(item.refs.runId) : undefined;
    const why =
      run?.status === 'failed'
        ? `前回の実行は一時的なエラーで止まりました（${run.error ? oneLine(run.error.message) : run.id}）。もう一度続きから進めてください。`
        : `前回の実行はデーモンの再起動で中断されました${run ? `（${run.id}）` : ''}。会話の木の状態を確かめて、続きから進めてください。`;
    return {
      view: { sessionId: owner.id, title: owner.title, change: 'resume', artifactIds: [] },
      text: `- ${why}`,
    };
  }
  if (item.kind === 'budget') {
    const subject = item.refs.childSessionId
      ? (repos.sessions.get(item.refs.childSessionId) ?? owner)
      : owner;
    return {
      view: { sessionId: subject.id, title: subject.title, change: 'budget', artifactIds: [] },
      text: `- 「${subject.title || '無題'}」（${subject.id}）: ${CHANGE_JA.budget}`,
    };
  }
  // An answer without a message of its own (answers normally arrive as messages).
  const asker = item.refs.childSessionId
    ? (repos.sessions.get(item.refs.childSessionId) ?? owner)
    : owner;
  return {
    view: { sessionId: asker.id, title: asker.title, change: 'answer', artifactIds: [] },
    text: `- 「${asker.title || '無題'}」（${asker.id}）: ${CHANGE_JA.answer}`,
  };
}

/** Entries for one wake: one per child (the latest item wins), stale ones left out. */
export function wakeEntries(ctx: DaemonContext, owner: Session, items: InboxItem[]): WakeEntry[] {
  const latest = new Map<string, InboxItem>();
  for (const item of items) {
    const key =
      item.kind === 'child_update' ? `child:${item.refs.childSessionId ?? item.id}` : item.id;
    latest.set(key, item);
  }
  return [...latest.values()]
    .map((item) => wakeEntry(ctx, owner, item))
    .filter((e): e is WakeEntry => e !== null);
}

export function wakeText(entries: WakeEntry[]): string {
  return [WAKE_MARKER, ...entries.map((e) => e.text)].join('\n');
}

function oneLine(s: string, max = 200): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
