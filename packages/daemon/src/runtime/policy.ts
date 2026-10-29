import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { PermissionProfile } from '@acc/protocol';
import {
  type CommandCategory,
  type HardRule,
  analyzeCommand,
  isClaudeSettings,
  topCategory,
} from './commandPolicy';
import {
  AGENT_INTERNAL_TOOLS,
  COMMAND_TOOLS,
  DISALLOWED_AGENT_TOOLS,
  EDIT_TOOLS,
  READ_ONLY_TOOLS,
  SUBAGENT_TOOLS,
  WEB_TOOLS,
  asRecord,
  asString,
  toolPaths,
} from './tools';

export type ToolDecision = 'allow' | 'ask' | 'deny';

/** What kind of tool use it is (the profile decides each kind; architecture.md §2.10). */
export type ToolCategory =
  | CommandCategory
  | 'read'
  | 'edit'
  | 'agent_internal'
  | 'control_api'
  | 'subagent'
  | 'unknown_tool';

/** Rules that deny in every profile. `unattended`: tools that make no sense without a human. */
export type DenyRule = HardRule | 'unattended';

export interface ToolPolicyInput {
  toolName: string;
  input: unknown;
  /** The run's workspace (an isolated worktree). */
  cwd: string;
  /** Path the runtime itself flagged as outside its allowed directories, if any. */
  blockedPath?: string | undefined;
  /** The gray zone's answers. Default `careful` (the safest; runs pass the project's). */
  profile?: PermissionProfile | undefined;
  /**
   * Daemon data that agents must never touch (ACC_HOME: the token, the DB, other worktrees).
   * The workspace itself may live under it.
   */
  protectedPaths?: readonly string[] | undefined;
  /**
   * Outside paths that are fine to use (default none: not even the shared OS temp dir, which
   * holds other programs' files; agents keep temporary files in their worktree).
   */
  allowedOutside?: readonly string[] | undefined;
  /**
   * Folders the agent may read but not write (the project's folder / repository): reads
   * inside them count as reads inside the workspace; writes are still `outside_write`.
   * Credentials inside them stay off limits. Roots holding the daemon's data are ignored.
   */
  readRoots?: readonly string[] | undefined;
  /** Control API port: commands naming it on a loopback address are denied. */
  daemonPort?: number | undefined;
  /** For tests; defaults to the host platform (decides path semantics and case folding). */
  platform?: NodeJS.Platform;
  /**
   * Resolves symlinks / junctions (default: the real file system, unless `platform` is
   * given for a lexical test). Containment is decided on the resolved paths.
   */
  realpath?: (p: string) => string;
  /** Whether a path exists (default: the real file system, unless `platform` is given). */
  exists?: (p: string) => boolean;
}

export interface ToolPolicyResult {
  decision: ToolDecision;
  /** English, for logs and tests. */
  reason: string;
  category: ToolCategory;
  /** The rule that denied it in every profile, else null (a gray-zone decision). */
  rule: DenyRule | null;
  /** What the agent is told when it is denied (Japanese, then English); null otherwise. */
  message: string | null;
  /** Japanese reason for the timeline and approval cards. */
  reasonJa: string;
}

/** In-process Control API tools. The dispatcher enforces capabilities on every call. */
const ACC_TOOL_PREFIX = 'mcp__acc__';

/**
 * The gray zone per profile: [careful, standard, autonomous]. Hard rules come first and are
 * the same in every profile; then this table. "ask" goes to a human, "deny" returns a reason
 * to the agent (the autonomous profile never asks).
 */
const GRAY: Record<ToolCategory, readonly [ToolDecision, ToolDecision, ToolDecision]> = {
  read: ['allow', 'allow', 'allow'],
  edit: ['allow', 'allow', 'allow'],
  command_readonly: ['allow', 'allow', 'allow'],
  agent_internal: ['allow', 'allow', 'allow'],
  control_api: ['allow', 'allow', 'allow'],
  subagent: ['allow', 'allow', 'allow'],
  git_local: ['ask', 'allow', 'allow'],
  build_test: ['ask', 'allow', 'allow'],
  deps_install: ['ask', 'allow', 'allow'],
  network_read: ['ask', 'allow', 'allow'],
  command_other: ['ask', 'allow', 'allow'],
  deps_add: ['ask', 'ask', 'allow'],
  outside_read: ['ask', 'ask', 'deny'],
  unknown_tool: ['ask', 'ask', 'deny'],
};
const PROFILE_INDEX: Record<PermissionProfile, 0 | 1 | 2> = {
  careful: 0,
  standard: 1,
  autonomous: 2,
};

