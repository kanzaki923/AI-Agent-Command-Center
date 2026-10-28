/**
 * Test-only helpers: throwaway git repositories in the OS temp dir. Not used at runtime.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git, gitOut } from './git';

/**
 * Make git ignore the developer's global/system config (signing, hooks paths, autocrlf …)
 * for the rest of the test file. Returns a restore function.
 */
export function isolateGitConfig(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'acc-gitcfg-'));
  const file = join(dir, 'gitconfig');
  writeFileSync(file, '');
  const saved = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  process.env.GIT_CONFIG_GLOBAL = file;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  };
}

export interface TempRepo {
  path: string;
  git(...args: string[]): Promise<string>;
  write(file: string, content: string, cwd?: string): void;
  /** Stage everything and commit in `cwd` (default: the repo). Returns the sha. */
  commit(message: string, cwd?: string): Promise<string>;
  cleanup(): Promise<void>;
}

/** `git init -b main` with one commit (README.md), LF line endings and no signing. */
export async function createTempRepo(files: Record<string, string> = {}): Promise<TempRepo> {
  const path = mkdtempSync(join(tmpdir(), 'acc-repo-'));
  const run = (cwd: string, args: string[]) => gitOut(cwd, args);
  await run(path, ['init', '-q', '-b', 'main']);
  for (const [k, v] of Object.entries({
    'core.autocrlf': 'false',
    'core.eol': 'lf',
    'commit.gpgsign': 'false',
    'user.name': 'Test User',
    'user.email': 'test@example.com',
  })) {
    await run(path, ['config', k, v]);
  }
  const write = (file: string, content: string, cwd = path) => {
    const full = join(cwd, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const commit = async (message: string, cwd = path) => {
    await run(cwd, ['add', '-A']);
    await run(cwd, ['commit', '-q', '-m', message]);
    return run(cwd, ['rev-parse', 'HEAD']);
  };
  write('README.md', '# test\n');
  for (const [f, c] of Object.entries(files)) write(f, c);
  await commit('initial');
  return {
    path,
    git: (...args) => run(path, args),
    write,
    commit,
    async cleanup() {
      await git(path, ['worktree', 'prune'], { okCodes: [0, 128] }).catch(() => undefined);
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
