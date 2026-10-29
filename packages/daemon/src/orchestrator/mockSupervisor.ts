import type { MockCallInfo, MockReply } from '../llm/mock';
import { methodForToolName, toolNameForMethod } from '../llm/tools';
import type { ChatMessage, ChatRequest } from '../llm/types';
import { INJECTED_PREFIX, WAKE_MARKER } from '../inbox/wake';
import { PROJECT_ID_LABEL, REPOSITORY_LABEL } from './executor';

type ToolCall = NonNullable<MockReply['toolCalls']>[number];

/** One line of the tree snapshot in the system prompt (executor.ts treeSnapshot). */
export interface TreeNode {
  id: string;
  title: string;
  self: boolean;
  state: string;
  outputs: string[];
}

const TREE_LINE =
  /^\s*- \[(ses_[0-9a-z]+)\] 「(.*?)」(（この会話）)? state=([a-z_]+)(?: outputs=(.*))?$/;
const QUESTION_LINE = /^\s*質問: 「(.*?)」（(atn_[0-9a-z]+)）(?: 選択肢: (.*))?$/;
const CHOICE = /(.+?)（([^（）]+)）$/;

/** Child states counted as finished for the report (needs_you still waits for a human). */
const FINISHED = new Set(['done', 'review', 'failed', 'stopped']);
const WORKING = new Set(['working', 'queued', 'supervising', 'idle']);

const STATE_JA: Record<string, string> = {
  done: '完了',
  review: '確認待ち',
  failed: '失敗',
  stopped: '停止中',
  needs_you: '人の判断待ち',
  working: '作業中',
  queued: '開始待ち',
  supervising: '作業中',
  idle: '待機中',
};

interface Question {
  title: string;
  attentionId: string;
  choices: { label: string; id: string }[];
}

interface Parsed {
  tools: Set<string>;
  projectId: string | null;
  hasRepository: boolean;
  self: TreeNode | null;
  children: TreeNode[];
  /** The conversation's first request (the goal). */
  firstRequest: string;
}

/**
 * The supervisor half of `mock/orchestrator` (spec 20261029 §3.13): a state machine on the
 * last thing that arrived, so every run ends with a reply without tools.
 *
 * | last arrival                 | reply                                                   |
 * |------------------------------|---------------------------------------------------------|
 * | a goal (user message)        | session.spawn × 3 + orchestrator.recordDecision          |
 * | results of session.spawn     | text only: who does what                                 |
 * | a wake, some still working   | text only: "1/3 完了…"                                   |
 * | a wake with a question       | attention.respond when the goal answers it, else text    |
 * | a wake, all finished         | the final report (output titles), no tools               |
 * | "いま何してる？"              | session.tree → text                                      |
 * | "止めて" / "再開して"          | session.stop / session.resume → text                     |
 * | "N 人追加して"                 | session.spawn × N (+ recordDecision) → text              |
 *
 * Invariants: never a reply whose only tool call is recordDecision; the final report has no
 * tools; two replies in a row never repeat the same text (they name counts and titles).
 */
export function mockSupervisor(req: ChatRequest, info: MockCallInfo): MockReply {
  const p = parse(req);
  const userAt = lastIndex(req.messages, (m) => m.role === 'user');
  const arrival = userAt >= 0 ? (req.messages[userAt] as { content: string }).content : '';
  const after = req.messages.slice(userAt + 1);

  // Mid-run: the previous reply called tools; answer from their results.
  if (after.some((m) => m.role === 'assistant')) return afterTools(p, after, info);
  if (arrival.startsWith(WAKE_MARKER)) return onWake(p, arrival);
  const text = arrival.startsWith(INJECTED_PREFIX)
    ? arrival.slice(INJECTED_PREFIX.length).trim()
    : arrival;
  return onUserMessage(p, text, req);
}

// ---------------------------------------------------------------------------
// Arrivals
// ---------------------------------------------------------------------------

