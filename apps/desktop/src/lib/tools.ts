import { isMethodName } from '@acc/protocol';
import { TASK_STATUS_LABEL } from './status';

/**
 * Human-readable descriptions of tool calls (Claude Agent SDK tools, generic shell/file
 * tools, and Control API tools used by orchestrators). One place so the activity line,
 * the chat tool blocks and the timeline say the same thing.
 */

export type ToolCategory = 'read' | 'search' | 'edit' | 'run' | 'web' | 'control' | 'wait' | 'other';

export const TOOL_CATEGORY_LABEL: Record<ToolCategory, string> = {
  read: '読み取り',
  search: '検索',
  edit: '編集',
  run: '実行',
  web: 'Web',
  control: '操作',
  wait: '待機',
  other: 'その他',
};

type Input = Record<string, unknown>;

function str(input: Input, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function asInput(input: unknown): Input {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Input) : {};
}

export function shorten(s: string, max = 60): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Strip long absolute prefixes so paths read like `src/auth/session.ts`. */
export function displayPath(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const m = /\/(src|packages|apps|docs|test|tests|lib)\/.*/.exec(norm);
  if (m) return m[0].slice(1);
  const parts = norm.split('/').filter(Boolean);
  return parts.length > 3 ? parts.slice(-3).join('/') : norm;
}

/**
 * The Control API method behind a tool name, if any: `session.spawn`, the tool-loop form
 * `session__spawn`, the Claude MCP form `mcp__acc__session__spawn` and the runtime's
 * single-underscore `mcp__acc__session_spawn`.
 */
export function controlMethod(name: string): string | null {
  let n = name;
  if (n.startsWith('mcp__')) {
    const rest = n.slice(5);
    const i = rest.indexOf('__');
    n = i === -1 ? rest : rest.slice(i + 2);
  }
  const dotted = n.replaceAll('__', '.');
  // Methods a newer daemon may add (not in this build's contract yet).
  if (isMethodName(dotted) || dotted === 'task.retry') return dotted;
  const first = n.replace('_', '.');
  return isMethodName(first) ? first : null;
}

/**
 * Calls of the session tree in the screen's words, the same as a chip's `now` (ui-redesign
 * spec §5.2, §8): `「FAQ」に依頼`, `質問「…」`, `「…」を提出`, `状況を確認`. Null when the call
 * is not one of them (files, commands, or a call with its own phrase below).
 */
export function describeControlCall(
  name: string,
  input: unknown,
  titleOf: (sessionId: string) => string | undefined = () => undefined,
): string | null {
  const method = controlMethod(name);
  if (!method) return null;
  const o = asInput(input);
  const s = (k: string) => str(o, k);
  const q = (v: string | null, max = 32) => (v ? `「${shorten(v, max)}」` : '');
  const sid = s('sessionId');
  const target = sid ? titleOf(sid) : undefined;
  switch (method) {
    case 'session.spawn':
      return `${q(s('title')) || '1 人'}に依頼`;
    case 'human.ask':
      return `質問${q(s('question'), 40)}`;
    case 'artifact.publish':
      return `${q(s('title')) || '成果物'}を提出`;
    case 'session.send':
      return target ? `「${shorten(target, 32)}」に伝える` : '伝える';
    case 'session.stop':
      return target ? `「${shorten(target, 32)}」を止める` : '止める';
    case 'session.resume':
      return target ? `「${shorten(target, 32)}」を再開` : '再開';
    case 'attention.respond':
      return '質問に回答';
    case 'artifact.review':
      return s('decision') === 'accept' ? '成果物を採用' : 'やり直しを依頼';
    case 'artifact.read':
    case 'artifact.get':
    case 'artifact.list':
      return '成果物を確認';
    case 'schedule.create':
    case 'schedule.update':
      return '繰り返しを設定';
    case 'schedule.delete':
      return '繰り返しをやめる';
    case 'cost.summary':
    case 'budget.get':
      return '費用を確認';
    case 'task.wait':
    case 'integration.wait':
      return '終わるのを待つ';
    default:
      // Reading the state of the tree, its sessions, runs...: one phrase for all.
      if (/\.(get|list|tree|messages|summary)$/.test(method) || method === 'home.get') return '状況を確認';
      return null;
  }
}

