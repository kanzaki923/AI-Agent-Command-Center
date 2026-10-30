import type { MockCallInfo, MockReply } from '../llm/mock';
import { toolNameForMethod } from '../llm/tools';
import type { ChatRequest } from '../llm/types';
import { HINT_LABEL } from './prompt';

type ToolCall = NonNullable<MockReply['toolCalls']>[number];

/** One tree line of the status block (prompt.ts statusBlock). */
const TREE_LINE =
  /^- \[(ses_[0-9a-z]+)\] 「(.*?)」 state=([a-z_]+)(?: progress=(\d+)\/(\d+))?(?: needsYou=(\d+))?(?: failed=(\d+))?/;
const PROJECT_ID = /projectId:\s*(prj_[0-9a-z]+)/;

interface Tree {
  id: string;
  title: string;
  state: string;
  progress: [number, number] | null;
  needsYou: number;
  failed: number;
}

const STATE_JA: Record<string, string> = {
  done: '完了',
  review: '確認待ち',
  failed: '失敗',
  stopped: '停止中',
  needs_you: '出番',
  working: '作業中',
  queued: '開始待ち',
  supervising: '進行中',
  idle: '待機中',
};

const tc = (method: string, input: unknown): ToolCall => ({
  name: toolNameForMethod(method),
  input,
});

function parseStatus(req: ChatRequest): { trees: Tree[]; hint: string | null } {
  // The status is in the second system message (service.ts systemPrompts); read them all.
  const text = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => (m as { content: string }).content)
    .join('\n');
  const trees: Tree[] = [];
  let hint: string | null = null;
  for (const line of text.split('\n')) {
    const m = TREE_LINE.exec(line);
    if (m) {
      trees.push({
        id: m[1]!,
        title: m[2]!,
        state: m[3]!,
        progress: m[4] !== undefined ? [Number(m[4]), Number(m[5])] : null,
        needsYou: Number(m[6] ?? 0),
        failed: Number(m[7] ?? 0),
      });
    } else if (line.startsWith(HINT_LABEL)) {
      hint = line.slice(HINT_LABEL.length).trim();
    }
  }
  return { trees, hint };
}

/** The last thing the assistant said before this message (two replies in a row never repeat). */
function lastSaid(req: ChatRequest): string | null {
  let userSeen = false;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role === 'user') {
      if (userSeen) return null;
      userSeen = true;
      continue;
    }
    if (userSeen && m.role === 'assistant' && m.content) return m.content;
  }
  return null;
}

/** `text`, or `alt` when the assistant said exactly that last time. */
function distinct(req: ChatRequest, text: string, alt: string): string {
  return lastSaid(req) === text ? alt : text;
}

