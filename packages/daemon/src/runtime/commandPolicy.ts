import { readOnlyCommandReason } from './commands';
import { type ShellCommand, type ShellDialect, parseShell, quoteWord } from './shell';

/**
 * What a shell command line does, for the tool policy (policy.ts). Pure: the file system is
 * reached only through `CommandContext`.
 *
 * - `hard`: the first hard rule it breaks (pushing, writing outside the worktree, credentials,
 *   system changes, ...). Hard rules are denied in every profile.
 * - `categories`: the gray-zone kinds of its parts (tests, local git, dependency installs,
 *   network reads, ...). The profile decides what each kind needs.
 *
 * Only the text is seen: what a test script or an install script does when it runs is not
 * (docs/snapshot/20261029_auto-mode.md). The boundary for that is OS-level isolation.
 */

export type HardRule =
  | 'git_metadata'
  | 'outside_write'
  | 'credentials'
  | 'publish_remote'
  | 'branch'
  | 'network_send'
  | 'system'
  | 'self_escalation'
  | 'download_exec'
  | 'opaque';

export type CommandCategory =
  | 'command_readonly'
  | 'git_local'
  | 'build_test'
  | 'deps_install'
  | 'deps_add'
  | 'network_read'
  | 'command_other'
  | 'outside_read';

export interface CommandContext {
  /** Inside the workspace (lexically and after resolving links). */
  inside(path: string): boolean;
  /** Outside but harmless (/dev/null, configured extra roots). */
  allowedOutside(path: string): boolean;
  /** Credentials or daemon data (only asked for paths outside the workspace). */
  sensitive(path: string): boolean;
  /** Any component is `.git` (resolving symlinks, so an in-repo link to `.git` is caught). */
  touchesGit(path: string): boolean;
  /** An agent-CLI settings file (`.claude/settings.json`), resolving symlinks. Default: text only. */
  isSettings?(path: string): boolean;
  /** Whether a path exists (for `git checkout <path>`); default: unknown (false). */
  exists?(path: string): boolean;
  /** Port of the Control API; a command naming it on a loopback host is denied. */
  daemonPort?: number | undefined;
  /**
   * Outside but readable (the project's folder / repository): reading it is a read inside,
   * writing it is still `outside_write`. Default: nothing.
   */
  readable?(path: string): boolean;
}

export interface CommandVerdict {
  hard: { rule: HardRule; detail: string } | null;
  categories: Set<CommandCategory>;
  /** Paths outside the workspace it reads (category outside_read). */
  outsideReads: string[];
}

/** Gray-zone kinds from least to most notable (the event shows the most notable one). */
export const CATEGORY_ORDER: readonly CommandCategory[] = [
  'command_readonly',
  'git_local',
  'build_test',
  'command_other',
  'deps_install',
  'network_read',
  'deps_add',
  'outside_read',
];

const MAX_DEPTH = 4;

/** Shell keywords in front of a command (`if x; then make; fi`). */
const KEYWORD_PREFIX = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!']);
/** Keywords whose words are not a command (`for f in *.ts`, `done`). */
const KEYWORD_SKIP = new Set(['for', 'select', 'case', 'esac', 'fi', 'done', 'in', 'function']);
/** A downloader named in a substitution (`sh -c "$(curl ...)"`, `iex (iwr ...)`). */
const DOWNLOAD_TEXT = /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b/i;

export function analyzeCommand(
  command: string,
  ctx: CommandContext,
  dialect: ShellDialect = 'posix',
): CommandVerdict {
  const v: CommandVerdict = { hard: null, categories: new Set(), outsideReads: [] };
  new Analyzer(ctx, v).script(command, dialect, 0);
  if (v.categories.size === 0 && !v.hard) v.categories.add('command_other');
  return v;
}

/** The most notable category of a verdict. */
export function topCategory(categories: Iterable<CommandCategory>): CommandCategory {
  let best: CommandCategory = 'command_readonly';
  for (const c of categories) {
    if (CATEGORY_ORDER.indexOf(c) > CATEGORY_ORDER.indexOf(best)) best = c;
  }
  return best;
}

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

const DOWNLOADERS = new Set([
  'curl',
  'wget',
  'iwr',
  'irm',
  'invoke-webrequest',
  'invoke-restmethod',
  'fetch',
  'aria2c',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'busybox']);
const POWERSHELLS = new Set(['powershell', 'pwsh']);
const INTERPRETERS = new Set([
  'node',
  'nodejs',
  'deno',
  'python',
  'python3',
  'py',
  'perl',
  'ruby',
  'php',
  'tsx',
  'ts-node',
]);
/** Code given inline to an interpreter (`node -e`, `python -c`). */
const INLINE_CODE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c', '-r', '--command']);

/** Programs that only read the paths they are given (an outside path is an outside read). */
const READERS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ls',
  'dir',
  'find',
  'fd',
  'wc',
  'diff',
  'cmp',
  'file',
  'stat',
  'du',
  'tree',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'jq',
  'yq',
  'type',
  'get-content',
  'gc',
  'get-childitem',
  'gci',
  'select-string',
  'sls',
  'test-path',
  'get-item',
  'resolve-path',
  'which',
  'where',
  'realpath',
  'readlink',
  'basename',
  'dirname',
  'sort',
  'uniq',
  'cut',
  'strings',
  'hexdump',
  'xxd',
  'od',
  'source',
  '.',
  'cd',
  'pushd',
  'set-location',
  'sl',
  'chdir',
]);
/** First positional is a pattern / script, not a path. */
const PATTERN_FIRST = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'sed',
  'awk',
  'select-string',
  'sls',
  'jq',
  'yq',
]);
/** Arguments are data. */
const DATA_ARGS = new Set([
  'echo',
  'printf',
  'write-output',
  'write-host',
  'write',
  'true',
  'false',
  'test',
  '[',
  'expr',
  'sleep',
  'date',
  'export',
  'set',
  'unset',
]);

const AGENT_CLIS = new Set([
  'claude',
  'claude-code',
  'codex',
  'aider',
  'gemini',
  'copilot',
  'cursor-agent',
  'opencode',
  'goose',
  'amp',
  'acc',
  'crush',
  'qwen',
]);
const AGENT_PACKAGES =
  /^(@anthropic-ai\/claude-code|@openai\/codex|@google\/gemini-cli|@github\/copilot|opencode-ai|aider-chat)(@|$)/i;