function onUserMessage(p: Parsed, text: string, req: ChatRequest): MockReply {
  if (/いま|今|何して|なにして|どうなって|状況|進み/.test(text)) {
    if (p.tools.has('session.tree') && p.self) {
      return {
        text: '会話の木を確かめます。',
        toolCalls: [call('session.tree', { sessionId: p.self.id })],
      };
    }
    return { text: describeTree(p.children) };
  }
  if (/止めて|とめて|ストップ|中止/.test(text)) {
    const busy = p.children.filter((c) => WORKING.has(c.state) || c.state === 'needs_you');
    if (busy.length === 0 || !p.tools.has('session.stop')) {
      return { text: 'いま動いている子はいません。' };
    }
    return {
      text: `${busy.length} 件の作業を止めます。`,
      toolCalls: busy.map((c) => call('session.stop', { sessionId: c.id })),
    };
  }
  if (/再開/.test(text)) {
    const stopped = p.children.filter((c) => c.state === 'stopped');
    if (stopped.length === 0 || !p.tools.has('session.resume')) {
      return { text: '止まっている作業はありません。' };
    }
    return {
      text: `${stopped.length} 件の作業を再開します。`,
      toolCalls: stopped.map((c) => call('session.resume', { sessionId: c.id })),
    };
  }
  const more = addCount(text);
  if (more > 0 && p.children.length > 0) {
    if (!p.tools.has('session.spawn')) {
      return { text: 'この会話には作業を任せる権限がありません。' };
    }
    return addHelpers(p, more);
  }
  const newGoal = /^新しい目標\s*[:：]/.test(text);
  if (p.children.length > 0 && !newGoal && !isFirstRequest(req, text)) {
    return {
      text: `いまは ${p.children.length} 件の作業を見守っています（${progress(p.children)}）。別のことを任せるときは「新しい目標: …」と送ってください。`,
    };
  }
  return plan(p, text.replace(/^新しい目標\s*[:：]\s*/, '').trim() || '依頼された作業');
}

function onWake(p: Parsed, wake: string): MockReply {
  const questions = parseQuestions(wake);
  const answerable = questions
    .map((q) => ({ q, choice: q.choices.find((c) => p.firstRequest.includes(c.label)) }))
    .filter((x): x is { q: Question; choice: { label: string; id: string } } => !!x.choice);
  if (answerable.length > 0 && p.tools.has('attention.respond')) {
    return {
      text: `依頼の内容から答えられる質問に答えます（${answerable.map((a) => `「${a.q.title}」→ ${a.choice.label}`).join('、')}）。`,
      toolCalls: answerable.map((a) =>
        call('attention.respond', { attentionId: a.q.attentionId, choiceId: a.choice.id }),
      ),
    };
  }
  if (p.children.length > 0 && p.children.every((c) => FINISHED.has(c.state))) {
    return { text: finalReport(p.children) };
  }
  const waiting = p.children.filter((c) => c.state === 'needs_you');
  const lines = [`${progress(p.children)}。`];
  if (waiting.length > 0) {
    lines.push(
      `${waiting.map((c) => `「${c.title}」`).join('、')}はあなたの判断を待っています${questions.length > 0 ? `（${questions.map((q) => `「${q.title}」`).join('、')}）` : ''}。`,
    );
  }
  const working = p.children.filter((c) => WORKING.has(c.state));
  if (working.length > 0) {
    lines.push(`${working.map((c) => `「${c.title}」`).join('、')}の作業が終わるのを待ちます。`);
  }
  return { text: lines.join('') };
}