export function grayDecision(category: ToolCategory, profile: PermissionProfile): ToolDecision {
  return GRAY[category][PROFILE_INDEX[profile]];
}

/** Routine kinds: counted, but not recorded one by one (they would flood the timeline). */
export const ROUTINE_CATEGORIES: ReadonlySet<ToolCategory> = new Set([
  'read',
  'edit',
  'command_readonly',
  'agent_internal',
  'control_api',
  'subagent',
]);

/** Kinds worth a look afterwards even when allowed. */
export const NOTABLE_CATEGORIES: ReadonlySet<ToolCategory> = new Set([
  'deps_add',
  'network_read',
  'outside_read',
]);

const RULE_TEXT: Record<DenyRule, { ja: string; en: string }> = {
  git_metadata: {
    ja: 'git のメタデータ（.git、git の設定・ref・worktree）は変更できません。worktree の git はデーモンが管理しています。ファイルだけを変更すれば、終了時にデーモンがコミットします。',
    en: 'Git metadata (.git, git config, refs, worktrees) is managed by the daemon. Change only the working files; the daemon commits them when you finish.',
  },
  outside_write: {
    ja: 'この worktree の外には書き込めません。作業（一時ファイルも）はこのディレクトリの中で行ってください。',
    en: 'Writing outside this worktree is not allowed. Keep all work, temporary files included, inside the current directory.',
  },
  credentials: {
    ja: '資格情報やデーモンのデータ（~/.ssh、~/.aws、~/.claude、gh の認証、ACC のデータディレクトリや他の worktree など）にはアクセスできません。',
    en: 'Credentials and daemon data (~/.ssh, ~/.aws, ~/.claude, gh auth, the ACC data directory and other worktrees) are off limits.',
  },
  publish_remote: {
    ja: 'push・公開・リモートの変更はできません。変更はこの worktree でコミットして終えれば、デーモンの Integration が人間の承認後に反映します。',
    en: 'Pushing, publishing and changing remotes are not allowed. Leave your changes in this worktree and finish; the daemon integrates them after a human approves.',
  },
  branch: {
    ja: '別のブランチへの切り替えや、ブランチの削除・改名はできません。今のブランチのまま作業してください。',
    en: 'Switching, deleting or renaming branches is not allowed. Keep working on the current branch.',
  },
  network_send: {
    ja: '外部へデータを送る通信（POST・アップロード・ssh・scp など）はできません。読み取りだけの通信は使えます。',
    en: 'Sending data out (POST, uploads, ssh, scp, ...) is not allowed. Read-only network access is fine.',
  },
  system: {
    ja: 'システムの設定変更、グローバルなインストール、Run の外に残るプロセス（バックグラウンド実行・常駐・コンテナ・サービス）、他のプロセスの停止はできません。フォアグラウンドで実行するか、必要な手順として最終報告に書いてください。',
    en: 'System changes, global installs, processes that outlive the run (background jobs, daemons, containers, services) and stopping other processes are not allowed. Run it in the foreground, or list it as a required step in your final message.',
  },
  self_escalation: {
    ja: '別のエージェント CLI の起動や、デーモンの Control API・エージェントの設定への直接アクセスはできません。Control API は用意された acc ツールから使ってください。',
    en: "Starting another agent CLI, or reaching the daemon's Control API or agent settings directly, is not allowed. Use the provided acc tools for the Control API.",
  },
  download_exec: {
    ja: 'ダウンロードしたスクリプトをそのまま実行することはできません。依存はマニフェスト（package.json など）から入れてください。',
    en: 'Running a downloaded script directly is not allowed. Install dependencies from the manifest (package.json, ...).',
  },
  opaque: {
    ja: '中身を確かめられない形のコマンド（エンコードされたコマンド、深い入れ子、環境変数や git の設定で別のコマンドを走らせる書き方など）は実行できません。普通の形で書いてください。',
    en: 'Commands whose real effect cannot be checked (encoded commands, deep nesting, or smuggling another command through an environment variable or git config) are not allowed. Write the command plainly.',
  },
  unattended: {
    ja: 'このツールはこの環境では使えません。人間は途中で回答しません。妥当な仮定を置いて自律的に進め、仮定は最終報告に書いてください。',
    en: 'This tool is not available in this environment. Work autonomously: make reasonable assumptions, state them in your final message, and finish the task.',
  },
};

