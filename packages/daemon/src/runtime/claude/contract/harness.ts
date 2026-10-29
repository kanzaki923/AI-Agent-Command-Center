import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_ENV_ALLOWLIST, allowlistedEnv } from '../../env';
import { locateClaudeCode } from '../locate';
import { BlockingProxy, FakeAnthropicServer, type FakeAnthropicOptions } from './fakeAnthropic';

/**
 * An isolated sandbox for running the real Claude Code CLI against the fake API:
 *
 * - a fresh temp root with its own HOME / USERPROFILE / APPDATA / LOCALAPPDATA / TEMP and
 *   CLAUDE_CONFIG_DIR, so the user's ~/.claude and ~/.claude.json are never read or written;
 * - a temp git repository as the agent's cwd;
 * - a parent environment built from our allowlist only (the developer's ANTHROPIC_* and
 *   other variables never reach the CLI), with HTTPS_PROXY / HTTP_PROXY pointing at a proxy
 *   that refuses everything and NO_PROXY for the fake API, so an attempt to reach a real host
 *   is blocked and recorded.
 */
export interface CliSandbox {
  root: string;
  /** The agent's working directory (a git repo with one commit). */
  repo: string;
  /** A directory outside the repo (for "outside the workspace" scenarios). */
  outside: string;
  configDir: string;
  api: FakeAnthropicServer;
  proxy: BlockingProxy;
  /** Parent env for `ClaudeAgentSdkRuntime({ parentEnv })` (no model routing yet). */
  parentEnv: Record<string, string>;
  cleanup(): Promise<void>;
}

/** The bundled CLI when the SDK's platform package is installed, else null (skip). */
export function locateBundledCli(): { path: string } | null {
  // Only the SDK's own binary: a user-installed `claude` may be another version.
  const loc = locateClaudeCode({ env: {}, bundleDir: null, home: '/nonexistent' });
  return loc.ok && loc.source === 'sdk' ? { path: loc.path } : null;
}

export async function createCliSandbox(opts: FakeAnthropicOptions = {}): Promise<CliSandbox> {
  const root = mkdtempSync(join(tmpdir(), 'acc-sdk-contract-'));
  const home = join(root, 'home');
  const configDir = join(home, '.claude');
  const repo = join(root, 'repo');
  const outside = join(root, 'outside');
  const temp = join(root, 'tmp');
  for (const d of [
    home,
    configDir,
    repo,
    outside,
    temp,
    join(home, 'AppData', 'Roaming'),
    join(home, 'AppData', 'Local'),
  ]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(outside, 'secret.txt'), 'outside the workspace\n');

  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=acc-test', '-c', 'user.email=acc-test@example.invalid', ...args],
      {
        cwd: repo,
        env: { ...gitEnv(home), PATH: process.env.PATH ?? process.env.Path ?? '' },
        stdio: 'pipe',
      },
    );
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# sample\n\nhello\n');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  const api = new FakeAnthropicServer(opts);
  const proxy = new BlockingProxy();
  await api.start();
  await proxy.start();

  // Only process basics come from the real environment; everything user-specific is the sandbox's.
  const base = allowlistedEnv(process.env, [
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'WINDIR',
    'COMSPEC',
    'OS',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
    'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)',
    'CLAUDE_CODE_GIT_BASH_PATH',
  ]);
  const parentEnv: Record<string, string> = {
    ...base,
    ...gitEnv(home),
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    CLAUDE_CONFIG_DIR: configDir,
    HTTPS_PROXY: proxy.url,
    HTTP_PROXY: proxy.url,
    NO_PROXY: '127.0.0.1,localhost',
  };
  // Everything we set must survive the runtime's allowlist filter, or the isolation leaks.
  const allowed = new Set(BASE_ENV_ALLOWLIST.map((k) => k.toUpperCase()));
  for (const k of Object.keys(parentEnv)) {
    if (!allowed.has(k.toUpperCase())) {
      throw new Error(`sandbox env ${k} would be dropped by the runtime's allowlist`);
    }
  }

  return {
    root,
    repo,
    outside,
    configDir,
    api,
    proxy,
    parentEnv,
    async cleanup() {
      await api.close();
      await proxy.close();
      // The CLI may still be releasing files on Windows for a moment.
      for (let i = 0; i < 10; i++) {
        try {
          rmSync(root, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    },
  };
}

function gitEnv(home: string): Record<string, string> {
  return { HOME: home, USERPROFILE: home };
}

/** PIDs of Claude Code CLI processes that are children of this process (leak check). */
export function childCliProcesses(): number[] {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid} AND Name='claude.exe'" | ForEach-Object { $_.ProcessId }`,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      ).toString();
      return out.split(/\s+/).filter(Boolean).map(Number);
    }
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    return out
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter(([, ppid, comm]) => Number(ppid) === process.pid && /claude$/.test(comm ?? ''))
      .map(([pid]) => Number(pid));
  } catch {
    return [];
  }
}