const SYSTEM_PROGRAMS = new Set([
  'sudo',
  'su',
  'doas',
  'runas',
  'pkexec',
  'crontab',
  'at',
  'schtasks',
  'systemctl',
  'service',
  'launchctl',
  'sc',
  'reg',
  'regedit',
  'setx',
  'chsh',
  'useradd',
  'usermod',
  'userdel',
  'passwd',
  'netsh',
  'bcdedit',
  'mount',
  'umount',
  'diskpart',
  'format',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'apt',
  'apt-get',
  'yum',
  'dnf',
  'pacman',
  'zypper',
  'apk',
  'brew',
  'port',
  'choco',
  'winget',
  'scoop',
  'snap',
  'flatpak',
  'nix-env',
  'nohup',
  'setsid',
  'disown',
  'screen',
  'tmux',
  'start',
  'start-process',
  'saps',
  'start-job',
  'register-scheduledtask',
  'new-service',
  'set-service',
  'set-executionpolicy',
  'restart-computer',
  'stop-computer',
  'open',
  'xdg-open',
  'kill',
  'pkill',
  'killall',
  'taskkill',
  'stop-process',
  'spps',
  'docker',
  'podman',
  'kubectl',
  'helm',
  'mkfs',
]);
const CREDENTIAL_PROGRAMS = new Set([
  'ssh-keygen',
  'ssh-add',
  'ssh-agent',
  'gpg',
  'gpg2',
  'security',
  'cmdkey',
  'vaultcmd',
  'git-credential',
]);
const NETWORK_SEND_PROGRAMS = new Set([
  'ssh',
  'scp',
  'sftp',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'telnet',
  'ftp',
  'tftp',
  'mail',
  'mailx',
  'sendmail',
  'send-mailmessage',
]);
const BUILD_TOOLS = new Set([
  'tsc',
  'eslint',
  'prettier',
  'biome',
  'vitest',
  'jest',
  'mocha',
  'ava',
  'playwright',
  'cypress',
  'pytest',
  'py.test',
  'tox',
  'nox',
  'ruff',
  'black',
  'isort',
  'flake8',
  'pylint',
  'mypy',
  'pyright',
  'make',
  'cmake',
  'ninja',
  'meson',
  'gradle',
  'gradlew',
  'mvn',
  'mvnw',
  'ant',
  'sbt',
  'rustc',
  'rustfmt',
  'gcc',
  'g++',
  'cc',
  'clang',
  'clang++',
  'javac',
  'java',
  'kotlinc',
  'swift',
  'swiftc',
  'turbo',
  'nx',
  'lerna',
  'vite',
  'next',
  'webpack',
  'rollup',
  'esbuild',
  'tsup',
  'vue-tsc',
  'stylelint',
  'shellcheck',
  'golangci-lint',
  'gofmt',
  'phpunit',
  'rspec',
  'rake',
  'mix',
  'dart',
  'flutter',
  'zig',
]);
/** Builtins of npm-like package managers that are not scripts. */
const PM_BUILTINS = new Set([
  'install',
  'i',
  'add',
  'ci',
  'remove',
  'rm',
  'uninstall',
  'un',
  'update',
  'up',
  'upgrade',
  'publish',
  'unpublish',
  'dlx',
  'exec',
  'x',
  'run',
  'run-script',
  'test',
  't',
  'link',
  'unlink',
  'login',
  'logout',
  'adduser',
  'whoami',
  'config',
  'set',
  'get',
  'store',
  'env',
  'setup',
  'self-update',
  'global',
  'init',
  'create',
  'pack',
  'version',
  'deprecate',
  'dist-tag',
  'owner',
  'access',
  'token',
  'team',
  'org',
  'star',
  'hook',
  'audit',
  'outdated',
  'view',
  'info',
  'show',
  'ls',
  'list',
  'why',
  'prune',
  'dedupe',
  'rebuild',
  'import',
  'patch',
  'npm',
]);

/**
 * Environment variables that redirect git's storage or working tree out of the daemon's
 * worktree. Set as a command prefix (`GIT_WORK_TREE=/home/me git checkout ...`) they let an
 * otherwise-benign git command read or write outside it, so the daemon cannot see the escape
 * in the command's words. Denied as git_metadata.
 */
const GIT_REDIRECT_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_TEMPLATE_DIR',
  'GIT_CEILING_DIRECTORIES',
]);

/**
 * Environment variables whose value is run as a command, loaded as code, or preloaded into a
 * process. Set as a command prefix they smuggle an arbitrary command past the policy (which
 * otherwise reads `sh -c`, `node -e`, pipelines, ...). Denied as opaque: the real effect of
 * the command cannot be verified from its words.
 */
const CODE_INJECTION_ENV = new Set([
  // git hooks / helpers that run a command
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_PROXY_COMMAND',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  // generic pager / editor a tool may shell out to
  'PAGER',
  'EDITOR',
  'VISUAL',
  // shells that source a file before running
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'PROMPT_COMMAND',
  'PS4',
  'IFS',
  'SHELLOPTS',
  'BASHOPTS',
  // dynamic linker / loader preloads
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  // language runtimes that load extra code at startup
  'NODE_OPTIONS',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
]);

/** The hard rule a leading `NAME=value` env assignment breaks, or null when it is harmless. */
export function envAssignmentRule(name: string): HardRule | null {
  const n = name.toUpperCase();
  if (GIT_REDIRECT_ENV.has(n)) return 'git_metadata';
  if (CODE_INJECTION_ENV.has(n)) return 'opaque';
  // Shadowing the command search path points a plain `git`/`node`/... at an attacker's binary.
  if (n === 'PATH' || n === 'PATHEXT') return 'opaque';
  return null;
}

/** git config keys (`git -c key=value`) that make git run a command or load code. */
const GIT_CONFIG_EXEC = [
  /^core\.sshcommand$/i,
  /^core\.pager$/i,
  /^core\.editor$/i,
  /^core\.hookspath$/i,
  /^core\.fsmonitor$/i,
  /^core\.(askpass|editor)$/i,
  /^sequence\.editor$/i,
  /^diff\.external$/i,
  /^diff\..*\.command$/i,
  /\.textconv$/i,
  /^filter\..*\.(clean|smudge|process)$/i,
  /^.*\.sshcommand$/i,
  /^pager\./i,
  /^protocol\..*\.allow$/i,
  /^credential\..*helper$/i,
  /^credential\.helper$/i,
  /^uploadpack\.packobjectshook$/i,
  /^gpg\.program$/i,
];