export function toolCategory(name: string): ToolCategory {
  const method = controlMethod(name);
  if (method) return method.endsWith('.wait') ? 'wait' : 'control';
  const n = name.toLowerCase();
  if (n === 'wait') return 'wait';
  if (n.includes('.')) return 'control';
  if (['read', 'read_file', 'view', 'cat', 'notebookread', 'ls', 'list_files'].includes(n))
    return 'read';
  if (['grep', 'glob', 'search', 'find', 'ripgrep', 'codebase_search'].includes(n)) return 'search';
  if (
    ['edit', 'write', 'multiedit', 'str_replace', 'str_replace_editor', 'write_file', 'apply_patch', 'notebookedit'].includes(
      n,
    )
  )
    return 'edit';
  if (['bash', 'shell', 'exec', 'run', 'terminal', 'powershell', 'run_command'].includes(n))
    return 'run';
  if (['webfetch', 'websearch', 'fetch', 'http'].includes(n)) return 'web';
  return 'other';
}

export interface ToolDescription {
  category: ToolCategory;
  /** Past/neutral form for blocks: `src/a.ts を編集` */
  label: string;
  /** Progressive form for the activity line: `src/a.ts を編集中` */
  activity: string;
  /** Command / target shown as evidence (mono). */
  target: string | null;
  additions: number | null;
  deletions: number | null;
}

/** Names the UI already knows, so a call reads `エージェントを起動: 「…」` / `「FAQ」に伝える`. */
export interface ToolLookup {
  taskTitle?: (taskId: string) => string | undefined;
  sessionTitle?: (sessionId: string) => string | undefined;
}

interface Phrase {
  label: string;
  activity: string;
}
const phrase = (label: string, activity = `${label}中`): Phrase => ({ label, activity });

function quoted(s: string | null | undefined, max = 40): string {
  return s ? `「${shorten(s, max)}」` : '';
}

/**
 * The older Control API calls in words: `作業を作成: 「認証のテスト」`, `エージェントを起動: 「…」`.
 * No Task / Worker / Run / 統合 (ui-redesign spec §0.3). The verb comes first so a column of
 * calls scans by what happened.
 */
function describeControl(method: string, input: Input, lookup: ToolLookup | undefined): Phrase {
  const title = str(input, 'title');
  const taskId = str(input, 'taskId');
  const taskName = quoted((taskId ? lookup?.taskTitle?.(taskId) : undefined) ?? title);
  const on = (s: string) => (s ? `: ${s}` : '');
  const ids = Array.isArray(input.taskIds) ? input.taskIds.length : 0;
  switch (method) {
    case 'task.create':
      return { label: `作業を作成${on(quoted(title))}`, activity: `作業を作成中${on(quoted(title))}` };
    case 'task.update': {
      const status = str(input, 'status');
      const to =
        status && status in TASK_STATUS_LABEL
          ? ` → ${TASK_STATUS_LABEL[status as keyof typeof TASK_STATUS_LABEL]}`
          : '';
      return phrase(`作業を更新${on(taskName)}${to}`);
    }
    case 'task.spawnWorker':
      return { label: `エージェントを起動${on(taskName)}`, activity: `エージェントを起動中${on(taskName)}` };
    case 'task.cancel':
      return phrase(`作業を中止${on(taskName)}`);
    case 'task.retry':
      return phrase(`やり直しを依頼${on(taskName)}`);
    case 'task.wait':
      return phrase(`終わるのを待つ${ids > 1 ? `（${ids} 件）` : ''}`, '終わるのを待つ');
    case 'task.list':
    case 'task.get':
      return phrase('状況を確認', '状況を確認');
    case 'integration.create':
      return phrase(`反映の準備${ids ? `（${ids} 件）` : ''}`);
    case 'integration.run':
      return { label: '反映（取り込みとテスト）', activity: '反映中（取り込みとテスト）' };
    case 'integration.wait':
      return phrase('終わるのを待つ', '終わるのを待つ');
    case 'integration.get':
    case 'integration.list':
      return phrase('状況を確認', '状況を確認');
    case 'orchestrator.recordDecision':
      return phrase(`判断を記録${on(quoted(str(input, 'decision'), 48))}`);
    case 'session.create':
      return phrase(`会話を作成${on(quoted(title))}`);
    case 'session.send':
      return phrase(`メッセージを送信${on(quoted(typeof input.content === 'string' ? input.content : null))}`);
    case 'session.messages':
      return phrase('会話を読み取り');
    case 'session.list':
    case 'session.get':
      return phrase('状況を確認', '状況を確認');
    case 'run.get':
    case 'run.list':
      return phrase('状況を確認', '状況を確認');
    case 'run.cancel':
      return phrase('止める', '止める');
    case 'run.retry':
      return phrase('やり直す', 'やり直す');
    case 'grant.create':
    case 'session.grantOrchestration':
      return phrase('任せる', '任せる');
    case 'grant.revoke':
      return phrase('任せるのをやめる', '任せるのをやめる');
    case 'grant.list':
      return phrase('状況を確認', '状況を確認');
    case 'budget.allocate':
      return phrase(
        `予算を配分${typeof input.limitUsd === 'number' ? ` $${input.limitUsd.toFixed(2)}` : ''}`,
      );
    case 'budget.get':
      return phrase('予算を確認');
    case 'workspace.create':
      return phrase('作業場所を作成');
    case 'workspace.diff':
      return phrase('差分を確認');
    case 'workspace.list':
    case 'workspace.get':
      return phrase('作業場所を確認');
    case 'artifact.list':
    case 'artifact.get':
      return phrase('成果物を確認');
    case 'project.list':
    case 'project.get':
      return phrase('プロジェクトを確認');
    case 'approval.list':
      return phrase('状況を確認', '状況を確認');
    case 'approval.respond':
      return phrase('承認に回答');
    case 'events.list':
      return phrase('イベントを確認');
    case 'models.list':
      return phrase('モデルを確認');
    default:
      return phrase('アプリを操作');
  }
}