function afterTools(p: Parsed, after: ChatMessage[], info: MockCallInfo): MockReply {
  const assistantAt = lastIndex(after, (m) => m.role === 'assistant');
  const assistant = after[assistantAt] as Extract<ChatMessage, { role: 'assistant' }>;
  const calls = assistant.toolCalls ?? [];
  if (calls.length === 0) return { text: '' };
  const results = new Map(info.toolResults.map((r) => [r.toolCallId, parseJson(r.content)]));
  const done = calls.map((c) => {
    const out = results.get(c.id);
    const error = (out as { error?: { message?: string } } | null)?.error;
    return {
      method: methodForToolName(c.name),
      input: parseJson(c.arguments) as Record<string, unknown> | null,
      output: out,
      error: error ? (error.message ?? 'エラー') : null,
    };
  });
  const spawned = done.filter((d) => d.method === 'session.spawn');
  if (spawned.length > 0) {
    const ok = spawned.filter((d) => !d.error);
    const titles = ok
      .map((d) => `「${typeof d.input?.title === 'string' ? d.input.title : ''}」`)
      .join('、');
    if (ok.length === 0) {
      return { text: `作業を任せられませんでした: ${spawned[0]!.error}` };
    }
    const failed = spawned.filter((d) => d.error);
    return {
      text: [
        `${ok.length} 人に任せました：${titles}。終わったら知らせが届くので、そろったらまとめて報告します。`,
        ...(failed.length > 0
          ? [`${failed.length} 件は任せられませんでした: ${failed[0]!.error}`]
          : []),
      ].join('\n'),
    };
  }
  const tree = done.find((d) => d.method === 'session.tree');
  if (tree) {
    if (tree.error) return { text: `会話の木を確かめられませんでした: ${tree.error}` };
    const nodes = (
      (
        tree.output as {
          nodes?: { title: string; state: string; parentId: string | null }[];
        } | null
      )?.nodes ?? []
    ).filter((n) => n.parentId !== null);
    return {
      text: describeTree(
        nodes.map((n) => ({ id: '', title: n.title, self: false, state: n.state, outputs: [] })),
      ),
    };
  }
  const stops = done.filter((d) => d.method === 'session.stop');
  if (stops.length > 0) {
    const ok = stops.filter((d) => !d.error).length;
    return {
      text: `${ok} 件の作業を止めました。再開するときは「再開して」と送ってください。${ok < stops.length ? `（${stops.length - ok} 件は止められませんでした）` : ''}`,
    };
  }
  const resumes = done.filter((d) => d.method === 'session.resume');
  if (resumes.length > 0) {
    return { text: `${resumes.filter((d) => !d.error).length} 件の作業を再開しました。` };
  }
  const answers = done.filter((d) => d.method === 'attention.respond');
  if (answers.length > 0) {
    const ok = answers.filter((d) => !d.error).length;
    return {
      text:
        ok > 0
          ? `${ok} 件の質問に答えました。続きの作業が終わるのを待ちます。`
          : `質問に答えられませんでした: ${answers[0]!.error}`,
    };
  }
  return { text: '操作の結果を確認しました。' };
}

// ---------------------------------------------------------------------------
// Plans and reports
// ---------------------------------------------------------------------------

interface ChildPlan {
  title: string;
  goal: string;
  doneWhen: string[];
  steps: unknown[];
  summary: string;
  code?: boolean;
}

function plan(p: Parsed, goal: string): MockReply {
  if (!p.tools.has('session.spawn')) {
    return {
      text: 'この会話には作業を任せる権限がありません。「任せる」を有効にしてから、もう一度お願いします。',
    };
  }
  const children = childPlans(goal, p.hasRepository && p.projectId ? p.projectId : null);
  const titles = children.map((c) => `「${c.title}」`).join('、');
  const decision = p.tools.has('orchestrator.recordDecision')
    ? [
        call('orchestrator.recordDecision', {
          decision: `${children.length} 人に任せる: ${titles}`,
          rationale: '互いに待ち合わせずに進められる作業なので、同時に任せます。',
        }),
      ]
    : [];
  return {
    text: `「${goal}」を ${children.length} つの作業に分けて任せます。`,
    toolCalls: [
      ...children.map((c) =>
        call('session.spawn', {
          title: c.title,
          goal: [
            c.goal,
            '',
            '```acc-mock',
            JSON.stringify({ steps: c.steps, summary: c.summary }, null, 2),
            '```',
          ].join('\n'),
          doneWhen: c.doneWhen,
          mode: 'agent',
          ...(c.code && p.projectId
            ? { workspace: { kind: 'worktree', projectId: p.projectId } }
            : {}),
        }),
      ),
      ...decision,
    ],
  };
}