/** Whether `git -c key=value` overrides a key that can run a command or load code. */
function gitConfigRunsCode(kv: string): boolean {
  const key = kv.slice(0, kv.indexOf('=') >= 0 ? kv.indexOf('=') : kv.length);
  if (/^alias\./i.test(key)) {
    // `git -c alias.x='!cmd' x` runs the shell alias.
    const val = kv.slice(kv.indexOf('=') + 1);
    return kv.includes('=') ? val.trimStart().startsWith('!') : true;
  }
  return GIT_CONFIG_EXEC.some((re) => re.test(key));
}

/** A remote URL / transport that runs a local command (`ext::sh -c ...`). */
function isExecTransport(url: string): boolean {
  return /^ext::/i.test(url.trim());
}

function programName(word: string): string {
  const base = word.replace(/^.*[\\/]/, '').toLowerCase();
  return base.replace(/\.(exe|cmd|bat|ps1|com)$/, '');
}

const isFlag = (w: string) => w.startsWith('-') && w !== '-' && w !== '--';
const positionals = (args: string[]) => args.filter((a) => !isFlag(a) && a !== '--');
const hasFlag = (args: string[], ...names: string[]) =>
  args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));
const hasShortFlag = (args: string[], letter: string) =>
  args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.slice(1).includes(letter));

