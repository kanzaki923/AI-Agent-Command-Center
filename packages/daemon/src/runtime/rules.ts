import path from 'node:path';
import {
  type Actor,
  type Approval,
  type ApprovalRemember,
  PermissionRule,
  ToolApprovalPayload,
} from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { forbidden, invalidParams } from '../core/errors';
import { EntityRepo } from '../core/repo';
import type { Migration } from '../core/migrations';
import { parseShell } from './shell';
import { COMMAND_TOOLS, asRecord, asString, displayPath, toolPaths, truncate } from './tools';
import { isInside } from './policy';
import type { RememberedMatch } from './gate';

/**
 * Remembered tool approvals ("この Run / この Task / このプロジェクトでは許可"): a human
 * approves a tool use with `approval.respond({ remember })` and later uses that match are
 * allowed without asking (gate.ts, below the hard rules: a remembered approval never
 * overrides them). Stored in the daemon's DB, never in the agent CLI's settings files.
 */
export const ruleMigrations: Migration[] = [
  {
    id: 'runtime/0002_permission_rules',
    sql: `
CREATE TABLE permission_rules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX permission_rules_project ON permission_rules(project_id, revoked_at);
`,
  },
];

/** Programs whose first word after the program is a subcommand that matters ("git commit"). */
const SUBCOMMAND_PROGRAMS = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'bunx',
  'cargo',
  'go',
  'pip',
  'pip3',
  'uv',
  'poetry',
  'docker',
  'podman',
  'gh',
  'dotnet',
  'deno',
  'gem',
  'bundle',
  'composer',
  'kubectl',
  'make',
]);

/**
 * Interpreters: the program says nothing about what runs, so a rule names the script too
 * ("node scripts/test.js"). Inline code (`node -e`, `python -c`) is never remembered.
 */
const INTERPRETERS = new Set([
  'node',
  'python',
  'python3',
  'py',
  'ruby',
  'perl',
  'php',
  'bash',
  'sh',
  'zsh',
  'pwsh',
  'powershell',
  'tsx',
  'ts-node',
]);

function programName(word: string): string {
  return word
    .replace(/^.*[\\/]/, '')
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1|com)$/, '');
}

/**
 * Keys of a command line for matching: program (+ subcommand) of every part, substitutions
 * included ("pnpm add", "curl"). Null when the command cannot be read for sure.
 */
export function commandKeys(
  command: string,
  dialect: 'posix' | 'powershell' = 'posix',
): string[] | null {
  const keys = new Set<string>();
  const visit = (text: string, depth: number): boolean => {
    if (depth > 3) return false;
    const parsed = parseShell(text, dialect);
    if (!parsed.complete) return false;
    for (const c of parsed.commands) {
      if (c.argv.length > 0) {
        const prog = programName(c.argv[0]!);
        const args = c.argv.slice(1);
        if (INTERPRETERS.has(prog)) {
          // Flags before the script may run or load other code (`-e`, `-c`, `--require`):
          // only "<interpreter> <script>" is generalized.
          const script = args[0];
          if (!script || script.startsWith('-')) return false;
          keys.add(`${prog} ${script.replace(/\\/g, '/')}`);
        } else {
          const sub = args.find((a) => !a.startsWith('-'));
          keys.add(SUBCOMMAND_PROGRAMS.has(prog) && sub ? `${prog} ${sub}` : prog);
        }
      }
      for (const s of c.substitutions) if (!visit(s, depth + 1)) return false;
    }
    return true;
  };
  if (!visit(command, 0) || keys.size === 0) return null;
  return [...keys].sort();
}

/** What a rule remembers from an approved tool use (null: nothing safe to generalize). */
export function ruleMatcher(
  toolName: string,
  input: unknown,
  cwd: string | null,
): Pick<PermissionRule, 'toolName' | 'commandKeys' | 'pathPrefix' | 'description'> | null {
  if (COMMAND_TOOLS.has(toolName)) {
    const command = asString(asRecord(input)?.command);
    const keys = command
      ? commandKeys(command, toolName === 'PowerShell' ? 'powershell' : 'posix')
      : null;
    if (!keys) return null;
    return {
      toolName,
      commandKeys: keys,
      pathPrefix: null,
      description: `コマンド「${keys.join('」「')}」を許可`,
    };
  }
  const paths = toolPaths(toolName, input);
  if (paths.length > 0 && cwd) {
    const abs = path.resolve(cwd, paths[0]!);
    if (!isInside(abs, cwd)) {
      const dir = path.dirname(abs);
      return {
        toolName,
        commandKeys: null,
        pathPrefix: dir,
        description: `${toolName} で ${truncate(displayPath(dir, cwd), 80)} 以下を許可`,
      };
    }
  }
  return {
    toolName,
    commandKeys: null,
    pathPrefix: null,
    description: `ツール「${toolName}」を許可`,
  };
}

