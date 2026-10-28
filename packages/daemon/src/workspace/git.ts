import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { BASE_ENV_ALLOWLIST, allowlistedEnv } from '../runtime/env';

/**
 * Thin async wrapper around the git CLI. Always spawned with an argument array (never a
 * shell string), so paths and branch names with spaces or shell metacharacters are safe on
 * every platform, and the event loop is never blocked.
 */

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitOptions {
  /** Exit codes treated as success (default [0]). */
  okCodes?: number[];
  /** Extra environment variables (merged over the allowlisted environment). */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

/** A failed git invocation. The message is user-facing (Japanese) and includes git's stderr. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly cwd: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Options prepended to every command: stable, unquoted, non-interactive output, and nothing
 * that executes repository-controlled programs. Worktree contents are written by agents, so
 * hooks (a relative `core.hooksPath` such as husky's points into the tree) and fsmonitor
 * must never run from the daemon's own git calls.
 */
const BASE_ARGS = [
  '-c',
  'core.quotepath=false',
  '-c',
  'color.ui=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  `core.hooksPath=${devNull}`,
];

/**
 * Environment git gets: the process basics plus git's own config selectors. Not the
 * daemon's whole environment, which holds the LiteLLM key and the user's other secrets.
 */
const GIT_ENV_ALLOWLIST: readonly string[] = [
  ...BASE_ENV_ALLOWLIST,
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
];

const BASE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  // Never open an editor or pager from a daemon.
  GIT_PAGER: 'cat',
  GIT_MERGE_AUTOEDIT: 'no',
};

function describe(args: readonly string[]): string {
  const shown = args.slice(0, 4).join(' ');
  return args.length > 4 ? `git ${shown} …` : `git ${shown}`;
}

export function git(
  cwd: string,
  args: readonly string[],
  opts: GitOptions = {},
): Promise<GitResult> {
  const okCodes = opts.okCodes ?? [0];
  let pinned: Record<string, string>;
  try {
    pinned = pinLinkedWorktree(cwd);
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', [...BASE_ARGS, ...args], {
      cwd,
      env: {
        ...allowlistedEnv(process.env, GIT_ENV_ALLOWLIST),
        ...BASE_ENV,
        ...pinned,
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      signal: opts.signal,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') {
        reject(
          new GitError(
            'git が見つかりません。Git をインストールし、PATH から実行できるようにしてください。',
            args,
            cwd,
            null,
            '',
          ),
        );
      } else if (e.name === 'AbortError') {
        reject(new GitError(`${describe(args)} は中断されました`, args, cwd, null, ''));
      } else {
        reject(
          new GitError(
            `${describe(args)} を実行できませんでした: ${e.message}`,
            args,
            cwd,
            null,
            '',
          ),
        );
      }
    });
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      const exit = code ?? -1;
      if (okCodes.includes(exit)) {
        resolvePromise({ stdout, stderr, code: exit });
        return;
      }
      const reason = (stderr.trim() || stdout.trim()).split(/\r?\n/).slice(-5).join('\n');
      reject(
        new GitError(
          `${describe(args)} が失敗しました（終了コード ${exit}）${reason ? `: ${reason}` : ''}`,
          args,
          cwd,
          exit,
          stderr,
        ),
      );
    });
  });
}

/**
 * A linked worktree's `.git` is a file in the (agent-writable) tree that tells git where the
 * repository is. Redirected to a directory the agent made, it would hand git an attacker's
 * config. So it must point at `<common>/worktrees/<name>` outside the tree, whose `gitdir`
 * points back here; the checked location is then pinned with GIT_DIR / GIT_WORK_TREE.
 * Plain repositories (a `.git` directory) and non-repositories are left alone.
 */