/** Agent-runtime tools that are neither files nor commands (Claude Code's own tools). */
function describeOther(name: string, input: Input): Phrase {
  switch (name.toLowerCase()) {
    case 'todowrite':
      return phrase('TODO リストを更新');
    case 'task':
    case 'agent': {
      const what = quoted(str(input, 'description'));
      return phrase(`サブエージェントに依頼${what ? `: ${what}` : ''}`);
    }
    case 'exitplanmode':
      return phrase('計画を提示');
    default:
      return phrase(`${shorten(name, 40)} を実行`);
  }
}

function countLines(s: string | null): number {
  if (!s) return 0;
  return s.split('\n').length;
}

export function describeTool(
  name: string,
  rawInput: unknown,
  lookup?: ToolLookup,
): ToolDescription {
  const input = asInput(rawInput);
  const category = toolCategory(name);
  const method = controlMethod(name);
  if (method) {
    const tree = describeControlCall(name, input, lookup?.sessionTitle);
    const p = tree ? { label: tree, activity: tree } : describeControl(method, input, lookup);
    return { category, ...p, target: null, additions: null, deletions: null };
  }
  const path = str(input, 'file_path', 'path', 'filePath', 'notebook_path', 'file');
  const base = { category, additions: null, deletions: null } as const;
  switch (category) {
    case 'read': {
      const t = path ? displayPath(path) : shorten(name);
      return { ...base, label: `${t} を読み取り`, activity: `${t} を読み取り中`, target: t };
    }
    case 'search': {
      const q = str(input, 'pattern', 'query', 'q', 'glob') ?? '';
      const t = `「${shorten(q, 40)}」`;
      return { ...base, label: `${t}を検索`, activity: `${t}を検索中`, target: q || null };
    }
    case 'edit': {
      const t = path ? displayPath(path) : 'ファイル';
      const oldS = str(input, 'old_string', 'oldText');
      const newS = str(input, 'new_string', 'newText', 'content');
      const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : null;
      let add = newS ? countLines(newS) : 0;
      let del = oldS ? countLines(oldS) : 0;
      if (edits) {
        add = edits.reduce((n, e) => n + countLines(str(e, 'new_string')), 0);
        del = edits.reduce((n, e) => n + countLines(str(e, 'old_string')), 0);
      }
      return {
        category,
        label: `${t} を編集`,
        activity: `${t} を編集中`,
        target: t,
        additions: add,
        deletions: del,
      };
    }
    case 'run': {
      const cmd = str(input, 'command', 'cmd', 'script') ?? name;
      const t = shorten(cmd, 48);
      return { ...base, label: `${t} を実行`, activity: `${t} を実行中`, target: cmd };
    }
    case 'web': {
      const url = str(input, 'url', 'query') ?? name;
      const t = shorten(url, 48);
      return { ...base, label: `${t} にアクセス`, activity: `${t} にアクセス中`, target: url };
    }
    case 'wait':
      return { ...base, label: '終わるのを待つ', activity: '終わるのを待つ', target: null };
    case 'control': {
      const title = str(input, 'title', 'name');
      const t = title ? `${name}（${shorten(title, 32)}）` : name;
      return { ...base, label: `${t} を呼び出し`, activity: `${t} を呼び出し中`, target: name };
    }
    case 'other':
      return { ...base, ...describeOther(name, input), target: null };
  }
}

/** First non-empty lines of an output (error evidence: "最後のエラーの先頭 2 行"). */
export function headLines(s: string, n = 2): string {
  return s
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(0, n)
    .join('\n');
}

export function outputText(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((p) =>
        p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : JSON.stringify(p),
      )
      .join('\n');
  }
  if (typeof output === 'object' && 'text' in output) return String((output).text);
  return JSON.stringify(output, null, 2);
}
