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
 * The Control API method behind a tool name, if any. Orchestrator tools carry the method
 * name (`task.create`), LLM tool names replace the dot (`task__create`) and the Claude
 * runtime prefixes its MCP server (`mcp__acc__task__create`).
 */
export function controlMethod(name: string): string | null {
  let n = name;
  if (n.startsWith('mcp__')) {
    const rest = n.slice(5);
    const i = rest.indexOf('__');
    n = i === -1 ? rest : rest.slice(i + 2);
  }
  n = n.replaceAll('__', '.');
  // Methods a newer daemon may add (not in this build's contract yet).
  return isMethodName(n) || n === 'task.retry' ? n : null;
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

/** Names the UI already knows (task titles), so a call reads `Worker を起動: 「…」`. */
export interface ToolLookup {
  taskTitle?: (taskId: string) => string | undefined;
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
 * Control API calls in words: `Task を作成: 「認証のテスト」`, `Worker を起動: 「…」`.
 * The verb comes first so a column of calls scans by what happened.
 */
function describeControl(method: string, input: Input, lookup: ToolLookup | undefined): Phrase {
  const title = str(input, 'title');
  const taskId = str(input, 'taskId');
  const taskName = quoted((taskId ? lookup?.taskTitle?.(taskId) : undefined) ?? title);
  const on = (s: string) => (s ? `: ${s}` : '');
  const ids = Array.isArray(input.taskIds) ? input.taskIds.length : 0;
  switch (method) {
    case 'task.create':
      return { label: `Task を作成${on(quoted(title))}`, activity: `Task を作成中${on(quoted(title))}` };
    case 'task.update': {
      const status = str(input, 'status');
      const to =
        status && status in TASK_STATUS_LABEL
          ? ` → ${TASK_STATUS_LABEL[status as keyof typeof TASK_STATUS_LABEL]}`
          : '';
      return phrase(`Task を更新${on(taskName)}${to}`);
    }
    case 'task.spawnWorker':
      return { label: `Worker を起動${on(taskName)}`, activity: `Worker を起動中${on(taskName)}` };
    case 'task.cancel':
      return phrase(`Task を中止${on(taskName)}`);
    case 'task.retry':
      return phrase(`Worker に差し戻し${on(taskName)}`);
    case 'task.wait':
      return {
        label: `Worker の完了を待機${ids > 1 ? `（${ids} 件）` : ''}`,
        activity: 'Worker の完了を待機中',
      };
    case 'task.list':
    case 'task.get':
      return phrase('Task の状態を確認');
    case 'integration.create':
      return phrase(`統合候補を作成${ids ? `（${ids} 件の Task）` : ''}`);
    case 'integration.run':
      return { label: '統合を実行（マージとテスト）', activity: '統合を実行中（マージとテスト）' };
    case 'integration.wait':
      return { label: '統合の完了を待機', activity: '統合の完了を待機中' };
    case 'integration.get':
    case 'integration.list':
      return phrase('統合の状態を確認');
    case 'orchestrator.recordDecision':
      return phrase(`判断を記録${on(quoted(str(input, 'decision'), 48))}`);
    case 'session.create':
      return phrase(`セッションを作成${on(quoted(title))}`);
    case 'session.send':
      return phrase(`メッセージを送信${on(quoted(typeof input.content === 'string' ? input.content : null))}`);
    case 'session.messages':
      return phrase('会話を読み取り');
    case 'session.list':
    case 'session.get':
      return phrase('セッションを確認');
    case 'run.get':
    case 'run.list':
      return phrase('Run の状態を確認');
    case 'run.cancel':
      return phrase('Run を停止');
    case 'run.retry':
      return phrase('Run を再試行');
    case 'grant.create':
    case 'session.grantOrchestration':
      return phrase('権限を付与');
    case 'grant.revoke':
      return phrase('権限を取り消し');
    case 'grant.list':
      return phrase('権限を確認');
    case 'budget.allocate':
      return phrase(
        `予算を配分${typeof input.limitUsd === 'number' ? ` $${input.limitUsd.toFixed(2)}` : ''}`,
      );
    case 'budget.get':
      return phrase('予算を確認');
    case 'workspace.create':
      return phrase('worktree を作成');
    case 'workspace.diff':
      return phrase('差分を確認');
    case 'workspace.list':
    case 'workspace.get':
      return phrase('worktree を確認');
    case 'artifact.list':
    case 'artifact.get':
      return phrase('成果物を確認');
    case 'project.list':
    case 'project.get':
      return phrase('プロジェクトを確認');
    case 'approval.list':
      return phrase('承認待ちを確認');
    case 'approval.respond':
      return phrase('承認に回答');
    case 'events.list':
      return phrase('イベントを確認');
    case 'models.list':
      return phrase('モデルを確認');
    default:
      return phrase(`${method} を呼び出し`);
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
    const p = describeControl(method, input, lookup);
    return { category, ...p, target: method, additions: null, deletions: null };
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
      return {
        ...base,
        label: 'Worker の完了を待機',
        activity: 'Worker の完了を待機中',
        target: null,
      };
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
