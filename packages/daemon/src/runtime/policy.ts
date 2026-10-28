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
 * - Anything that touches a path outside the workspace: ask.
 * - Unknown tools (web, third-party MCP, ...): ask.
 *
 * "ask" goes to the run's approval flow (`AgentRunInput.canUseTool`).
 */
export function decideToolPermission(req: ToolPolicyInput): ToolPolicyResult {
  const { toolName, input, cwd } = req;
  const platform = req.platform ?? process.platform;

  if (req.blockedPath && !isInside(req.blockedPath, cwd, platform)) {
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
  const outside = paths.find((p) => !isInside(p, cwd, platform));
  if (outside !== undefined) {
    return { decision: 'ask', reason: `path outside workspace: ${outside}` };
  }
  if (isEdit && paths.length === 0) {
    return { decision: 'ask', reason: 'edit without a target path' };
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