export function ruleMatches(
  rule: Pick<PermissionRule, 'toolName' | 'commandKeys' | 'pathPrefix'>,
  toolName: string,
  input: unknown,
  cwd: string,
): boolean {
  if (rule.toolName !== toolName) return false;
  if (rule.commandKeys) {
    const command = asString(asRecord(input)?.command);
    const keys = command
      ? commandKeys(command, toolName === 'PowerShell' ? 'powershell' : 'posix')
      : null;
    if (!keys) return false;
    const allowed = new Set(rule.commandKeys);
    return keys.every((k) => allowed.has(k));
  }
  if (rule.pathPrefix) {
    const paths = toolPaths(toolName, input);
    return paths.length > 0 && paths.every((p) => isInside(path.resolve(cwd, p), rule.pathPrefix!));
  }
  return true;
}

/** `ctx.service('permissionRules')` (runtime module). */
export class PermissionRuleService {
  readonly repo: EntityRepo<PermissionRule>;

  constructor(private readonly ctx: DaemonContext) {
    this.repo = new EntityRepo<PermissionRule>(ctx.db, {
      table: 'permission_rules',
      kind: 'permission rule',
      schema: PermissionRule,
      columns: {
        project_id: (r) => r.projectId,
        scope: (r) => r.scope,
        revoked_at: (r) => r.revokedAt,
        created_at: (r) => r.createdAt,
      },
    });
  }

  /** Active rules that apply to a run of `projectId` (its own run / task / the project). */
  active(scope: { projectId: string; runId: string; taskId: string | null }): PermissionRule[] {
    return this.repo
      .find({ where: { project_id: scope.projectId, revoked_at: null }, direction: 'asc' })
      .filter(
        (r) =>
          r.scope === 'project' ||
          (r.scope === 'run' && r.runId === scope.runId) ||
          (r.scope === 'task' && scope.taskId !== null && r.taskId === scope.taskId),
      );
  }

  /** The matcher a run's gate uses (reads the DB on every check, so revocations apply at once). */
  matcher(scope: { projectId: string; runId: string; taskId: string | null }, cwd: string) {
    return (toolName: string, input: unknown): RememberedMatch | null => {
      const rule = this.active(scope).find((r) => ruleMatches(r, toolName, input, cwd));
      return rule ? { id: rule.id, description: rule.description } : null;
    };
  }

  /**
   * Remember an approved tool use (inside the approval.respond transaction). Humans only:
   * an agent with approval rights must not widen what other agents may do.
   */
  rememberFromApproval(
    approval: Approval,
    remember: ApprovalRemember,
    actor: Actor,
  ): PermissionRule | null {
    if (remember === 'once') return null;
    if (actor.kind !== 'human') throw forbidden('許可を覚えさせられるのは人間だけです');
    if (approval.kind !== 'tool_use') {
      throw invalidParams('覚えられるのはツールの承認だけです', { kind: approval.kind });
    }
    const payload = ToolApprovalPayload.safeParse(approval.payload);
    if (!payload.success || !approval.projectId) {
      throw invalidParams('この承認からは許可を覚えられません');
    }
    if (remember === 'task' && !approval.taskId) {
      throw invalidParams('Task のない実行なので、Task 単位では覚えられません');
    }
    const cwd = this.workspacePath(approval.runId);
    const m = ruleMatcher(payload.data.toolName, payload.data.input, cwd);
    if (!m) throw invalidParams('このコマンドは形を確かめられないため、覚えられません');
    const { ctx } = this;
    const rule = this.repo.insert({
      id: ctx.ids.next('permissionRule'),
      projectId: approval.projectId,
      scope: remember,
      runId: remember === 'run' ? approval.runId : null,
      taskId: remember === 'task' ? approval.taskId : null,
      ...m,
      approvalId: approval.id,
      createdBy: actor,
      createdAt: ctx.clock.iso(),
      revokedAt: null,
      revokedBy: null,
    });
    ctx.bus.emit({
      type: 'permission.rule_created',
      actor,
      payload: { rule },
      refs: {
        projectId: rule.projectId,
        runId: approval.runId,
        taskId: approval.taskId,
        sessionId: approval.sessionId,
      },
    });
    return rule;
  }

  revoke(ruleId: string, actor: Actor): PermissionRule {
    const { ctx } = this;
    return ctx.db.transaction(() => {
      const cur = this.repo.require(ruleId);
      if (cur.revokedAt) return cur;
      const rule = this.repo.update(ruleId, (r) => ({
        ...r,
        revokedAt: ctx.clock.iso(),
        revokedBy: actor,
      }));
      ctx.bus.emit({
        type: 'permission.rule_revoked',
        actor,
        payload: { rule },
        refs: { projectId: rule.projectId },
      });
      return rule;
    });
  }

  private workspacePath(runId: string | null): string | null {
    if (!runId) return null;
    const run = this.ctx.repos.runs.get(runId);
    const wsId = run?.workspaceId;
    return wsId ? (this.ctx.repos.workspaces.get(wsId)?.path ?? null) : null;
  }
}
