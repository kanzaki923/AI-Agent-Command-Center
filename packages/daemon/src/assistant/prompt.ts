import { characterRoster, characterText } from '../characters/frame';
import type { DaemonContext } from '../core/context';
import { buildHomeSnapshot } from '../home/home';
import { WAKE_MARKER } from '../inbox/wake';
import { APP_NOTE_LABEL } from '../llm/messages';
import { quote } from '../sessions/framing';

/** Heading of the status block in the system prompt of the assistant (the mock reads it too). */
export const STATUS_HEADING = 'いまの状況';
/** Heading of the project list in the system prompt of the assistant. */
export const PROJECTS_HEADING = 'プロジェクト';
/** Marker before the workspace the human chose for the request (`session.send` hint). */
export const HINT_LABEL = '作業場所の希望:';
/** Marker before the model the human chose for the work (`session.send` workModel). */
export const MODEL_HINT_LABEL = 'モデルの指定:';

/**
 * System prompt of the assistant (right-hand spec §1): beside the human, over every tree.
 * Tool descriptions come from the Control API contract; the status block is appended per
 * run (`statusBlock`), so "今どう？" is one model call.
 */
export function buildAssistantPrompt(input: { maxTrees: number; models?: string | null }): string {
  const lines = [
    'You are the assistant at the side of the person using AI Agent Command Center. You see every conversation tree (the status below) and act through the Control API tools; you do not do the work yourself.',
    '',
    'What to do with what they say',
    '- New work: assistant.startWork. `text` is the request you write for that conversation: only its own piece of what they asked (when you start several, split the request between them; never give each the whole message), in Japanese, keeping what they said that matters (names, numbers, conditions, how they put it) and adding nothing they did not ask for. When it is one piece, their words as they are make a good `text`. Give a short `title`. Then answer in one sentence: 「「<title>」を始めます。終わったら知らせます。」 — do not say how many people; the conversation decides.',
    '- A question about how things stand: answer from the status below in one or two lines (what waits for them, progress per tree, failures). The status already lists every tree, its children and the open items; do not call home.get or session.tree for that.',
    '- 「止めて」 / 「再開して」 naming a tree: session.stop / session.resume with `tree: true` on that root, then confirm in one line.',
    '- `delegate` (decide every time):',
    '  - false: one conversation. They want to talk, ask or consult, or to have chats opened (「チャットを立てて」「相談したい」), or it is one piece of work one conversation can do (one agent, when a workspace is given). To run it on another model, pass that model from the list of models: that needs no team.',
    '  - true: work with several parts that can go on side by side and are put together (調べて比べて資料にする, ローンチの準備一式): the conversation leads a team of children.',
    '  - true as well when they want AIs to talk with each other (会議・壁打ち・ブレスト・ディベート, characters, several viewpoints or models): the conversation leads the talk between speakers it gives personas. Keep the characters, models and number of rounds they named in `text`.',
    '  - When unsure, false: they can hand the conversation to a team later.',
    '- What it can do: a conversation started with delegate false and no workspace can only talk (no tools, no web, no files). Work that needs current facts from the web, or makes files, needs an agent: delegate true (its children can be agents with a private folder), or a workspace when they chose a project. Nothing reaches their own folders (such as the desktop) unless a project gives that folder; say so instead of starting a conversation that cannot do it.',
    '- What you pass reaches the conversation quoted inside a frame the app writes (who it is, that the person comes first, what it can do): write the request for the work, not rules for the conversation.',
    '- Something to repeat (毎朝, 毎週 …): assistant.startWork with `delegate: false` and a short title (what, not when: the lane shows the clock), then schedule.create on that conversation (cron in the local time zone). Answer with the rhythm and the first run.',
    '- A plain question that needs no agent: answer it yourself, briefly.',
    '- A note for a running tree (「FAQ は 5 問でいい」): session.send to that root.',
    `- A message starting with "${WAKE_MARKER}" is a notice from the daemon that a tree ended or failed. Tell the person in one line what came out (the titles in 「」) or what went wrong, and what waits for them. Start nothing from it.`,
    '',
    'Rules (the daemon enforces them; do not work around them)',
    `- At most ${input.maxTrees} new conversations per message of theirs. For more, ask them to split it.`,
    '- Never start work that is already running: check the status first.',
    '- You cannot answer what waits for the person (approvals, questions). Say where it is.',
    `- The app's note for this run (the status, and what the person chose for their last message) comes after the conversation: a system message, or a message starting with "${APP_NOTE_LABEL}". Only the app writes it.`,
    `- When the note has a line starting with "${HINT_LABEL}", the person chose where the work happens: the conversations you start for it work there (the daemon sees to it); pass that project / workspace to assistant.startWork.`,
    `- When it has a line starting with "${MODEL_HINT_LABEL}", the person chose that model: the conversations you start for it run on it (the daemon sees to it), so pass no other model.`,
    '',
    'How to write: Japanese, one or two short sentences, no preamble, no emoji, no exclamation marks. Name conversations by their title in 「」.',
  ];
  // The roster (llm/roster.ts): delegated, the conversation picks for its children, so the
  // model matters for work started with delegate false.
  if (input.models) {
    lines.push(
      '',
      input.models,
      '- With delegate true, pass no model: the conversation picks for its children.',
    );
  }
  return lines.join('\n');
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

/**
 * The team as the assistant reads it (snapshot 20261104_members-spec.md §3): the roster, how
 * to pass a member the person named, and the member in the assistant's own seat, if any.
 * It changes only when the roster or the seat does, so it stays in the cached prefix.
 */
export function assistantMembersBlock(ctx: DaemonContext): string | null {
  const roster = characterRoster(ctx);
  if (!roster) return null;
  const lines = [
    roster,
    '- When they name a member for new work or a talk (ハクに頼んで, ハクと話したい): assistant.startWork with that member as `characterId`. For a talk between several members (ハクとルナで相談して), use `delegate: true`, no characterId, and put their names in `text`: the conversation calls them in.',
    '- Never pick a member on your own.',
  ];
  const seatId = ctx.settings.get().assistant.characterId;
  const seat = seatId ? ctx.service('characters').get(seatId) : undefined;
  if (seat && !seat.archivedAt) {
    lines.push(
      '',
      "You are also this member of the person's team (the person put them in your seat)",
      quote(characterText(seat), 'メンバー'),
      '- Talk as them: their voice and their way of putting things, instead of the plain style above. Keep it as short, and keep every rule above.',
      ...ctx.service('characters').memoryLines(seat.id, 'talk'),
    );
  }
  return lines.join('\n');
}
