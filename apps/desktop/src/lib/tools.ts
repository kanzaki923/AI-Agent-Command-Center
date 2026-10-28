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

export function toolCategory(name: string): ToolCategory {
  const n = name.toLowerCase();
  if (n === 'task.wait' || n.endsWith('.wait') || n === 'wait') return 'wait';
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

function countLines(s: string | null): number {
  if (!s) return 0;
  return s.split('\n').length;
}

export function describeTool(name: string, rawInput: unknown): ToolDescription {
  const input = asInput(rawInput);
  const category = toolCategory(name);
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
      return {
        ...base,
        label: `${shorten(name, 40)} を実行`,
        activity: `${shorten(name, 40)} を実行中`,
        target: null,
      };
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
