import type { DaemonContext } from '../core/context';
import { buildHomeSnapshot } from '../home/home';

/** Heading of the status block in the system prompt of the assistant (the mock reads it too). */
export const STATUS_HEADING = 'いまの状況';
/** Heading of the project list in the system prompt of the assistant. */
export const PROJECTS_HEADING = 'プロジェクト';
/** Marker before the workspace the human chose for the request (`session.send` hint). */
export const HINT_LABEL = '作業場所の希望:';

/**
 * System prompt of the assistant (right-hand spec §1): beside the human, over every tree.
 * Tool descriptions come from the Control API contract; the status block is appended per
 * run (`statusBlock`), so "今どう？" is one model call.
 */
export function buildAssistantPrompt(input: { maxTrees: number }): string {
  return [
    'You are the assistant at the side of the person using AI Agent Command Center. You see every conversation tree (the status below) and act through the Control API tools; you do not do the work yourself.',
    '',
    'What to do with what they say',
    '- New work: assistant.startWork with their words as `text`, unchanged. Leave `delegate` true (the conversation leads a team) unless it is one small piece or one conversation they want. Give a short `title`. Then answer in one sentence: 「「<title>」を始めます。終わったら知らせます。」 — do not say how many people; the conversation decides.',
    '- A question about how things stand: answer from the status below in one or two lines (what waits for them, progress per tree, failures). The status already lists every tree, its children and the open items; do not call home.get or session.tree for that.',
    '- 「止めて」 / 「再開して」 naming a tree: session.stop / session.resume with `tree: true` on that root, then confirm in one line.',
    '- Something to repeat (毎朝, 毎週 …): assistant.startWork with `delegate: false` and a short title, then schedule.create on that conversation (cron in the local time zone). Answer with the rhythm and the first run.',
    '- A plain question that needs no agent: answer it yourself, briefly.',
    '- A note for a running tree (「FAQ は 5 問でいい」): session.send to that root.',
    '',
    'Rules (the daemon enforces them; do not work around them)',
    `- At most ${input.maxTrees} new conversations per message of theirs. For more, ask them to split it.`,
    '- Never start work that is already running: check the status first.',
    '- You cannot answer what waits for the person (approvals, questions). Say where it is.',
    `- When their message carries a line starting with "${HINT_LABEL}", pass that project / workspace to assistant.startWork.`,
    '',
    'How to write: Japanese, one or two short sentences, no preamble, no emoji, no exclamation marks. Name conversations by their title in 「」.',
  ].join('\n');
}

/** Children listed under a tree in the status block (the rest is a count). */
const STATUS_CHILDREN_MAX = 12;

/**
 * The status for the system prompt: one line per tree (id, title, state, progress, what
 * waits), its children indented under it (title, state, what it does), and the open items
 * (questions, approvals, failures) with their titles, so "今どう？" needs no tool call. The
 * mock parses the tree lines (`TREE_LINE` in mockRightHand.ts); keep their shape.
 */
export function statusBlock(ctx: DaemonContext): string {
  const snap = buildHomeSnapshot(ctx, { doneWithinHours: 12, maxNodesPerTree: 200 });
  const lines = [
    `${STATUS_HEADING}（出番 ${snap.totals.needsYou} 件・作業中 ${snap.totals.working}・失敗 ${snap.totals.failed}）`,
  ];
  const attentionById = new Map(snap.attention.map((a) => [a.id, a]));
  for (const t of snap.trees) {
    const children = t.nodes.filter((n) => n.depth === 1);
    const finished = t.counts.done + t.counts.review;
    const parts = [`- [${t.root.id}] 「${t.root.title || '無題'}」 state=${t.root.state}`];
    if (children.length > 0) parts.push(`progress=${finished}/${children.length}`);
    if (t.counts.needsYou > 0) parts.push(`needsYou=${t.counts.needsYou}`);
    if (t.counts.failed > 0) parts.push(`failed=${t.counts.failed}`);
    if (t.nextRunAt) parts.push(`nextRun=${t.nextRunAt}`);
    lines.push(parts.join(' '));
    for (const c of [t.root, ...children.slice(0, STATUS_CHILDREN_MAX)]) {
      if (c.id !== t.root.id) {
        lines.push(
          `    - 「${c.title || '無題'}」 state=${c.state}${c.now ? ` now=${c.now}` : ''}`,
        );
      }
      for (const id of c.attentionIds) {
        const a = attentionById.get(id);
        if (a)
          lines.push(
            `      ${a.kind === 'question' ? '質問' : a.kind === 'approval' ? '承認' : '出番'}: 「${a.title}」`,
          );
      }
    }
    if (children.length > STATUS_CHILDREN_MAX) {
      lines.push(`    - ほか ${children.length - STATUS_CHILDREN_MAX} 人`);
    }
  }
  if (snap.trees.length === 0) lines.push('- （会話はまだありません）');
  const projects = ctx.repos.projects.find({ where: { archived_at: null }, direction: 'asc' });
  if (projects.length > 0) {
    lines.push('', PROJECTS_HEADING);
    for (const p of projects) {
      const place = p.repoPath ? 'code' : p.folderPath ? 'folder' : 'none';
      lines.push(`- [${p.id}] ${p.name} (${place})`);
    }
  }
  return lines.join('\n');
}