function parsed(info: MockCallInfo): unknown {
  const raw = info.toolResults[0]?.content;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function errorOf(v: unknown): string | null {
  if (v && typeof v === 'object' && 'error' in v) {
    const e = (v as { error: { message?: string } }).error;
    return e?.message ?? 'エラー';
  }
  return null;
}

/**
 * The tree a sentence names: one whose title the sentence contains, or whose title contains
 * what is left of the sentence once the verb is cut (「ローンチ準備を止めて」 → ローンチ準備).
 */
function named(trees: Tree[], text: string): Tree | undefined {
  const byLength = [...trees].sort((a, b) => b.title.length - a.title.length);
  const direct = byLength.find((t) => t.title && text.includes(t.title));
  if (direct) return direct;
  const key = text
    .replace(/(?:を|は|の)?\s*(?:止め|停止|ストップ|再開|続け)[\s\S]*$/, '')
    .replace(/^(?:あの|その|この)/, '')
    .trim();
  if (key.length < 2) return undefined;
  return byLength.find((t) => t.title.includes(key));
}

const STATUS_ASK = /(?:[?？]\s*$)|^(?:今|いま|どう|何|なに|状況|進捗|進み)/;
const STOP = /止め|停止|ストップ/;
const RESUME = /再開|続け/;
const REPEAT = /毎朝|毎日|毎週|毎月/;

/** Cron of a repeat request: the hour it names (default 9), weekly on Monday, daily otherwise. */
export function cronOf(text: string): string {
  const h = /(\d{1,2})\s*時/.exec(text);
  const hour = h ? Math.min(23, Number(h[1])) : 9;
  if (/毎週/.test(text)) return `0 ${hour} * * 1`;
  if (/毎月/.test(text)) return `0 ${hour} 1 * *`;
  return `0 ${hour} * * *`;
}

function rhythm(text: string, cron: string): string {
  const hh = `${cron.split(' ')[1]}:00`;
  if (/毎週/.test(text)) return `毎週月曜 ${hh}`;
  if (/毎月/.test(text)) return `毎月 1 日 ${hh}`;
  return `毎朝 ${hh}`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function titleOf(text: string): string {
  const line = text.trim().split(/\r?\n/)[0]!.trim();
  const chars = [...line];
  return chars.length > 40 ? `${chars.slice(0, 39).join('')}…` : line;
}

/**
 * `mock/right-hand` (right-hand spec §1.3): the assistant offline, deciding by the shape of
 * the sentence and answering through the same tools a real model gets.
 *
 * | the sentence                          | turn 0                               | then                          |
 * |---------------------------------------|--------------------------------------|-------------------------------|
 * | ends with ？ / starts 今・どう・何      | home.get                             | 1–2 lines from the snapshot   |
 * | 止めて + the title of a tree           | session.stop {tree}                  | 「止めました。再開は…」        |
 * | 再開 + the title of a tree             | session.resume {tree}                | 「再開しました」               |
 * | 毎朝・毎日・毎週 (+ N 時)               | assistant.startWork {delegate:false} | schedule.create → the rhythm  |
 * | anything else                          | assistant.startWork                  | 「「題」を始めます…」          |
 */
export function mockRightHand(req: ChatRequest, info: MockCallInfo): MockReply {
  const text = info.lastUserText.trim();
  const { trees, hint } = parseStatus(req);
  const result = parsed(info);
  const failed = errorOf(result);

  if (info.turn >= 1 && failed) {
    return {
      text: distinct(req, `できませんでした。${failed}`, `うまくいきませんでした。${failed}`),
    };
  }

  if (REPEAT.test(text)) {
    if (info.turn === 0) {
      return {
        text: '',
        toolCalls: [tc('assistant.startWork', { text, title: titleOf(text), delegate: false })],
      };
    }
    if (info.turn === 1) {
      const session = (result as { session?: { id: string; title: string } } | null)?.session;
      if (!session) return { text: '会話を作れませんでした。' };
      return {
        text: '',
        toolCalls: [
          tc('schedule.create', {
            sessionId: session.id,
            title: session.title,
            prompt: text,
            trigger: { kind: 'cron', expr: cronOf(text) },
          }),
        ],
      };
    }
    const schedule = result as { nextRunAt?: string | null } | null;
    const first = schedule?.nextRunAt ? `最初は ${formatWhen(schedule.nextRunAt)}。` : '';
    return { text: `${rhythm(text, cronOf(text))}。${first}`.trim() };
  }

  if (STOP.test(text) || RESUME.test(text)) {
    const stop = STOP.test(text);
    if (info.turn === 0) {
      const tree = named(trees, text);
      if (!tree) {
        const titles = trees.map((t) => `「${t.title}」`).join('、');
        return { text: titles ? `どれですか。${titles}` : '動いている会話はありません。' };
      }
      return {
        text: '',
        toolCalls: [
          tc(stop ? 'session.stop' : 'session.resume', { sessionId: tree.id, tree: true }),
        ],
      };
    }
    return stop
      ? { text: distinct(req, '止めました。再開は言ってください。', '止めました。') }
      : { text: distinct(req, '再開しました。', '続きを始めました。') };
  }

  if (STATUS_ASK.test(text)) {
    if (info.turn === 0) return { text: '', toolCalls: [tc('home.get', {})] };
    return { text: summarize(req, result) };
  }

  if (info.turn === 0) {
    const projectId = hint ? PROJECT_ID.exec(hint)?.[1] : undefined;
    const code = !!projectId && !!hint?.startsWith('コード');
    const folder = hint && /^フォルダ\s+(.+?)(?:\s+\(|$)/.exec(hint)?.[1];
    return {
      text: '',
      toolCalls: [
        tc('assistant.startWork', {
          text,
          title: titleOf(text),
          ...(projectId ? { projectId } : {}),
          ...(code ? { workspace: { kind: 'worktree', projectId } } : {}),
          ...(folder ? { workspace: { kind: 'folder', path: folder } } : {}),
        }),
      ],
    };
  }
  const session = (result as { session?: { title: string } } | null)?.session;
  const title = session?.title ?? titleOf(text);
  return {
    text: distinct(
      req,
      `「${title}」を始めます。終わったら知らせます。`,
      `「${title}」を始めました。進み具合はホームに出ます。`,
    ),
  };
}

/** 1–2 lines from a home.get result: what waits for the human, then each tree. */
function summarize(req: ChatRequest, result: unknown): string {
  const snap = result as {
    totals?: { needsYou: number; working: number; failed: number };
    trees?: {
      root: { title: string; state: string };
      nodes: { depth: number }[];
      counts: { done: number; review: number; needsYou: number; failed: number };
    }[];
  } | null;
  if (!snap?.totals) return '状況を読めませんでした。';
  const head =
    snap.totals.needsYou > 0 ? `出番が ${snap.totals.needsYou} 件。` : '出番はありません。';
  const parts = (snap.trees ?? []).slice(0, 4).map((t) => {
    const children = t.nodes.filter((n) => n.depth === 1).length;
    const finished = t.counts.done + t.counts.review;
    const bits = [
      children > 0 ? `${finished}/${children}` : (STATE_JA[t.root.state] ?? t.root.state),
    ];
    if (t.counts.failed > 0) bits.push(`失敗 ${t.counts.failed}`);
    return `「${t.root.title}」は ${bits.join('、')}`;
  });
  const body = parts.length > 0 ? `${parts.join('、')}。` : '動いている会話はありません。';
  return distinct(req, `${head}${body}`, `${body}${head}`);
}
