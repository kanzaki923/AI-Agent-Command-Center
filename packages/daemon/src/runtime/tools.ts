import path from 'node:path';

/**
 * Tool vocabulary shared by every runtime: which tools are read-only / edit files /
 * run commands, how to describe a tool use in one Japanese line (Command Mode activity),
 * and how to title an approval for it. Names follow Claude Code's built-in tools; other
 * runtimes map their tools onto these names.
 */

/** Tools that only read the workspace. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'BashOutput',
  'TodoWrite',
  'TodoRead',
]);

/** Tools that create or modify files. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
]);

/** Tools that execute arbitrary commands. */
export const COMMAND_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);

/** Tools that reach the network. */
export const WEB_TOOLS: ReadonlySet<string> = new Set(['WebFetch', 'WebSearch']);

/**
 * Sub-agent launchers. The sub-agent's own tool uses are checked one by one, so starting
 * one needs no approval.
 */
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Path-like inputs of a tool call (file_path, path, notebook_path, absolute glob patterns). */
export function toolPaths(toolName: string, input: unknown): string[] {
  const rec = asRecord(input);
  if (!rec) return [];
  const out: string[] = [];
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const v = asString(rec[key]);
    if (v) out.push(v);
  }
  if (toolName === 'Glob') {
    const pattern = asString(rec.pattern);
    // A relative pattern is resolved against `path` (or cwd); an absolute one names its own root.
    if (pattern && (path.isAbsolute(pattern) || path.win32.isAbsolute(pattern))) {
      out.push(globRoot(pattern));
    }
  }
  return out;
}

/** Longest leading part of a glob pattern without wildcards. */
function globRoot(pattern: string): string {
  const parts = pattern.split(/[\\/]/);
  const fixed: string[] = [];
  for (const p of parts) {
    if (/[*?[\]{}]/.test(p)) break;
    fixed.push(p);
  }
  return fixed.join('/') || '/';
}

export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/** Display a path relative to the workspace when it is inside it. */
export function displayPath(p: string, cwd: string): string {
  const abs = path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return p;
}

/** One-line Japanese description of what a tool use is doing (shown in Command Mode). */
export function describeToolActivity(toolName: string, input: unknown, cwd: string): string {
  const rec = asRecord(input) ?? {};
  const firstPath = toolPaths(toolName, input)[0];
  const shownPath = firstPath ? displayPath(firstPath, cwd) : undefined;
  if (EDIT_TOOLS.has(toolName)) {
    return shownPath ? `ファイルを編集中: ${shownPath}` : 'ファイルを編集中';
  }
  if (COMMAND_TOOLS.has(toolName)) {
    const cmd = asString(rec.command);
    return cmd ? `コマンドを実行中: ${truncate(cmd, 60)}` : 'コマンドを実行中';
  }
  switch (toolName) {
    case 'Read':
    case 'NotebookRead':
      return shownPath ? `ファイルを読み込み中: ${shownPath}` : 'ファイルを読み込み中';
    case 'Glob':
    case 'Grep': {
      const pattern = asString(rec.pattern);
      return pattern ? `検索中: ${truncate(pattern, 60)}` : '検索中';
    }
    case 'LS':
      return shownPath ? `ファイル一覧を確認中: ${shownPath}` : 'ファイル一覧を確認中';
    case 'BashOutput':
      return 'コマンドの出力を確認中';
    case 'TodoWrite':
    case 'TodoRead':
      return '作業計画を更新中';
    case 'WebFetch': {
      const url = asString(rec.url);
      return url ? `Web ページを取得中: ${truncate(url, 60)}` : 'Web ページを取得中';
    }
    case 'WebSearch': {
      const q = asString(rec.query);
      return q ? `Web を検索中: ${truncate(q, 60)}` : 'Web を検索中';
    }
    case 'Task':
    case 'Agent': {
      const d = asString(rec.description);
      return d ? `サブエージェントに依頼中: ${truncate(d, 60)}` : 'サブエージェントに依頼中';
    }
    default:
      return `ツールを実行中: ${toolName}`;
  }
}

/** Japanese approval title for a tool use (the question the human answers). */
export function approvalTitleFor(toolName: string): string {
  if (COMMAND_TOOLS.has(toolName)) return 'コマンドの実行を承認しますか';
  if (EDIT_TOOLS.has(toolName)) return 'ファイルの変更を承認しますか';
  if (READ_ONLY_TOOLS.has(toolName)) return 'ファイルの読み込みを承認しますか';
  if (WEB_TOOLS.has(toolName)) return 'Web へのアクセスを承認しますか';
  return `ツール「${toolName}」の使用を承認しますか`;
}

/** Short detail line for an approval: the command, path or URL the tool will touch. */
export function approvalDetailFor(toolName: string, input: unknown, cwd: string): string | null {
  const rec = asRecord(input) ?? {};
  const cmd = asString(rec.command);
  if (cmd) return truncate(cmd, 500);
  const p = toolPaths(toolName, input)[0];
  if (p) return displayPath(p, cwd);
  const url = asString(rec.url);
  if (url) return truncate(url, 500);
  return null;
}