const GRAY_DENY_TEXT: Partial<Record<ToolCategory, { ja: string; en: string }>> = {
  outside_read: {
    ja: 'この worktree の外のファイルは読めません。必要な情報はこのリポジトリの中から探すか、読めなかったことを最終報告に書いてください。',
    en: 'Reading outside this worktree is not allowed in this project. Find what you need inside the repository, or say in your final message what you could not read.',
  },
  unknown_tool: {
    ja: 'このプロジェクトでは、このツールは自動では使えません。用意されたツール（読み書き・コマンド）で進めるか、必要だったことを最終報告に書いてください。',
    en: 'This tool is not available automatically in this project. Continue with the standard tools, or say in your final message what you needed.',
  },
};

/** The message an agent gets for a denial (Japanese for the user's logs, English for the model). */
export function denialMessage(text: { ja: string; en: string }, detail?: string): string {
  return `[AI Agent Command Center] ${text.ja}${detail ? `（${detail}）` : ''}\n${text.en}`;
}

export function ruleText(rule: DenyRule): { ja: string; en: string } {
  return RULE_TEXT[rule];
}

const CATEGORY_JA: Record<ToolCategory, string> = {
  read: '読み取り',
  edit: '編集',
  command_readonly: '読み取りだけのコマンド',
  agent_internal: 'エージェントの作業管理',
  control_api: 'Control API',
  subagent: 'サブエージェント',
  git_local: 'ローカルの git 操作',
  build_test: 'テスト・ビルド',
  deps_install: '依存のインストール',
  network_read: 'ネットワークの読み取り',
  command_other: 'コマンド',
  deps_add: '新しい依存の追加',
  outside_read: 'worktree の外の読み取り',
  unknown_tool: '未知のツール',
};

export function categoryJa(c: ToolCategory): string {
  return CATEGORY_JA[c];
}

/**
 * Deterministic tool-use policy for coding agents (no prompt involved), in layers:
 *
 * 1. Hard rules, denied in every profile with a reason the agent can act on: tools that do
 *    not fit an unattended run (`DISALLOWED_AGENT_TOOLS`), git metadata, writes outside the
 *    worktree, credentials and daemon data, push / publish / remotes, switching branches,
 *    sending data out, system changes and processes that outlive the run, other agent CLIs
 *    and the Control API port, download-and-execute (`commandPolicy.ts`).
 * 2. The gray zone, by kind and profile (`GRAY`): reads, edits and read-only commands inside
 *    the worktree are always allowed; tests, builds, local git, installs from the manifest,
 *    network reads and other commands inside the worktree need a human only in `careful`;
 *    new dependencies also in `standard`; reads outside the worktree and unknown tools ask
 *    (careful / standard) or are denied (autonomous).
 *
 * Remembered approvals and Claude Code's auto mode classifier sit between the two (gate.ts).
 * Containment is decided on the text and on the real path (symlinks, junctions), so a link
 * committed in the repository cannot lead an allowed read or edit out of the worktree.
 */
