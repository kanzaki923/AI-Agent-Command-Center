import type { ToolRisk } from '@acc/protocol';
import { isInside } from './policy';
import { COMMAND_TOOLS, EDIT_TOOLS, READ_ONLY_TOOLS, asRecord, asString, toolPaths } from './tools';

/**
 * Command patterns that are hard to undo or reach outside the machine: recursive forced
 * deletion, pushing to remotes, installing from the network, downloading, privilege
 * escalation, disk-level tools. Matched case-insensitively against the whole command line.
 */
const HIGH_RISK_COMMANDS: readonly RegExp[] = [
  /\bremove-item\b(?=.*-recurse)(?=.*-force)/i,
  /\b(?:rd|rmdir)\s+\/s\b/i,
  /\bdel\s+(?:\/[a-z]\s+)*\/s\b/i,
  // git [global options, incl. "-C <dir>" / "-c <k=v>"] push | reset --hard | clean -f
  /\bgit(?:\s+(?:-[Cc]\s+\S+|-\S+))*\s+push\b/i,
  /\bgit(?:\s+(?:-[Cc]\s+\S+|-\S+))*\s+(?:reset\s+--hard|clean\s+-[a-z]*f)/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|ci|update|upgrade|dlx|x)\b/i,
  /\bnpx\s+/i,
  /\b(?:pip3?|pipx|uv\s+pip|poetry|cargo|gem|go)\s+(?:install|add|get)\b/i,
  /\b(?:apt(?:-get)?|yum|dnf|brew|choco|winget|scoop)\s+(?:install|upgrade)\b/i,
  /\b(?:curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm)\b/i,
  /\bsudo\b/i,
  /\b(?:mkfs|diskpart|format\s+[a-z]:)/i,
  /\bdd\s+if=/i,
  /\bchmod\s+-R\b/i,
];

/** `rm` with both a recursive and a force flag (rm -rf, rm -fr, rm -r -f, rm --recursive --force). */
function isForcedRecursiveRm(command: string): boolean {
  for (const m of command.matchAll(/\brm((?:\s+-{1,2}[a-z][a-z-]*)+)/gi)) {
    const flags = m[1]!;
    const recursive = /(?:^|\s)(?:-[a-z]*r[a-z]*|--recursive)(?=\s|$)/i.test(flags);
    const force = /(?:^|\s)(?:-[a-z]*f[a-z]*|--force)(?=\s|$)/i.test(flags);
    if (recursive && force) return true;
  }
  return false;
}

export function isHighRiskCommand(command: string): boolean {
  return isForcedRecursiveRm(command) || HIGH_RISK_COMMANDS.some((re) => re.test(command));
}

/**
 * Risk shown with a tool-use approval (`ToolApprovalPayload.risk`), decided by the daemon
 * from the tool and its input — never by the agent:
 * - high: destructive or outward-facing commands (rm -rf, git push, network installs …) and
 *   edits outside the workspace
 * - medium: any other command, reads outside the workspace, web access, unknown tools
 * - low: reads and edits inside the workspace
 */
export function classifyToolRisk(req: { toolName: string; input: unknown; cwd: string }): ToolRisk {
  const { toolName, input, cwd } = req;
  if (COMMAND_TOOLS.has(toolName)) {
    const rec = asRecord(input);
    const command = asString(rec?.command) ?? (typeof input === 'string' ? input : '');
    return isHighRiskCommand(command) ? 'high' : 'medium';
  }
  const isEdit = EDIT_TOOLS.has(toolName);
  if (isEdit || READ_ONLY_TOOLS.has(toolName)) {
    const outside = toolPaths(toolName, input).some((p) => !isInside(p, cwd));
    if (outside) return isEdit ? 'high' : 'medium';
    return 'low';
  }
  return 'medium';
}