/** Three non-code pieces (research with links, data, a document); one is code with a repository. */
export function childPlans(goal: string, codeProjectId: string | null): ChildPlan[] {
  const short = goal.length > 24 ? `${goal.slice(0, 23)}…` : goal;
  const launch = /ローンチ|発売|リリース|新製品|launch/i.test(goal);
  const say = (text: string) => ({ type: 'say', text });
  const plans: ChildPlan[] = launch
    ? [
        {
          title: '競合の価格を調べる',
          goal: `「${goal}」のために、競合 3 社の価格と主な機能を調べ、出典のリンクをつけてまとめてください。`,
          doneWhen: ['競合 3 社の価格がある', '出典のリンクがある'],
          steps: [
            say('競合 3 社の公開情報を確認します。'),
            say('価格と主な機能を表にまとめました。'),
          ],
          summary:
            '競合 3 社の価格: A 社 月額 1,200 円、B 社 月額 980 円、C 社 無料プランあり（出典: 各社の料金ページ）。',
        },
        {
          title: 'FAQ を書く',
          goal: `「${goal}」のために、問い合わせが多そうな質問 5 つと回答を FAQ としてまとめてください。`,
          doneWhen: ['質問と回答が 5 組ある'],
          steps: [
            say('想定される質問を洗い出します。'),
            { type: 'ask', title: '価格（月額 980 円）を FAQ に載せる？', onReject: 'continue' },
            say('FAQ を書き上げました。'),
          ],
          summary: 'FAQ（5 問）: 始め方、料金、解約、データの扱い、問い合わせ先。',
        },
        {
          title: '告知文を書く',
          goal: `「${goal}」のために、発表用の告知文（300 字程度）を書いてください。`,
          doneWhen: ['300 字程度の告知文がある'],
          steps: [say('伝えたい点を 3 つに絞ります。'), say('告知文を書きました。')],
          summary: '告知文: 新製品の特長を 3 点に絞り、発売日と申し込み方法で締めました。',
        },
      ]
    : [
        {
          title: `${short}の下調べ`,
          goal: `「${goal}」について、参考になる情報源を調べてリンクつきでまとめてください。`,
          doneWhen: ['情報源のリンクが 3 つ以上ある'],
          steps: [say('関係する情報源を探します。'), say('参考になるリンクをまとめました。')],
          summary: `「${short}」の参考情報を 3 件、リンクつきでまとめました。`,
        },
        {
          title: `${short}のデータ整理`,
          goal: `「${goal}」に関係するデータを集めて表に整理してください。`,
          doneWhen: ['表に整理されている'],
          steps: [say('必要な項目を決めます。'), say('データを表に整理しました。')],
          summary: `「${short}」のデータを表に整理しました。`,
        },
        {
          title: `${short}のまとめ`,
          goal: `「${goal}」の要点を 1 ページの文書にまとめてください。`,
          doneWhen: ['要点が 1 ページにまとまっている'],
          steps: [say('要点を洗い出します。'), say('1 ページにまとめました。')],
          summary: `「${short}」の要点を 1 ページにまとめました。`,
        },
      ];
  if (codeProjectId) {
    plans[1] = {
      title: `${short}のコード変更`,
      goal: `「${goal}」に必要なコードの変更をしてください。`,
      doneWhen: ['変更がコミットされている'],
      steps: [
        say('変更する箇所を確認します。'),
        { type: 'write', path: 'docs/notes.md', content: `# メモ\n\n${goal}\n` },
      ],
      summary: 'docs/notes.md に変更の要点を書きました。',
      code: true,
    };
  }
  return plans;
}

const KANJI_COUNT: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 };
/** Helpers one "N 人追加して" may add (the daemon's maxChildren still applies). */
const MAX_ADDED = 4;

/** "1人追加して" / "テスト担当をもう 2 人追加して" / "もう一人増やして" → N; 0 when not asked. */
export function addCount(text: string): number {
  if (!/(追加|増や)/.test(text)) return 0;
  const m = /([0-9０-９]+|[一二三四五])\s*人/.exec(text);
  const raw = m?.[1];
  if (!raw) return 1;
  const n = KANJI_COUNT[raw] ?? Number(raw.normalize('NFKC'));
  return Math.max(1, Math.min(MAX_ADDED, Number.isFinite(n) ? n : 1));
}

/** "もう N 人追加して": N more children on the first request, numbered after the existing ones. */
function addHelpers(p: Parsed, count: number): MockReply {
  const goal = p.firstRequest.replace(/^新しい目標\s*[:：]\s*/, '').trim() || '依頼された作業';
  const short = goal.length > 24 ? `${goal.slice(0, 23)}…` : goal;
  const say = (text: string) => ({ type: 'say', text });
  const helpers = Array.from({ length: count }, (_, i) => {
    const n = p.children.length + i + 1;
    return {
      title: `追加の担当 ${n}`,
      goal: `「${goal}」について、ほかの担当の作業を補う点を洗い出してまとめてください。`,
      steps: [say('ほかの担当の作業を確認します。'), say('補う点を洗い出しました。')],
      summary: `「${short}」で補う点を 3 つにまとめました。`,
    };
  });
  return {
    text: `${count} 人追加して任せます。`,
    toolCalls: [
      ...helpers.map((h) =>
        call('session.spawn', {
          title: h.title,
          goal: [
            h.goal,
            '',
            '```acc-mock',
            JSON.stringify({ steps: h.steps, summary: h.summary }, null, 2),
            '```',
          ].join('\n'),
          mode: 'agent',
        }),
      ),
      ...(p.tools.has('orchestrator.recordDecision')
        ? [
            call('orchestrator.recordDecision', {
              decision: `${count} 人追加: ${helpers.map((h) => `「${h.title}」`).join('、')}`,
              rationale: '依頼者から担当を増やすよう頼まれたため。',
            }),
          ]
        : []),
    ],
  };
}

