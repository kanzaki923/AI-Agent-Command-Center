import { spawn } from 'node:child_process';

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
  /** Extra environment variables (merged over process.env). */
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

/** Options prepended to every command: stable, unquoted, non-interactive output. */
const BASE_ARGS = ['-c', 'core.quotepath=false', '-c', 'color.ui=false'];

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
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', [...BASE_ARGS, ...args], {
      cwd,
      env: { ...process.env, ...BASE_ENV, ...opts.env },
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