export function decideToolPermission(req: ToolPolicyInput): ToolPolicyResult {
  const { toolName, input, cwd } = req;
  const profile = req.profile ?? 'careful';
  const platform = req.platform ?? process.platform;
  const lexical = req.platform !== undefined;
  const real = req.realpath ?? (lexical ? undefined : realpathDeep);
  const exists =
    req.exists ?? (lexical ? undefined : (p: string) => existsSync(resolveFrom(cwd, p, platform)));
  const inside = (target: string) =>
    isInside(target, cwd, platform) &&
    (!real || isInside(real(resolveFrom(cwd, target, platform)), real(cwd), platform));
  const allowedRoots = req.allowedOutside ?? [];
  const allowedOutside = (target: string) =>
    /^(\/dev\/(null|stdout|stderr|tty)|nul)$/i.test(target) ||
    allowedRoots.some(
      (r) =>
        isInside(target, r, platform) && isInside(resolveFrom(cwd, target, platform), r, platform),
    );
  const protectedRoots = req.protectedPaths ?? [];
  // A read root must not open up the daemon's data: one that is or holds a protected root is
  // ignored (one inside it, like a demo repository under ACC_HOME, is fine).
  const readRoots = (req.readRoots ?? []).filter(
    (r) => !protectedRoots.some((pr) => isInside(pr, r, platform)),
  );
  const readRootOf = (target: string): string | undefined =>
    homeLike(target)
      ? undefined
      : readRoots.find(
          (r) =>
            isInside(target, r, platform) &&
            (!real || isInside(real(resolveFrom(cwd, target, platform)), real(r), platform)),
        );
  const sensitive = (target: string) => {
    const root = readRootOf(target);
    if (root !== undefined) {
      // Inside a read root only credentials by name count (the root itself was vetted).
      const p = platform === 'win32' ? path.win32 : path.posix;
      const rel = p.relative(p.resolve(root), resolveFrom(cwd, target, platform));
      return SENSITIVE.test(rel.replace(/\\/g, '/'));
    }
    return (
      SENSITIVE.test(target.replace(/\\/g, '/')) ||
      protectedRoots.some((r) => isInside(resolveFrom(cwd, target, platform), r, platform))
    );
  };
  const readable = (target: string) => readRootOf(target) !== undefined && !sensitive(target);
  // Resolve symlinks before deciding `.git` / settings: an in-repo link named `x` pointing at
  // `.git` stays inside the worktree, so `inside()` passes, but writing through it would touch
  // git metadata (e.g. install a hook the daemon runs when it commits). Check the real path.
  const resolved = (target: string) =>
    real ? real(resolveFrom(cwd, target, platform)) : resolveFrom(cwd, target, platform);
  const realRoot = () => (real ? real(cwd) : cwd);
  const touchesGit = (target: string) =>
    touchesGitDir(target, cwd, platform) || touchesGitDir(resolved(target), realRoot(), platform);
  const isSettings = (target: string) =>
    isClaudeSettings(target) || isClaudeSettings(resolved(target));

  const hard = (rule: DenyRule, category: ToolCategory, detail: string): ToolPolicyResult => ({
    decision: 'deny',
    reason: `${rule}: ${detail}`,
    category,
    rule,
    message: denialMessage(RULE_TEXT[rule], detail),
    reasonJa: `${RULE_TEXT[rule].ja.split('。')[0]}（${detail}）`,
  });
  const gray = (category: ToolCategory, reason: string, detail?: string): ToolPolicyResult => {
    const decision = grayDecision(category, profile);
    const text = GRAY_DENY_TEXT[category];
    return {
      decision,
      reason,
      category,
      rule: null,
      message: decision === 'deny' && text ? denialMessage(text, detail) : null,
      reasonJa:
        decision === 'allow'
          ? `${CATEGORY_JA[category]}は自動で許可`
          : decision === 'deny'
            ? `${CATEGORY_JA[category]}はこのプロジェクトでは自動で拒否${detail ? `（${detail}）` : ''}`
            : `${CATEGORY_JA[category]}はこのプロジェクトでは確認が必要${detail ? `（${detail}）` : ''}`,
    };
  };

  const isEditTool = EDIT_TOOLS.has(toolName);
  const baseCategory: ToolCategory = COMMAND_TOOLS.has(toolName)
    ? 'command_other'
    : isEditTool
      ? 'edit'
      : 'read';

  const readsOnly = !isEditTool && !COMMAND_TOOLS.has(toolName);
  if (
    req.blockedPath &&
    !inside(req.blockedPath) &&
    !allowedOutside(req.blockedPath) &&
    !(readsOnly && readable(req.blockedPath))
  ) {
    const p = req.blockedPath;
    if (sensitive(p)) return hard('credentials', baseCategory, p);
    if (isEditTool || COMMAND_TOOLS.has(toolName)) return hard('outside_write', baseCategory, p);
    return gray('outside_read', `path outside workspace: ${p}`, p);
  }
  if (DISALLOWED_AGENT_TOOLS.has(toolName)) return hard('unattended', 'unknown_tool', toolName);
  if (toolName.startsWith(ACC_TOOL_PREFIX)) {
    return gray('control_api', 'control api tool (capabilities enforced by dispatcher)');
  }
  if (COMMAND_TOOLS.has(toolName)) {
    const command = asString(asRecord(input)?.command) ?? (typeof input === 'string' ? input : '');
    if (!command.trim()) return gray('command_other', 'command without text');
    const verdict = analyzeCommand(
      command,
      {
        inside,
        allowedOutside,
        sensitive,
        touchesGit,
        isSettings,
        exists,
        daemonPort: req.daemonPort,
        readable,
      },
      toolName === 'PowerShell' ? 'powershell' : 'posix',
    );
    if (verdict.hard) return hard(verdict.hard.rule, 'command_other', verdict.hard.detail);
    // The strictest answer among the command's parts decides; the event names the most notable.
    let worst: ToolDecision = 'allow';
    for (const c of verdict.categories) {
      const d = grayDecision(c, profile);
      if (d === 'deny' || (d === 'ask' && worst === 'allow')) worst = d;
    }
    const top = topCategory(verdict.categories);
    const outside = verdict.outsideReads[0];
    const r = gray(top, `command: ${[...verdict.categories].join(', ')}`, outside);
    if (r.decision === worst) return r;
    const forced = [...verdict.categories].find((c) => grayDecision(c, profile) === worst)!;
    return { ...gray(forced, r.reason, outside), category: top };
  }
  if (SUBAGENT_TOOLS.has(toolName)) {
    return gray('subagent', 'sub-agent tool uses are checked individually');
  }
  if (AGENT_INTERNAL_TOOLS.has(toolName)) return gray('agent_internal', 'agent bookkeeping tool');
  if (WEB_TOOLS.has(toolName)) return gray('network_read', `web tool: ${toolName}`);

  const isRead = READ_ONLY_TOOLS.has(toolName);
  if (!isRead && !isEditTool) return gray('unknown_tool', `unknown tool: ${toolName}`, toolName);

  const paths = toolPaths(toolName, input);
  if (isEditTool && paths.length === 0) {
    return {
      ...hard('outside_write', 'edit', 'no target path'),
      reason: 'edit without a target path',
    };
  }
  for (const p of paths) {
    if (inside(p)) continue;
    if (sensitive(p)) return hard('credentials', baseCategory, p);
    if (allowedOutside(p)) continue;
    if (isEditTool) return hard('outside_write', 'edit', p);
    if (readable(p)) continue;
    return gray('outside_read', `path outside workspace: ${p}`, p);
  }
  if (isEditTool) {
    const gitPath = paths.find((p) => touchesGit(p));
    if (gitPath !== undefined) return hard('git_metadata', 'edit', gitPath);
    const settings = paths.find((p) => isSettings(p));
    if (settings !== undefined) return hard('self_escalation', 'edit', settings);
    return gray('edit', 'edit inside workspace');
  }
  return gray('read', 'read-only inside workspace');
}

/**
 * Credentials and agent / daemon state under a home directory, matched on the path text
 * (only asked for paths outside the workspace).
 */
const SENSITIVE =
  /(^|\/)(\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.docker|\.config\/(gh|gcloud|hub|git)|\.netrc|_netrc|\.git-credentials|\.npmrc|\.yarnrc(\.yml)?|\.pypirc|\.gem\/credentials|\.cargo\/credentials(\.toml)?|\.claude(\.json)?|\.codex|\.acc|daemon\.json|acc\.sqlite|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?)(\/|$)|^\/etc\/(shadow|sudoers)/i;

/** "~" paths: expanded by shells and tools, never by path.resolve (never inside anything). */
function homeLike(target: string): boolean {
  return target.startsWith('~');
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