function finalReport(children: TreeNode[]): string {
  const lines = [`すべての作業が終わりました（${children.length} 件）。`, ''];
  for (const c of children) {
    lines.push(
      `- 「${c.title}」: ${STATE_JA[c.state] ?? c.state}${c.outputs.length > 0 ? ` — 成果物 ${c.outputs.join('、')}` : ''}`,
    );
  }
  const review = children.filter((c) => c.state === 'review');
  const failed = children.filter((c) => c.state === 'failed');
  if (review.length + failed.length > 0) lines.push('');
  if (review.length > 0) {
    lines.push(`確認してほしいもの: ${review.map((c) => `「${c.title}」`).join('、')}の成果物。`);
  }
  if (failed.length > 0) {
    lines.push(
      `うまくいかなかったもの: ${failed.map((c) => `「${c.title}」`).join('、')}。やり直すか判断してください。`,
    );
  }
  return lines.join('\n');
}

function progress(children: TreeNode[]): string {
  const finished = children.filter((c) => FINISHED.has(c.state)).length;
  return `${finished}/${children.length} 件が終わりました`;
}

function describeTree(children: TreeNode[]): string {
  if (children.length === 0) return 'まだ誰にも任せていません。';
  return [
    `${progress(children)}。`,
    ...children.map((c) => `- 「${c.title}」: ${STATE_JA[c.state] ?? c.state}`),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parse(req: ChatRequest): Parsed {
  const tools = new Set((req.tools ?? []).map((t) => methodForToolName(t.name)));
  const system = req.messages.find((m) => m.role === 'system');
  const content = system?.role === 'system' ? system.content : '';
  const projectId =
    new RegExp(`${PROJECT_ID_LABEL}\\s*(prj_[0-9a-z]{26})`).exec(content)?.[1] ?? null;
  const hasRepository = new RegExp(`${REPOSITORY_LABEL}\\s*yes`).test(content);
  const nodes: TreeNode[] = [];
  for (const line of content.split('\n')) {
    const m = TREE_LINE.exec(line);
    if (!m) continue;
    nodes.push({
      id: m[1]!,
      title: m[2]!,
      self: !!m[3],
      state: m[4]!,
      outputs: m[5] ? m[5].split(',').map((s) => s.replace(/\(art_[0-9a-z]+\)$/, '')) : [],
    });
  }
  const first = req.messages.find((m) => m.role === 'user' && !m.content.startsWith(WAKE_MARKER));
  return {
    tools,
    projectId,
    hasRepository,
    self: nodes.find((n) => n.self) ?? null,
    children: nodes.filter((n) => !n.self),
    firstRequest: first?.role === 'user' ? first.content : '',
  };
}

function parseQuestions(wake: string): Question[] {
  const out: Question[] = [];
  for (const line of wake.split('\n')) {
    const m = QUESTION_LINE.exec(line);
    if (!m) continue;
    const choices = (m[3] ?? '')
      .split(' / ')
      .map((c) => CHOICE.exec(c.trim()))
      .filter((c): c is RegExpExecArray => !!c)
      .map((c) => ({ label: c[1]!, id: c[2]! }));
    out.push({ title: m[1]!, attentionId: m[2]!, choices });
  }
  return out;
}

/** The text is the conversation's first request (a run started again on the same goal). */
function isFirstRequest(req: ChatRequest, text: string): boolean {
  const users = req.messages.filter((m) => m.role === 'user' && !m.content.startsWith(WAKE_MARKER));
  return users.length <= 1 && users[0]?.role === 'user' && users[0].content === text;
}

function lastIndex<T>(items: T[], pred: (x: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i]!)) return i;
  return -1;
}

function call(method: string, input: Record<string, unknown>): ToolCall {
  return { name: toolNameForMethod(method), input };
}

function parseJson(raw: string | undefined): unknown {
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