export function pinLinkedWorktree(cwd: string): Record<string, string> {
  const dotGit = path.join(cwd, '.git');
  let isFile: boolean;
  try {
    isFile = statSync(dotGit).isFile();
  } catch {
    return {};
  }
  if (!isFile) return {};
  const tampered = (why: string) =>
    new GitError(
      `ワークスペースの .git が想定外の場所を指しているため、git を実行しません（${why}）: ${cwd}`,
      [],
      cwd,
      null,
      '',
    );
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
  if (!m?.[1]) throw tampered('gitdir がありません');
  const real = (p: string) => {
    try {
      return realpathSync.native(p);
    } catch {
      throw tampered(`${p} が見つかりません`);
    }
  };
  const gitDir = real(path.resolve(cwd, m[1]));
  const root = real(cwd);
  const fold = (s: string) =>
    process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s;
  const rel = path.relative(fold(root), fold(gitDir));
  const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (!outside) throw tampered('作業ツリーの中を指しています');
  if (path.basename(path.dirname(gitDir)) !== 'worktrees') {
    throw tampered('リポジトリの worktrees ではありません');
  }
  let back: string;
  try {
    back = readFileSync(path.join(gitDir, 'gitdir'), 'utf8').trim();
  } catch {
    throw tampered('戻り先がありません');
  }
  if (fold(real(path.dirname(path.resolve(gitDir, back)))) !== fold(root)) {
    throw tampered('戻り先が一致しません');
  }
  return { GIT_DIR: gitDir, GIT_WORK_TREE: path.resolve(cwd) };
}

/** Run git and return trimmed stdout. */
export async function gitOut(
  cwd: string,
  args: readonly string[],
  opts?: GitOptions,
): Promise<string> {
  return (await git(cwd, args, opts)).stdout.trim();
}

/** True when git exits 0, false when it exits 1 (e.g. `merge-base --is-ancestor`). */
export async function gitTest(
  cwd: string,
  args: readonly string[],
  opts?: GitOptions,
): Promise<boolean> {
  const r = await git(cwd, args, { ...opts, okCodes: [0, 1] });
  return r.code === 0;
}

/** Resolve a ref to a commit sha, or null if it does not exist. */
export async function resolveCommit(cwd: string, ref: string): Promise<string | null> {
  const r = await git(
    cwd,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
    {
      okCodes: [0, 1, 128],
    },
  );
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return gitTest(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
}

export async function isValidBranchName(cwd: string, branch: string): Promise<boolean> {
  const r = await git(cwd, ['check-ref-format', '--branch', branch], { okCodes: [0, 1, 128] });
  return r.code === 0 && !branch.startsWith('-');
}

/** Current branch name, or null when HEAD is detached. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    okCodes: [0, 1, 128],
  });
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/** Top-level directory of the repository / worktree containing `cwd`, or null if not a repo. */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const r = await git(cwd, ['rev-parse', '--show-toplevel'], { okCodes: [0, 128] });
    return r.code === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** Porcelain status lines (empty when clean). `untracked: false` ignores untracked files. */
export async function statusLines(
  cwd: string,
  opts: { untracked?: boolean } = {},
): Promise<string[]> {
  const args = ['status', '--porcelain'];
  if (opts.untracked === false) args.push('--untracked-files=no');
  const out = await gitOut(cwd, args);
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  /** Short branch name (without refs/heads/), null when detached. */
  branch: string | null;
  bare: boolean;
}

export async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const out = (await git(cwd, ['worktree', 'list', '--porcelain', '-z'])).stdout;
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const field of out.split('\0')) {
    if (field === '') {
      if (cur) entries.push(cur);
      cur = null;
      continue;
    }
    const sp = field.indexOf(' ');
    const key = sp === -1 ? field : field.slice(0, sp);
    const value = sp === -1 ? '' : field.slice(sp + 1);
    if (key === 'worktree') {
      if (cur) entries.push(cur);
      cur = { path: value, head: null, branch: null, bare: false };
    } else if (cur && key === 'HEAD') {
      cur.head = value;
    } else if (cur && key === 'branch') {
      cur.branch = value.replace(/^refs\/heads\//, '');
    } else if (cur && key === 'bare') {
      cur.bare = true;
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

/** Files with unresolved conflicts in the current merge. */
export async function conflictedFiles(cwd: string): Promise<string[]> {
  const out = (await git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout;
  return out.split('\0').filter(Boolean);
}

export async function gitAvailable(): Promise<boolean> {
  try {
    await git(process.cwd(), ['--version']);
    return true;
  } catch {
    return false;
  }
}
