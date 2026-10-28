import { realpathSync } from 'node:fs';
import path from 'node:path';
import { COMMAND_TOOLS, EDIT_TOOLS, READ_ONLY_TOOLS, SUBAGENT_TOOLS, toolPaths } from './tools';

export type ToolDecision = 'allow' | 'ask';

export interface ToolPolicyInput {
  toolName: string;
  input: unknown;
  /** The run's workspace (an isolated worktree). */
  cwd: string;
  /** Path the runtime itself flagged as outside its allowed directories, if any. */
  blockedPath?: string | undefined;
  /** For tests; defaults to the host platform (decides path semantics and case folding). */
  platform?: NodeJS.Platform;
  /**
   * Resolves symlinks / junctions (default: the real file system, unless `platform` is
   * given for a lexical test). Containment is decided on the resolved paths.
   */
  realpath?: (p: string) => string;
}

export interface ToolPolicyResult {
  decision: ToolDecision;
  /** English, for logs and tests. */
  reason: string;
}

/** In-process Control API tools. The dispatcher enforces capabilities on every call. */
const ACC_TOOL_PREFIX = 'mcp__acc__';

/**
 * Deterministic tool-use policy for coding agents (no prompt involved).
 *
 * - Read-only tools inside the workspace: allowed.
 * - File edits inside the workspace: allowed — the worktree is isolated and every change is
 *   reviewed as a diff before it is integrated.
 * - Commands (Bash / PowerShell): always ask, since a command can touch anything.
 * - Anything that touches a path outside the workspace: ask. Containment is checked on the
 *   real path too, so a symlink committed in the repository cannot lead an auto-allowed
 *   read or edit out of the worktree.
 * - Edits under a `.git` directory or to a worktree's `.git` file: ask. Git configuration
 *   and the gitdir pointer decide what the daemon's own git calls execute.
 * - Unknown tools (web, third-party MCP, ...): ask.
 *
 * "ask" goes to the run's approval flow (`AgentRunInput.canUseTool`).
 */
export function decideToolPermission(req: ToolPolicyInput): ToolPolicyResult {
  const { toolName, input, cwd } = req;
  const platform = req.platform ?? process.platform;
  const real = req.realpath ?? (req.platform ? undefined : realpathDeep);
  const inside = (target: string) =>
    isInside(target, cwd, platform) &&
    (!real || isInside(real(resolveFrom(cwd, target, platform)), real(cwd), platform));

  if (req.blockedPath && !inside(req.blockedPath)) {
    return { decision: 'ask', reason: `path outside workspace: ${req.blockedPath}` };
  }
  if (toolName.startsWith(ACC_TOOL_PREFIX)) {
    return { decision: 'allow', reason: 'control api tool (capabilities enforced by dispatcher)' };
  }
  if (COMMAND_TOOLS.has(toolName)) {
    return { decision: 'ask', reason: 'commands always need approval' };
  }
  if (SUBAGENT_TOOLS.has(toolName)) {
    return { decision: 'allow', reason: 'sub-agent tool uses are checked individually' };
  }

  const isRead = READ_ONLY_TOOLS.has(toolName);
  const isEdit = EDIT_TOOLS.has(toolName);
  if (!isRead && !isEdit) {
    return { decision: 'ask', reason: `unknown tool: ${toolName}` };
  }

  const paths = toolPaths(toolName, input);
  const outside = paths.find((p) => !inside(p));
  if (outside !== undefined) {
    return { decision: 'ask', reason: `path outside workspace: ${outside}` };
  }
  if (isEdit && paths.length === 0) {
    return { decision: 'ask', reason: 'edit without a target path' };
  }
  const gitPath = isEdit ? paths.find((p) => touchesGitDir(p, cwd, platform)) : undefined;
  if (gitPath !== undefined) {
    return { decision: 'ask', reason: `edit to git metadata: ${gitPath}` };
  }
  return {
    decision: 'allow',
    reason: isEdit ? 'edit inside workspace' : 'read-only inside workspace',
  };
}

/** Whether `target` (absolute, or relative to `root`) resolves to `root` or below it. */
export function isInside(
  target: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  // "~" is expanded by shells and tools, never by path.resolve: treat it as outside.
  if (target.startsWith('~')) return false;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const fold = (s: string) => (platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s);
  const absRoot = p.resolve(root);
  const absTarget = p.resolve(absRoot, target);
  const rel = p.relative(fold(absRoot), fold(absTarget));
  const goesUp = rel === '..' || rel.startsWith(`..${p.sep}`);
  return rel === '' || (!goesUp && !p.isAbsolute(rel));
}

function resolveFrom(root: string, target: string, platform: NodeJS.Platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.resolve(p.resolve(root), target);
}

/** Whether any component of `target` (relative to `root`) is `.git` (case-folded where the FS is). */
export function touchesGitDir(
  target: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const rel = p.relative(p.resolve(root), resolveFrom(root, target, platform));
  const fold = platform === 'win32' || platform === 'darwin';
  return (
    rel
      .split(/[\\/]+/)
      // Windows ignores trailing dots and spaces in names (".git." is ".git").
      .map((c) => (platform === 'win32' ? c.replace(/[. ]+$/, '') : c))
      .some((c) => (fold ? c.toLowerCase() : c) === '.git')
  );
}

/**
 * `realpath` that also works for paths that do not exist yet: the deepest existing ancestor
 * is resolved (following symlinks / junctions) and the missing segments are appended.
 */
export function realpathDeep(target: string): string {
  const missing: string[] = [];
  let cur = path.resolve(target);
  for (;;) {
    try {
      return path.join(realpathSync.native(cur), ...missing.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(target);
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}
