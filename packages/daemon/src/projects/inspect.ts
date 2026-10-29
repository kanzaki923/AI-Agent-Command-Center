import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { FolderInspection, RepoInspection } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { branchExists, currentBranch, git, gitOut, repoRoot, statusLines } from '../workspace/git';

const EMPTY: Omit<RepoInspection, 'ok' | 'reason'> = {
  repoRoot: null,
  defaultBranch: null,
  currentBranch: null,
  isDirty: null,
  suggestedName: null,
  suggestedTestCommand: null,
  existingProjectId: null,
};

/**
 * project.inspectRepo: can this folder become a project? Read-only (runs git queries
 * only). The UI calls it before project.create to validate the path and prefill the form.
 */
export async function inspectRepo(ctx: DaemonContext, path: string): Promise<RepoInspection> {
  const fail = (reason: string, extra: Partial<RepoInspection> = {}): RepoInspection => ({
    ok: false,
    reason,
    ...EMPTY,
    ...extra,
  });
  if (!isAbsolute(path)) return fail('フォルダは絶対パスで指定してください');
  if (!existsSync(path)) return fail('フォルダが見つかりません');
  if (!statSync(path).isDirectory()) return fail('ファイルではなくフォルダを指定してください');

  const root = await repoRoot(path);
  if (!root) return fail('このフォルダは git リポジトリではありません（git init が必要です）');
  if (!samePath(root, path)) {
    return fail(
      'リポジトリのルートではなく、その中のフォルダです。リポジトリのルートを指定してください',
      { repoRoot: resolve(root) },
    );
  }
  const head = await currentBranch(path);
  const [defaultBranch, dirty] = await Promise.all([
    detectDefaultBranch(path, head),
    statusLines(path)
      .then((l) => l.length > 0)
      .catch(() => null),
  ]);
  const existing = ctx.repos.projects
    .find({ where: {} })
    .find((p) => p.repoPath && samePath(p.repoPath, path));
  return {
    ok: true,
    reason: null,
    repoRoot: path,
    defaultBranch,
    currentBranch: head,
    isDirty: dirty,
    suggestedName: basename(resolve(path)) || null,
    suggestedTestCommand: detectTestCommand(path),
    existingProjectId: existing?.id ?? null,
  };
}

/**
 * project.inspectFolder (spec 20261029 §2.2): can this folder back a project? Any existing
 * folder can (git is optional); for a folder inside a git repository it names the repository
 * root and suggests its default branch and test command. Read-only.
 */
export async function inspectFolder(ctx: DaemonContext, path: string): Promise<FolderInspection> {
  const fail = (reason: string): FolderInspection => ({
    ok: false,
    reason,
    path: null,
    isGitRepo: false,
    repoRoot: null,
    defaultBranch: null,
    suggestedName: null,
    suggestedTestCommand: null,
    existingProjectId: null,
  });
  if (!isAbsolute(path)) return fail('フォルダは絶対パスで指定してください');
  if (!existsSync(path)) return fail('フォルダが見つかりません');
  if (!statSync(path).isDirectory()) return fail('ファイルではなくフォルダを指定してください');
  const abs = resolve(path);
  const root = await repoRoot(abs).catch(() => null);
  const rootPath = root ? resolve(root) : null;
  const defaultBranch = rootPath
    ? await detectDefaultBranch(rootPath, await currentBranch(rootPath)).catch(() => null)
    : null;
  const existing = ctx.repos.projects
    .find({ where: {} })
    .find(
      (p) =>
        (p.folderPath && samePath(p.folderPath, abs)) ||
        (p.repoPath && (samePath(p.repoPath, abs) || (rootPath && samePath(p.repoPath, rootPath)))),
    );
  return {
    ok: true,
    reason: null,
    path: abs,
    isGitRepo: rootPath !== null,
    repoRoot: rootPath,
    defaultBranch,
    suggestedName: basename(abs) || null,
    suggestedTestCommand: detectTestCommand(rootPath ?? abs),
    existingProjectId: existing?.id ?? null,
  };
}

/** origin/HEAD, else main / master, else the checked-out branch. */
async function detectDefaultBranch(path: string, head: string | null): Promise<string | null> {
  const r = await git(path, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    okCodes: [0, 1, 128],
  });
  const remote = r.code === 0 ? r.stdout.trim().replace(/^origin\//, '') : '';
  if (remote && (await branchExists(path, remote))) return remote;
  for (const name of ['main', 'master']) if (await branchExists(path, name)) return name;
  if (head) return head;
  // Unborn HEAD (no commit yet): the branch it will create.
  return (await gitOut(path, ['symbolic-ref', '--short', 'HEAD']).catch(() => '')) || null;
}

/**
 * The command that verifies the project, from what the repository contains: a package.json
 * `test` script (with the package manager its lockfile names), Cargo, Go, or pytest.
 */
export function detectTestCommand(path: string): string | null {
  const has = (f: string) => existsSync(join(path, f));
  if (has('package.json')) {
    let script: unknown;
    try {
      const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as {
        scripts?: Record<string, unknown>;
      };
      script = pkg.scripts?.test;
    } catch {
      script = undefined;
    }
    // npm init's placeholder fails on purpose; it is not a test suite.
    if (typeof script === 'string' && script.trim() && !/no test specified/.test(script)) {
      if (has('pnpm-lock.yaml')) return 'pnpm test';
      if (has('yarn.lock')) return 'yarn test';
      if (has('bun.lockb') || has('bun.lock')) return 'bun test';
      return 'npm test';
    }
  }
  if (has('Cargo.toml')) return 'cargo test';
  if (has('go.mod')) return 'go test ./...';
  if (has('pytest.ini') || has('conftest.py') || pyprojectUsesPytest(path)) return 'pytest';
  if (has('setup.py') || has('pyproject.toml')) {
    if (has('tests') || has('test')) return 'pytest';
  }
  return null;
}

function pyprojectUsesPytest(path: string): boolean {
  for (const f of ['pyproject.toml', 'setup.cfg', 'tox.ini']) {
    try {
      if (/\[tool[.:]pytest/.test(readFileSync(join(path, f), 'utf8'))) return true;
    } catch {
      // not there
    }
  }
  return false;
}

/** Same directory, ignoring separators, case on Windows/macOS, and symlinks. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    let r = resolve(p);
    try {
      r = realpathSync.native(r);
    } catch {
      // keep the resolved path
    }
    r = r.replace(/[\\/]+$/, '');
    return process.platform === 'linux' ? r : r.toLowerCase();
  };
  return norm(a) === norm(b);
}
