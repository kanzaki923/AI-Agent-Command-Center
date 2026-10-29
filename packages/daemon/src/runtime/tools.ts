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

/**
 * The agent's own bookkeeping (its task list, deferred-tool search, skill instructions): no
 * effect outside the agent's context, so no approval. What a skill then does is checked tool
 * by tool.
 */
export const AGENT_INTERNAL_TOOLS: ReadonlySet<string> = new Set([
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TaskStop',
  'ToolSearch',
  'Skill',
]);

/**
 * Claude Code tools that do not fit an unattended run in a worktree the daemon owns, removed
 * from the model's tool list (`disallowedTools`) and denied by the policy if called anyway.
 * Observed against the real CLI (docs/snapshot/20261029_agent-sdk-real-cli.md): most of these
 * run without a permission prompt.
 * - AskUserQuestion: nobody answers mid-turn (the CLI reports "did not answer").
 * - EnterPlanMode / ExitPlanMode: plan mode would stop the run waiting for a plan approval.
 * - EnterWorktree / ExitWorktree: moves the session into its own worktree, out of ours.
 * - CronCreate / CronDelete / CronList / ScheduleWakeup / RemoteTrigger: scheduling belongs
 *   to the daemon; the CLI process ends with the run.
 * - Monitor / PushNotification: background command watches and notifications (Monitor runs a
 *   shell command without any permission prompt).
 */
export const DISALLOWED_AGENT_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
  'Monitor',
  'PushNotification',
]);

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
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskGet':
    case 'TaskList':
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

/** Longest command / pattern / path shown in an approval title. */
const TITLE_PART_MAX = 60;

/** A path for a title: the end is what identifies it ("…/src/faq.md"). */
function titlePath(p: string, cwd: string | undefined): string {
  const shown = cwd ? displayPath(p, cwd) : p;
  const flat = shown.replace(/\s+/g, ' ').trim();
  return flat.length <= TITLE_PART_MAX ? flat : `…${flat.slice(-(TITLE_PART_MAX - 1))}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * Japanese approval title for a tool use: one noun phrase naming what will happen
 * ("pnpm add zod を実行", "faq.md を編集"), never a question (spec 20261029 §3.6). The
 * choices (許可 / 拒否) carry the decision. Without the input it names the kind of use.
 */
export function approvalTitleFor(toolName: string, input?: unknown, cwd?: string): string {
  const rec = asRecord(input) ?? {};
  const firstPath = toolPaths(toolName, input)[0];
  if (COMMAND_TOOLS.has(toolName)) {
    const cmd = asString(rec.command);
    return cmd ? `${truncate(cmd, TITLE_PART_MAX)} を実行` : 'コマンドを実行';
  }
  if (EDIT_TOOLS.has(toolName)) {
    return firstPath ? `${titlePath(firstPath, cwd)} を編集` : 'ファイルを編集';
  }
  if (toolName === 'Glob' || toolName === 'Grep') {
    const pattern = asString(rec.pattern);
    return pattern ? `「${truncate(pattern, TITLE_PART_MAX)}」を検索` : 'ファイルを検索';
  }
  if (READ_ONLY_TOOLS.has(toolName)) {
    return firstPath ? `${titlePath(firstPath, cwd)} を参照` : 'ファイルを参照';
  }
  if (toolName === 'WebFetch') {
    const url = asString(rec.url);
    return url ? `${truncate(hostOf(url), TITLE_PART_MAX)} を閲覧` : 'Web ページを閲覧';
  }
  if (toolName === 'WebSearch') {
    const q = asString(rec.query);
    return q ? `「${truncate(q, TITLE_PART_MAX)}」を Web で検索` : 'Web を検索';
  }
  return `ツール「${truncate(toolName, TITLE_PART_MAX)}」を使用`;
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
