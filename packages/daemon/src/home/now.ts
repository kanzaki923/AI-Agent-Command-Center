import {
  COMMAND_TOOLS,
  EDIT_TOOLS,
  SUBAGENT_TOOLS,
  asRecord,
  asString,
  toolPaths,
} from '../runtime/tools';

/**
 * "What is it doing now" (spec 20261029 §3.7): a short Japanese noun phrase shown on a
 * session's chip, at most {@link NOW_MAX_CHARS} characters, built from the tool in use (or
 * the runtime's activity line) without calling an LLM. One rule set for every runtime: the
 * activity lines of `runtime/tools.ts` `describeToolActivity` are read back into the same
 * phrases as the tool call itself, so the chip does not flicker between the two.
 */
export const NOW_MAX_CHARS = 24;

/** Shown while a run is starting (runtime boilerplate such as "Claude Code を起動しました"). */
export const NOW_PREPARING = '準備中';
/** Shown while the model writes its answer. */
export const NOW_WRITING = '回答を作成中';
/** Shown while the model thinks (reasoning deltas). */
export const NOW_THINKING = '考え中';

const chars = (s: string) => Array.from(s);

/** One line, cut to `max` characters with "…". */
export function clip(text: string, max = NOW_MAX_CHARS): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const c = chars(oneLine);
  return c.length <= max ? oneLine : `${c.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** `<object><suffix>` within the limit: the object is cut, the verb (suffix) is kept. */
function phrase(object: string, suffix: string): string {
  const room = NOW_MAX_CHARS - chars(suffix).length;
  return `${clip(object, room)}${suffix}`;
}

/** Last path segment ("docs/faq.md" → "faq.md"); the path itself when it has none. */
function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url.replace(/^[a-z]+:\/\//i, '').split('/')[0] || url;
  }
}

const MCP_ACC_PREFIX = 'mcp__acc__';

/**
 * Control API method of a tool name: "session.spawn" as is, the Claude MCP form
 * "mcp__acc__session_spawn" and the tool-loop form "session__spawn" mapped back.
 */
export function controlMethodOf(toolName: string): string | null {
  if (toolName.startsWith(MCP_ACC_PREFIX)) {
    return toolName.slice(MCP_ACC_PREFIX.length).replaceAll('_', '.');
  }
  if (/^[a-z]+(\.[a-zA-Z]+)+$/.test(toolName)) return toolName;
  if (/^[a-z]+(__[a-zA-Z]+)+$/.test(toolName)) return toolName.replaceAll('__', '.');
  return null;
}

/** Phrase for a Control API call; null = keep the previous phrase (bookkeeping calls). */
function nowForMethod(method: string, ctx: { spawned?: number }): string | null {
  if (method === 'session.spawn') {
    const n = Math.max(1, ctx.spawned ?? 1);
    return `${n} 人に依頼`;
  }
  if (method === 'orchestrator.recordDecision') return null;
  const [domain] = method.split('.');
  switch (method) {
    case 'session.send':
      return '指示を送信';
    case 'session.stop':
      return '作業を停止';
    case 'session.resume':
      return '作業を再開';
    case 'artifact.publish':
      return '成果物を公開';
    case 'artifact.review':
      return '成果物を確認';
    case 'human.ask':
      return '質問を作成';
    case 'attention.respond':
      return '質問に回答';
    case 'cost.summary':
      return '費用を確認';
    default:
      break;
  }
  switch (domain) {
    case 'session':
    case 'run':
    case 'events':
    case 'home':
      return '状況を確認';
    case 'artifact':
    case 'workspace':
      return '成果物を確認';
    case 'schedule':
      return '定期実行を設定';
    case 'integration':
      return '変更をまとめる';
    case 'task':
    case 'orchestrator':
      return '作業を整理';
    case 'attention':
    case 'approval':
      return '出番を確認';
    case 'project':
      return 'プロジェクトを確認';
    default:
      return '操作を実行';
  }
}

/**
 * Phrase for one tool use. `spawned`: how many `session.spawn` calls the run has made so far
 * ("2 人に依頼"). Null: the call says nothing about the work (keep the previous phrase).
 */
export function nowForTool(
  toolName: string,
  input: unknown,
  ctx: { spawned?: number } = {},
): string | null {
  const method = controlMethodOf(toolName);
  if (method) return nowForMethod(method, ctx);
  const rec = asRecord(input) ?? {};
  const firstPath = toolPaths(toolName, input)[0];
  const file = firstPath ? baseName(firstPath) : undefined;
  if (EDIT_TOOLS.has(toolName)) return file ? phrase(file, ' を編集') : 'ファイルを編集';
  if (COMMAND_TOOLS.has(toolName)) {
    const cmd = asString(rec.command)?.trim();
    return cmd ? phrase(cmd, ' を実行') : 'コマンドを実行';
  }
  if (SUBAGENT_TOOLS.has(toolName)) return 'サブエージェントに依頼';
  switch (toolName) {
    case 'Read':
    case 'NotebookRead':
      return file ? phrase(file, ' を参照') : 'ファイルを参照';
    case 'LS':
      return file ? phrase(file, ' を確認') : 'フォルダを確認';
    case 'Glob':
    case 'Grep': {
      const pattern = asString(rec.pattern)?.trim();
      return pattern ? phrase(`「${pattern}`, '」を検索') : 'ファイルを検索';
    }
    case 'BashOutput':
      return 'コマンドの出力を確認';
    case 'TodoWrite':
    case 'TodoRead':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskGet':
    case 'TaskList':
    case 'TaskStop':
      return '作業計画を更新';
    case 'WebSearch': {
      const q = asString(rec.query)?.trim();
      return q ? phrase(`「${q}`, '」を検索') : 'Web を検索';
    }
    case 'WebFetch': {
      const url = asString(rec.url)?.trim();
      return url ? phrase(hostOf(url), ' を閲覧') : 'Web を閲覧';
    }
    case 'Skill':
      return 'スキルを使用';
    case 'ToolSearch':
      return null;
    default: {
      // Other MCP servers: "mcp__<server>__<tool>" → the tool's own name.
      const short = toolName.startsWith('mcp__')
        ? toolName.split('__').slice(2).join('__')
        : toolName;
      return phrase(short || toolName, ' を使用');
    }
  }
}

/** Runtime / executor boilerplate that only says the run is starting. */
const PREPARING_LINES = [
  'Claude Code を起動しました',
  'エージェントを起動中',
  '依頼内容を確認中',
  '計画を立てています',
];

/** Activity lines of `describeToolActivity` (runtime/tools.ts), read back as a tool use. */
const TOOL_LINES: [prefix: string, toPhrase: (rest: string) => string | null][] = [
  ['ファイルを編集中: ', (p) => nowForTool('Edit', { file_path: p })],
  ['ファイルを読み込み中: ', (p) => nowForTool('Read', { file_path: p })],
  ['ファイル一覧を確認中: ', (p) => nowForTool('LS', { path: p })],
  ['コマンドを実行中: ', (c) => nowForTool('Bash', { command: c })],
  ['検索中: ', (q) => nowForTool('Grep', { pattern: q })],
  ['Web を検索中: ', (q) => nowForTool('WebSearch', { query: q })],
  ['Web ページを取得中: ', (u) => nowForTool('WebFetch', { url: u })],
  ['サブエージェントに依頼中: ', () => nowForTool('Task', {})],
];

const FIXED_LINES: Record<string, string> = {
  ファイルを編集中: 'ファイルを編集',
  ファイルを読み込み中: 'ファイルを参照',
  ファイル一覧を確認中: 'フォルダを確認',
  コマンドを実行中: 'コマンドを実行',
  検索中: 'ファイルを検索',
  'Web を検索中': 'Web を検索',
  'Web ページを取得中': 'Web を閲覧',
  サブエージェントに依頼中: 'サブエージェントに依頼',
  コマンドの出力を確認中: 'コマンドの出力を確認',
  作業計画を更新中: '作業計画を更新',
  応答を生成しています: NOW_WRITING,
  作業内容をまとめています: NOW_WRITING,
  ツールの結果をもとに考えています: NOW_THINKING,
  会話を要約しています: '会話を要約中',
  変更をコミット中: '変更を記録中',
};

/**
 * Phrase for a run's activity line (`Run.activity`). Null: nothing new (cleared, or a
 * generic "running tool X" line whose tool call already set a better phrase).
 */
export function nowForActivity(text: string | null | undefined): string | null {
  const line = text?.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  if (PREPARING_LINES.includes(line)) return NOW_PREPARING;
  // Tool-loop lines ("ツールを実行しています: x"): the tool.called event came first.
  if (/^ツールを実行(しています|中): /.test(line)) return null;
  for (const [prefix, toPhrase] of TOOL_LINES) {
    if (line.startsWith(prefix)) return toPhrase(line.slice(prefix.length));
  }
  const fixed = FIXED_LINES[line];
  if (fixed) return fixed;
  if (line.startsWith('モデルの応答を待っています')) return '応答を待機中';
  return clip(line);
}