/** A word that names a path we should check (absolute, home-relative, or climbing out). */
export function looksLikePath(w: string): boolean {
  if (!w || /\s/.test(w)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return false;
  if (w.startsWith('~')) return true;
  if (/^\$\{?(home|userprofile|appdata|localappdata|acc_home)\}?/i.test(w)) return true;
  if (/^\$env:/i.test(w) || /^%[a-z_]+%/i.test(w)) return true;
  if (w.startsWith('/') && !w.startsWith('//')) return true;
  if (/^[a-z]:[\\/]/i.test(w) || w.startsWith('\\\\')) return true;
  return /(^|[\\/])\.\.([\\/]|$)/.test(w);
}

/** Expansions we cannot resolve that point at home / daemon data: treated as outside. */
function homeish(w: string): boolean {
  return (
    w.startsWith('~') ||
    /^\$\{?(home|userprofile|appdata|localappdata|acc_home)\}?/i.test(w) ||
    /^\$env:/i.test(w) ||
    /^%[a-z_]+%/i.test(w)
  );
}

class Analyzer {
  constructor(
    private readonly ctx: CommandContext,
    private readonly v: CommandVerdict,
  ) {}

  private hard(rule: HardRule, detail: string): void {
    if (!this.v.hard) this.v.hard = { rule, detail };
  }

  private cat(c: CommandCategory): void {
    this.v.categories.add(c);
  }

  script(text: string, dialect: ShellDialect, depth: number): void {
    if (depth > MAX_DEPTH) {
      this.hard('opaque', 'nested too deeply');
      return;
    }
    const whole = text.trim();
    // The strict read-only allowlist first (also what the careful profile allows).
    if (
      dialect === 'posix' &&
      readOnlyCommandReason(whole, { inside: (p) => this.readsInside(p) })
    ) {
      this.cat('command_readonly');
      return;
    }
    const parsed = parseShell(text, dialect);
    if (!parsed.complete) this.cat('command_other');
    const cmds = parsed.commands;
    for (let i = 0; i < cmds.length; i++) {
      const c = cmds[i]!;
      // A downloader earlier in the same pipeline feeding a shell = download and execute.
      let fedByDownload = false;
      for (let j = i; j > 0 && cmds[j]!.piped; j--) {
        if (DOWNLOADERS.has(programName(cmds[j - 1]!.argv[0] ?? ''))) fedByDownload = true;
      }
      const cdOutside = this.command(c, dialect, depth, fedByDownload);
      if (cdOutside && i < cmds.length - 1) {
        this.hard('outside_write', `cd ${cdOutside}`);
      }
      for (const s of c.substitutions) this.script(s, dialect, depth + 1);
    }
  }

  /** Checks one simple command. Returns the outside target of a `cd`, if any. */
  private command(
    c: ShellCommand,
    dialect: ShellDialect,
    depth: number,
    fedByDownload: boolean,
  ): string | null {
    let argv = c.argv.slice();
    for (const a of c.assignments) this.envAssign(a);
    for (const w of c.writes) this.pathArg(w, 'write');
    for (const r of c.reads) this.pathArg(r, 'read');
    if (c.background) this.hard('system', 'background process (&)');
    for (const w of argv) this.wordChecks(w);
    if (dialect === 'powershell') for (const w of argv) this.powershellEnvWrite(w);
    if (argv.length === 0) return null;

    // Unwrap shell keywords and wrappers: env / command / exec / time / nice / timeout / xargs.
    for (;;) {
      const p = programName(argv[0] ?? '');
      if (KEYWORD_PREFIX.has(p)) {
        argv = argv.slice(1);
        if (argv.length === 0) return null;
        continue;
      }
      if (KEYWORD_SKIP.has(p)) {
        this.cat('command_other');
        return null;
      }
      if (
        p === 'env' ||
        p === 'command' ||
        p === 'builtin' ||
        p === 'exec' ||
        p === 'time' ||
        p === 'nice' ||
        p === 'stdbuf' ||
        p === 'xargs'
      ) {
        argv = argv.slice(1);
        while (argv[0] && (isFlag(argv[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]))) {
          const f = argv.shift()!;
          // `env NAME=value cmd` carries the same risk as a bare `NAME=value cmd` prefix.
          if ((p === 'env' || p === 'command') && /^[A-Za-z_][A-Za-z0-9_]*=/.test(f))
            this.envAssign(f);
          if ((p === 'nice' && f === '-n') || (p === 'xargs' && /^-[IdLnPs]$/.test(f)))
            argv.shift();
        }
        continue;
      }
      if (p === 'timeout') {
        argv = argv.slice(1);
        while (argv[0] && isFlag(argv[0])) argv.shift();
        argv = argv.slice(1); // duration
        continue;
      }
      break;
    }
    if (argv.length === 0) return null;
    const raw = argv[0]!;
    const prog = programName(raw);
    const args = argv.slice(1);

    // The program itself given by a path outside the workspace (not a system bin dir).
    if (/[\\/]/.test(raw) && (homeish(raw) || /(^|[\\/])\.\.([\\/]|$)/.test(raw))) {
      this.pathArg(raw, 'read');
    }

    if (
      fedByDownload &&
      (SHELLS.has(prog) ||
        POWERSHELLS.has(prog) ||
        INTERPRETERS.has(prog) ||
        prog === 'iex' ||
        prog === 'invoke-expression')
    ) {
      this.hard('download_exec', `${prog} fed by a download`);
      return null;
    }
    if (AGENT_CLIS.has(prog)) {
      this.hard('self_escalation', prog);
      return null;
    }
    if (SYSTEM_PROGRAMS.has(prog) || /^mkfs(\.|$)/.test(prog)) {
      if ((prog === 'docker' || prog === 'podman') && this.containerReadOnly(args)) {
        this.cat('command_other');
        return null;
      }
      if ((prog === 'docker' || prog === 'podman') && positionals(args)[0] === 'push') {
        this.hard('publish_remote', `${prog} push`);
        return null;
      }
      this.hard('system', prog);
      return null;
    }
    if (CREDENTIAL_PROGRAMS.has(prog) || prog.startsWith('git-credential')) {
      this.hard('credentials', prog);
      return null;
    }
    if (NETWORK_SEND_PROGRAMS.has(prog)) {
      this.hard('network_send', prog);
      return null;
    }

    const runsCode =
      SHELLS.has(prog) ||
      POWERSHELLS.has(prog) ||
      INTERPRETERS.has(prog) ||
      prog === 'cmd' ||
      prog === 'eval' ||
      prog === 'iex' ||
      prog === 'invoke-expression';
    if (runsCode && c.substitutions.some((s) => DOWNLOAD_TEXT.test(s))) {
      this.hard('download_exec', `${prog} of a download`);
      return null;
    }
    if (SHELLS.has(prog) || POWERSHELLS.has(prog) || prog === 'cmd') {
      this.shell(prog, args, depth);
      return null;
    }
    if (prog === 'eval' || prog === 'iex' || prog === 'invoke-expression') {
      // `iex (iwr https://...)`: PowerShell's parentheses are not split out as substitutions.
      if (args.some((a) => DOWNLOADERS.has(programName(a)))) {
        this.hard('download_exec', `${prog} of a download`);
        return null;
      }
      this.script(args.join(' '), prog === 'eval' ? 'posix' : 'powershell', depth + 1);
      return null;
    }

    switch (prog) {
      case 'git':
        this.git(args);
        return null;
      case 'gh':
        this.gh(args);
        return null;
      case 'curl':
      case 'wget':
      case 'iwr':
      case 'irm':
      case 'invoke-webrequest':
      case 'invoke-restmethod':
      case 'aria2c':
        this.download(prog, args, dialect);
        return null;
      case 'rsync':
        if (positionals(args).some((a) => /^[^/\\]+:/.test(a) && !/^[a-z]:[\\/]/i.test(a))) {
          this.hard('network_send', 'rsync to a remote host');
          return null;
        }
        for (const a of positionals(args)) this.pathArg(a, 'write');
        this.cat('command_other');
        return null;
      case 'npm':
      case 'pnpm':
      case 'yarn':
      case 'bun':
        this.packageManager(prog, args);
        return null;
      case 'npx':
      case 'bunx':
        this.npx(args);
        return null;
      case 'pip':
      case 'pip3':
        this.pip(args);
        return null;
      case 'uv':
      case 'poetry':
      case 'pipenv':
      case 'cargo':
      case 'go':
      case 'gem':
      case 'bundle':
      case 'composer':
      case 'dotnet':
      case 'deno':
        this.toolchain(prog, args);
        return null;
      case 'twine':
      case 'vsce':
      case 'ovsx':
        this.hard('publish_remote', `${prog}`);
        return null;
      default:
        break;
    }

    if (INTERPRETERS.has(prog)) {
      this.interpreter(prog, args);
      return null;
    }
    if (BUILD_TOOLS.has(prog) || /^\.?[\\/]?node_modules[\\/]\.bin[\\/]/.test(raw)) {
      this.pathArgs(prog, args, 'write');
      this.cat('build_test');
      return null;
    }
    if (
      prog === 'cd' ||
      prog === 'pushd' ||
      prog === 'set-location' ||
      prog === 'sl' ||
      prog === 'chdir'
    ) {
      const target = positionals(args)[0];
      if (target && this.outside(target)) {
        this.pathArg(target, 'read');
        return target;
      }
      this.cat('command_other');
      return null;
    }
    if (prog === 'sed' && (hasShortFlag(args, 'i') || hasFlag(args, '--in-place'))) {
      this.pathArgs(prog, args, 'write');
      this.cat('command_other');
      return null;
    }
    this.pathArgs(prog, args, READERS.has(prog) ? 'read' : 'write');
    this.cat('command_other');
    return null;
  }

  // ---- words and paths ----------------------------------------------------------

  /** Checks every word for things that are never fine (the Control API port, daemon data). */
  private wordChecks(w: string): void {
    const port = this.ctx.daemonPort;
    if (
      port &&
      new RegExp(
        `(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]|::1):${port}(\\D|$)`,
        'i',
      ).test(w)
    ) {
      this.hard('self_escalation', `Control API port ${port}`);
    }
    if (/\$\{?acc_home\b|%acc_home%|\$env:acc_home/i.test(w)) this.hard('credentials', w);
  }

  /** A leading `NAME=value` env assignment that hijacks a tool's behaviour. */
  private envAssign(word: string): void {
    const name = word.slice(0, word.indexOf('='));
    const rule = envAssignmentRule(name);
    if (rule) this.hard(rule, `${name}=`);
  }

  /** A PowerShell env write (`$env:NAME=...`, `Set-Item Env:NAME ...`) to a hijacking var. */
  private powershellEnvWrite(word: string): void {
    const m =
      /^\$env:([A-Za-z_][A-Za-z0-9_]*)=/i.exec(word) ??
      /^env:([A-Za-z_][A-Za-z0-9_]*)$/i.exec(word);
    if (!m) return;
    const rule = envAssignmentRule(m[1]!);
    if (rule) this.hard(rule, `$env:${m[1]}`);
  }

  /** Inside the workspace, or in a read root (for read-only commands; credentials excluded). */
  private readsInside(p: string): boolean {
    if (this.ctx.inside(p)) return true;
    return !homeish(p) && (this.ctx.readable?.(p) ?? false) && !this.ctx.sensitive(p);
  }

  private outside(p: string): boolean {
    if (homeish(p)) return true;
    return !this.ctx.inside(p) && !this.ctx.allowedOutside(p);
  }

  /** A path argument: outside writes and credentials are hard denials; outside reads are noted. */
  private pathArg(p: string, mode: 'read' | 'write'): void {
    if (!p || p === '-' || p.includes('$(…)')) return;
    const inside = !homeish(p) && this.ctx.inside(p);
    if (!inside) {
      if (this.ctx.sensitive(p)) {
        this.hard('credentials', p);
        return;
      }
      if (!homeish(p) && this.ctx.allowedOutside(p)) return;
      if (mode === 'write') this.hard('outside_write', p);
      else if (!homeish(p) && this.ctx.readable?.(p)) return;
      else {
        this.v.outsideReads.push(p);
        this.cat('outside_read');
      }
      return;
    }
    if (mode === 'write') {
      if (this.ctx.touchesGit(p)) this.hard('git_metadata', p);
      else if ((this.ctx.isSettings ?? isClaudeSettings)(p)) this.hard('self_escalation', p);
    }
  }

  /** Path-like arguments of a program (skipping patterns, inline code and data). */
  private pathArgs(prog: string, args: string[], mode: 'read' | 'write'): void {
    if (DATA_ARGS.has(prog)) return;
    let skipPattern =
      PATTERN_FIRST.has(prog) &&
      !args.some((a) => a === '-e' || a === '-f' || a.startsWith('--regexp'));
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (
        a === '-m' ||
        a === '--message' ||
        a === '-e' ||
        (a === '-f' && PATTERN_FIRST.has(prog))
      ) {
        i++;
        continue;
      }
      let w = a;
      if (isFlag(a)) {
        const eq = a.indexOf('=');
        if (eq < 0) continue;
        w = a.slice(eq + 1);
      } else if (skipPattern) {
        skipPattern = false;
        continue;
      }
      if (looksLikePath(w)) this.pathArg(w, mode);
      else if (
        mode === 'write' &&
        (this.ctx.touchesGit(w) || (this.ctx.isSettings ?? isClaudeSettings)(w))
      )
        this.pathArg(w, 'write');
    }
  }

  // ---- programs -------------------------------------------------------------------

  private shell(prog: string, args: string[], depth: number): void {
    const lower = args.map((a) => a.toLowerCase());
    if (POWERSHELLS.has(prog)) {
      // -EncodedCommand and its abbreviations (-e, -ec, -enc, ...): not readable.
      if (lower.some((a) => /^-e(c|n[a-z]*)?$/.test(a))) {
        this.hard('opaque', `${prog} -EncodedCommand`);
        return;
      }
      const i = lower.findIndex((a) => a === '-command' || a === '-c');
      if (i >= 0) {
        this.script(args.slice(i + 1).join(' '), 'powershell', depth + 1);
        return;
      }
      const f = lower.findIndex((a) => a === '-file' || a === '-f');
      if (f >= 0 && args[f + 1]) this.pathArg(args[f + 1]!, 'read');
      this.cat('command_other');
      return;
    }
    if (prog === 'cmd') {
      const i = lower.findIndex((a) => a === '/c' || a === '/k');
      if (i >= 0) {
        this.script(args.slice(i + 1).join(' '), 'posix', depth + 1);
        return;
      }
      this.cat('command_other');
      return;
    }
    const c = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (c >= 0 && args[c + 1] !== undefined) {
      this.script(args[c + 1]!, 'posix', depth + 1);
      return;
    }
    const script = positionals(args)[0];
    if (script) this.pathArg(script, 'read');
    this.cat(script ? 'build_test' : 'command_other');
  }

  private interpreter(prog: string, args: string[]): void {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (INLINE_CODE_FLAGS.has(a) && !(prog.startsWith('py') && a === '-r')) {
        const code = args[i + 1] ?? '';
        this.inlineCode(code);
        this.cat('command_other');
        return;
      }
      if (prog.startsWith('py') && a === '-m') {
        const mod = args[i + 1] ?? '';
        if (mod === 'pip') return this.pip(args.slice(i + 2));
        if (mod === 'venv' || mod === 'virtualenv') return this.cat('deps_install');
        this.pathArgs(prog, args.slice(i + 2), 'write');
        this.cat(
          /^(pytest|unittest|mypy|ruff|black|isort|flake8|pylint|tox|nox|build|compileall)$/.test(
            mod,
          )
            ? 'build_test'
            : 'command_other',
        );
        return;
      }
      if (isFlag(a)) continue;
      // The script file, then its arguments.
      this.pathArg(a, 'read');
      this.pathArgs(prog, args.slice(i + 1), 'write');
      this.cat('build_test');
      return;
    }
    this.cat(args.includes('--test') ? 'build_test' : 'command_other');
  }

  /** Inline code: look for the hard-rule patterns in its text (best effort). */
  private inlineCode(code: string): void {
    if (/\bgit\b[\s\S]{0,40}\bpush\b/.test(code))
      this.hard('publish_remote', 'git push in inline code');
    else if (/\b(npm|pnpm|yarn)\s+publish\b/.test(code))
      this.hard('publish_remote', 'publish in inline code');
    else if (/[\\/]\.ssh[\\/]|[\\/]\.aws[\\/]|daemon\.json|\.git-credentials/i.test(code)) {
      this.hard('credentials', 'credential path in inline code');
    } else if (
      /\b(claude|codex)\b['"\s]/.test(code) &&
      /child_process|subprocess|spawn|exec/.test(code)
    ) {
      this.hard('self_escalation', 'agent CLI from inline code');
    }
    const port = this.ctx.daemonPort;
    if (port && new RegExp(`(localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}(\\D|$)`).test(code)) {
      this.hard('self_escalation', `Control API port ${port}`);
    }
  }

  private git(args: string[]): void {
    let i = 0;
    let dirArg: string | null = null;
    for (; i < args.length; i++) {
      const a = args[i]!;
      if (a === '-C') {
        dirArg = args[++i] ?? null;
        continue;
      }
      if (a === '-c' || a === '--config-env') {
        const kv = args[++i];
        // `git -c core.sshCommand=... fetch` runs an arbitrary command; `-c alias.x='!...'` too.
        if (kv && gitConfigRunsCode(kv)) this.hard('opaque', `git -c ${kv.split('=')[0]}`);
        continue;
      }
      if (a.startsWith('-c') && a.length > 2 && gitConfigRunsCode(a.slice(2))) {
        this.hard('opaque', `git -c ${a.slice(2).split('=')[0]}`);
        continue;
      }
      if ((a === '--upload-pack' || a === '--receive-pack' || a === '--exec') && args[i + 1]) {
        this.hard('opaque', `git ${a}`);
        i++;
        continue;
      }
      if (/^--(upload-pack|receive-pack|exec)=/.test(a)) {
        this.hard('opaque', `git ${a.split('=')[0]}`);
        continue;
      }
      if (a.startsWith('--git-dir') || a.startsWith('--work-tree')) {
        // The daemon pins the worktree's git dir; pointing git elsewhere is not the agent's call.
        if (!a.includes('=')) i++;
        this.hard('git_metadata', a);
        continue;
      }
      if (isFlag(a)) continue;
      break;
    }
    const sub = args[i];
    const rest = args.slice(i + 1);
    const pos = positionals(rest);
    // A remote-helper transport (`git fetch ext::sh -c ...`) runs a local command.
    if (rest.some((a) => isExecTransport(a))) {
      this.hard('opaque', `git ${sub ?? ''} ext::`.trim());
      return;
    }
    // `--upload-pack` / `--receive-pack` / `--exec` run a program git would otherwise invoke
    // on the remote; with a local or ext transport they run here.
    const execFlag = rest.find((a) => /^--(upload-pack|receive-pack|exec)(=|$)/.test(a));
    if (execFlag) {
      this.hard('opaque', `git ${execFlag.split('=')[0]}`);
      return;
    }
    if (dirArg && this.outside(dirArg)) {
      const reading =
        sub !== undefined &&
        /^(status|diff|log|show|ls-files|rev-parse|blame|grep|describe|shortlog|cat-file|ls-tree|rev-list|branch)$/.test(
          sub,
        );
      this.pathArg(dirArg, reading ? 'read' : 'write');
      if (reading) return;
    }
    if (!sub) return this.cat('command_other');
    const readOnly = () => {
      const line = ['git', ...args].map(quoteWord);
      return (
        line.every((w) => w !== null) &&
        !!readOnlyCommandReason(line.join(' '), { inside: (p) => this.readsInside(p) })
      );
    };
    switch (sub) {
      case 'push':
        return this.hard('publish_remote', 'git push');
      case 'send-email':
      case 'request-pull':
        return this.hard('network_send', `git ${sub}`);
      case 'daemon':
      case 'instaweb':
      case 'http-backend':
        return this.hard('system', `git ${sub}`);
      case 'credential':
      case 'credential-store':
      case 'credential-cache':
        return this.hard('credentials', `git ${sub}`);
      case 'remote': {
        const action = pos[0];
        if (
          action &&
          /^(add|set-url|remove|rm|rename|set-head|set-branches|prune|update)$/.test(action)
        ) {
          return this.hard('publish_remote', `git remote ${action}`);
        }
        return this.cat(action === 'show' ? 'network_read' : 'command_readonly');
      }
      case 'config': {
        if (hasFlag(rest, '--global', '--system'))
          return this.hard('system', 'git config --global');
        const reads = rest.some((a) =>
          /^(--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope|--name-only)/.test(
            a,
          ),
        );
        if (
          reads ||
          (pos.length === 1 &&
            !hasFlag(
              rest,
              '--unset',
              '--unset-all',
              '--add',
              '--replace-all',
              '--rename-section',
              '--remove-section',
              '-e',
              '--edit',
            ))
        ) {
          return this.cat('command_readonly');
        }
        return this.hard('git_metadata', 'git config');
      }
      case 'update-ref':
      case 'worktree':
      case 'replace':
      case 'filter-branch':
      case 'filter-repo':
      case 'update-index':
        return this.hard('git_metadata', `git ${sub}`);
      case 'symbolic-ref':
        return pos.length >= 2
          ? this.hard('git_metadata', 'git symbolic-ref')
          : this.cat('command_readonly');
      case 'switch':
        return this.hard('branch', 'git switch');
      case 'checkout': {
        if (hasFlag(rest, '-b', '-B', '--orphan', '--detach', '-t', '--track')) {
          return this.hard('branch', 'git checkout -b');
        }
        const dd = rest.indexOf('--');
        const names = positionals(dd >= 0 ? rest.slice(0, dd) : rest);
        const pathsOnly = names.every(
          (n) => n === '.' || (this.ctx.inside(n) && (this.ctx.exists?.(n) ?? false)),
        );
        if (dd >= 0 && names.length <= 1) {
          for (const p of rest.slice(dd + 1)) this.pathArg(p, 'write');
          return this.cat('git_local');
        }
        if (names.length > 0 && pathsOnly) return this.cat('git_local');
        return this.hard('branch', `git checkout ${names[0] ?? ''}`.trim());
      }
      case 'branch': {
        if (
          rest.some(
            (a) =>
              /^(-[dDmMcCf]|--delete|--move|--copy|--force|-u|--set-upstream-to|--unset-upstream|--edit-description)$/.test(
                a,
              ) || /^-[a-zA-Z]*[dDmMf]/.test(a),
          )
        ) {
          return this.hard('branch', 'git branch -d/-m');
        }
        return this.cat(pos.length === 0 ? 'command_readonly' : 'git_local');
      }
      case 'fetch':
      case 'pull':
      case 'ls-remote':
        return this.cat('network_read');
      case 'clone': {
        const target = pos[1];
        if (target) this.pathArg(target, 'write');
        return this.cat('network_read');
      }
      case 'submodule':
        return this.cat(pos[0] === 'foreach' ? 'command_other' : 'network_read');
      case 'status':
      case 'diff':
      case 'log':
      case 'show':
      case 'ls-files':
      case 'rev-parse':
      case 'blame':
      case 'grep':
      case 'describe':
      case 'shortlog':
      case 'cat-file':
      case 'ls-tree':
      case 'rev-list':
      case 'name-rev':
      case 'merge-base':
      case 'show-ref':
      case 'for-each-ref':
      case 'count-objects':
      case 'reflog':
      case 'whatchanged':
      case 'check-ignore':
        if (readOnly()) return this.cat('command_readonly');
        for (const a of rest) {
          if (a.startsWith('--output')) this.pathArg(a.slice(a.indexOf('=') + 1), 'write');
        }
        return this.cat('git_local');
      default:
        for (const p of pos) if (looksLikePath(p)) this.pathArg(p, 'write');
        return this.cat(
          /^(add|commit|merge|rebase|reset|restore|rm|mv|stash|cherry-pick|revert|apply|am|tag|clean|gc|prune|notes|bisect|init|format-patch|archive|rerere|sparse-checkout|maintenance|mergetool|difftool|range-diff|lfs)$/.test(
            sub,
          )
            ? 'git_local'
            : 'command_other',
        );
    }
  }

  private gh(args: string[]): void {
    const [group, action] = positionals(args);
    const pair = `${group ?? ''} ${action ?? ''}`.trim();
    if (
      /^(pr (create|merge|close|edit|comment|review|ready|reopen)|release .+|repo (create|delete|edit|fork|sync|rename|archive)|issue (create|close|comment|edit|delete|reopen|transfer)|workflow (run|enable|disable)|run (rerun|cancel)|secret .+|variable .+|gist (create|edit|delete)|label (create|edit|delete)|auth .+|ssh-key .+|gpg-key .+)$/.test(
        pair,
      )
    ) {
      return this.hard(
        group === 'auth' || group === 'ssh-key' || group === 'gpg-key'
          ? 'credentials'
          : 'publish_remote',
        `gh ${pair}`,
      );
    }
    if (group === 'api') {
      const method =
        args.find((a, i) => args[i - 1] === '-X' || args[i - 1] === '--method') ?? 'GET';
      if (
        method.toUpperCase() !== 'GET' ||
        hasFlag(args, '-f', '-F', '--field', '--raw-field', '--input')
      ) {
        return this.hard('network_send', 'gh api with a body');
      }
    }
    this.cat('network_read');
  }

  private download(prog: string, args: string[], dialect: ShellDialect): void {
    const ps =
      prog.startsWith('i') || (dialect === 'powershell' && (prog === 'curl' || prog === 'wget'));
    if (ps) {
      const lower = args.map((a) => a.toLowerCase());
      const m = lower.findIndex((a) => a === '-method');
      if (
        (m >= 0 && !/^(get|head)$/.test(lower[m + 1] ?? '')) ||
        lower.some((a) => /^-(body|infile|form)$/.test(a))
      ) {
        return this.hard('network_send', `${prog} with a body`);
      }
      const out = lower.findIndex((a) => a === '-outfile');
      if (out >= 0 && args[out + 1]) this.pathArg(args[out + 1]!, 'write');
      return this.cat('network_read');
    }
    if (prog === 'curl') {
      const sends =
        hasFlag(
          args,
          '--data',
          '--data-binary',
          '--data-raw',
          '--data-urlencode',
          '--data-ascii',
          '--form',
          '--form-string',
          '--upload-file',
          '--json',
          '-d',
          '-F',
          '-T',
        ) ||
        args.some((a) => /^-[a-zA-Z]*[dFT]/.test(a) && !a.startsWith('--')) ||
        args.some(
          (a, i) =>
            (args[i - 1] === '-X' || args[i - 1] === '--request') && !/^(get|head)$/i.test(a),
        ) ||
        args.some((a) => /^-X(?!get$|head$)\w+/i.test(a) || /^--request=(?!get$|head$)/i.test(a));
      if (sends) return this.hard('network_send', 'curl with a body');
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-o' || args[i] === '--output') this.pathArg(args[i + 1] ?? '', 'write');
        else if (args[i]!.startsWith('--output=')) this.pathArg(args[i]!.slice(9), 'write');
      }
      return this.cat('network_read');
    }
    if (prog === 'wget') {
      if (hasFlag(args, '--post-data', '--post-file', '--method', '--body-data', '--body-file')) {
        return this.hard('network_send', 'wget with a body');
      }
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-O' || args[i] === '-P') this.pathArg(args[i + 1] ?? '', 'write');
      }
    }
    this.cat('network_read');
  }

  private packageManager(prog: string, args: string[]): void {
    if (hasFlag(args, '-g', '--global', '--location=global') || positionals(args)[0] === 'global') {
      return this.hard('system', `${prog} global install`);
    }
    const pos = positionals(
      args.filter(
        (a, i) =>
          !(
            args[i - 1] === '--filter' ||
            args[i - 1] === '-F' ||
            args[i - 1] === '--dir' ||
            args[i - 1] === '-C' ||
            args[i - 1] === '--prefix' ||
            args[i - 1] === '-w' ||
            args[i - 1] === '--workspace'
          ),
      ),
    );
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--dir' || args[i] === '-C' || args[i] === '--prefix')
        this.pathArg(args[i + 1] ?? '', 'write');
    }
    const sub = pos[0];
    const pkgs = pos.slice(1);
    if (sub === undefined)
      return this.cat(prog === 'yarn' || prog === 'bun' ? 'deps_install' : 'command_other');
    switch (sub) {
      case 'install':
      case 'i':
      case 'isntall':
        return this.cat(pkgs.length > 0 ? 'deps_add' : 'deps_install');
      case 'ci':
      case 'remove':
      case 'rm':
      case 'uninstall':
      case 'un':
      case 'prune':
      case 'dedupe':
      case 'rebuild':
      case 'import':
        return this.cat('deps_install');
      case 'add':
      case 'update':
      case 'up':
      case 'upgrade':
        return this.cat('deps_add');
      case 'dlx':
      case 'x':
      case 'create':
        return this.npx(pos.slice(1));
      case 'exec':
        return this.cat(prog === 'npm' ? 'deps_add' : 'build_test');
      case 'publish':
      case 'unpublish':
      case 'deprecate':
      case 'dist-tag':
      case 'owner':
      case 'access':
      case 'team':
      case 'org':
      case 'star':
      case 'hook':
        return this.hard('publish_remote', `${prog} ${sub}`);
      case 'login':
      case 'logout':
      case 'adduser':
      case 'token':
        return this.hard('credentials', `${prog} ${sub}`);
      case 'config':
      case 'set':
        return pos[1] === 'get' || pos[1] === 'list' || pos[1] === 'ls'
          ? this.cat('command_readonly')
          : this.hard('system', `${prog} config set`);
      case 'store':
      case 'env':
      case 'setup':
      case 'self-update':
      case 'link':
        return this.hard('system', `${prog} ${sub}`);
      case 'audit':
      case 'outdated':
      case 'view':
      case 'info':
      case 'show':
        return this.cat('network_read');
      default:
        // run / test / a script name.
        return this.cat(
          PM_BUILTINS.has(sub) &&
            sub !== 'run' &&
            sub !== 'run-script' &&
            sub !== 'test' &&
            sub !== 't'
            ? 'command_other'
            : 'build_test',
        );
    }
  }

  private npx(args: string[]): void {
    const pkg =
      positionals(
        args.filter((a, i) => !(args[i - 1] === '-p' || args[i - 1] === '--package')),
      )[0] ?? '';
    const named = [
      pkg,
      ...args.filter((_, i) => args[i - 1] === '-p' || args[i - 1] === '--package'),
    ];
    if (named.some((p) => AGENT_PACKAGES.test(p) || AGENT_CLIS.has(programName(p)))) {
      return this.hard('self_escalation', `npx ${pkg}`);
    }
    this.cat('deps_add');
  }

  private pip(args: string[]): void {
    const pos = positionals(args);
    const sub = pos[0];
    if (sub === 'install') {
      if (hasFlag(args, '--user', '--target', '--prefix', '--root'))
        return this.hard('system', 'pip install --user');
      const fromManifest =
        hasFlag(args, '-r', '--requirement', '-e', '--editable', '-c', '--constraint') ||
        pos.slice(1).every((p) => p === '.' || p.startsWith('./') || p.startsWith('.\\'));
      return this.cat(fromManifest ? 'deps_install' : 'deps_add');
    }
    if (sub === 'download') return this.cat('network_read');
    if (sub === 'uninstall') return this.cat('deps_install');
    if (sub === 'config') return this.hard('system', 'pip config');
    this.cat('command_other');
  }

  private toolchain(prog: string, args: string[]): void {
    const pos = positionals(args);
    const sub = pos[0] ?? '';
    const two = `${sub} ${pos[1] ?? ''}`.trim();
    const table: Record<string, Record<string, CommandCategory | HardRule>> = {
      uv: {
        sync: 'deps_install',
        lock: 'deps_install',
        venv: 'deps_install',
        run: 'build_test',
        add: 'deps_add',
        remove: 'deps_install',
        publish: 'publish_remote',
        tool: 'system',
        self: 'system',
        python: 'system',
        build: 'build_test',
      },
      poetry: {
        install: 'deps_install',
        lock: 'deps_install',
        add: 'deps_add',
        update: 'deps_add',
        remove: 'deps_install',
        run: 'build_test',
        build: 'build_test',
        publish: 'publish_remote',
        self: 'system',
        config: 'system',
      },
      pipenv: {
        install: 'deps_install',
        sync: 'deps_install',
        run: 'build_test',
        update: 'deps_add',
      },
      cargo: {
        build: 'build_test',
        b: 'build_test',
        check: 'build_test',
        c: 'build_test',
        test: 'build_test',
        t: 'build_test',
        clippy: 'build_test',
        fmt: 'build_test',
        run: 'build_test',
        r: 'build_test',
        bench: 'build_test',
        doc: 'build_test',
        clean: 'build_test',
        metadata: 'build_test',
        tree: 'build_test',
        fetch: 'deps_install',
        vendor: 'deps_install',
        update: 'deps_add',
        add: 'deps_add',
        remove: 'deps_install',
        install: 'system',
        uninstall: 'system',
        publish: 'publish_remote',
        yank: 'publish_remote',
        owner: 'publish_remote',
        login: 'credentials',
        logout: 'credentials',
      },
      go: {
        build: 'build_test',
        test: 'build_test',
        vet: 'build_test',
        run: 'build_test',
        fmt: 'build_test',
        generate: 'build_test',
        list: 'build_test',
        mod: 'deps_install',
        get: 'deps_add',
        install: 'system',
        work: 'build_test',
        clean: 'build_test',
        tool: 'build_test',
        version: 'command_readonly',
      },
      gem: {
        install: 'system',
        uninstall: 'system',
        push: 'publish_remote',
        build: 'build_test',
        list: 'command_readonly',
      },
      bundle: {
        install: 'deps_install',
        exec: 'build_test',
        add: 'deps_add',
        update: 'deps_add',
        config: 'system',
      },
      composer: {
        install: 'deps_install',
        require: 'deps_add',
        update: 'deps_add',
        run: 'build_test',
        test: 'build_test',
        global: 'system',
      },
      dotnet: {
        build: 'build_test',
        test: 'build_test',
        run: 'build_test',
        format: 'build_test',
        clean: 'build_test',
        restore: 'deps_install',
        add: 'deps_add',
        tool: 'system',
        nuget: 'publish_remote',
        publish: 'build_test',
        pack: 'build_test',
      },
      deno: {
        test: 'build_test',
        run: 'build_test',
        task: 'build_test',
        check: 'build_test',
        fmt: 'build_test',
        lint: 'build_test',
        bench: 'build_test',
        compile: 'build_test',
        install: 'system',
        add: 'deps_add',
        publish: 'publish_remote',
        eval: 'command_other',
      },
    };
    if (prog === 'go' && two === 'env -w') return this.hard('system', 'go env -w');
    if (prog === 'dotnet' && sub === 'nuget' && pos[1] !== 'push') return this.cat('command_other');
    if (prog === 'go' && sub === 'mod' && (pos[1] === 'init' || pos[1] === 'edit'))
      return this.cat('command_other');
    if (prog === 'uv' && sub === 'pip') return this.pip(args.slice(args.indexOf('pip') + 1));
    const r = table[prog]?.[sub];
    if (!r) return this.cat('command_other');
    if (isHardRule(r)) return this.hard(r, `${prog} ${sub}`);
    this.pathArgs(prog, args.slice(1), 'write');
    this.cat(r);
  }

  private containerReadOnly(args: string[]): boolean {
    const sub = positionals(args)[0];
    return (
      !!sub &&
      /^(ps|images|image|inspect|logs|version|info|stats|top|port|history|search)$/.test(sub)
    );
  }
}

const HARD_RULE_IDS = new Set<string>([
  'git_metadata',
  'outside_write',
  'credentials',
  'publish_remote',
  'branch',
  'network_send',
  'system',
  'self_escalation',
  'download_exec',
  'opaque',
]);
function isHardRule(x: string): x is HardRule {
  return HARD_RULE_IDS.has(x);
}

/** `.claude/settings.json` / `.claude/settings.local.json` (agent CLI settings). */
export function isClaudeSettings(p: string): boolean {
  return /(^|[\\/])\.claude[\\/]settings(\.local)?\.json$/i.test(p);
}
