/**
 * The single-file bundle the desktop app ships (scripts/bundle.js) must boot as a real
 * process with nothing but Node: no node_modules next to it, no tsx.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AccClient, createClient } from '@acc/client';
import { DaemonInfo } from '@acc/protocol';
import { createTempRepo, isolateGitConfig } from './workspace/git-fixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const pkgDir = join(import.meta.dirname, '..');
let root: string;
let bundle: string;
const children: ChildProcess[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'acc-bundle-'));
  bundle = join(root, 'daemon', 'main.mjs');
  execFileSync(process.execPath, [join(pkgDir, 'scripts', 'bundle.js'), '--out', bundle], {
    stdio: 'pipe',
  });
}, 60_000);

afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function startBundled(home: string): { child: ChildProcess; exited: Promise<number | null> } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('ACC_')) delete env[k];
  Object.assign(env, {
    ACC_HOME: home,
    ACC_PORT: '0',
    ACC_LOG_LEVEL: 'warn',
    // Points nowhere: proves the bundled SDK loads and the locator runs inside the bundle.
    ACC_CLAUDE_CODE_PATH: join(root, 'no-such-claude.exe'),
  });
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--enable-source-maps', bundle],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code)),
  );
  return { child, exited };
}

async function until<T>(probe: () => T | null | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function readInfo(home: string): DaemonInfo | null {
  try {
    return DaemonInfo.parse(JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')));
  } catch {
    return null;
  }
}

describe('daemon bundle', () => {
  it('inlines every dependency, including the Agent SDK JavaScript', () => {
    const code = readFileSync(bundle, 'utf8');
    expect(code).not.toMatch(/from\s*["']@anthropic-ai\/claude-agent-sdk["']/);
    expect(code).not.toMatch(/from\s*["'](ws|zod|@acc\/protocol)["']/);
    expect(code).toContain('pathToClaudeCodeExecutable');
  });

  it('boots with plain node, refuses a second instance, runs, and stops on system.shutdown', async () => {
    const home = join(root, 'home');
    const first = startBundled(home);
    const info = await until(() => readInfo(home), 20_000);
    const health = (await (await fetch(`http://127.0.0.1:${info.port}/health`)).json()) as {
      service: string;
      pid: number;
    };
    expect(health).toMatchObject({ service: 'acc-daemon', pid: first.child.pid });

    // Same ACC_HOME: the second one leaves the first in charge and exits 0.
    const second = startBundled(home);
    expect(await second.exited).toBe(0);
    expect(readInfo(home)?.pid).toBe(first.child.pid);

    const client: AccClient = createClient({
      url: `ws://127.0.0.1:${info.port}/ws`,
      token: info.token,
      clientName: 'test',
      reconnect: false,
    });
    await client.ready();
    const restoreGit = isolateGitConfig();
    const repo = await createTempRepo().finally(restoreGit);
    try {
      // A Claude Code run fails with the locator's reason (not "SDK を読み込めませんでした").
      const project = await client.call('project.create', {
        name: 'bundle',
        repoPath: repo.path,
        defaultBranch: 'main',
      });
      const [main] = (await client.call('workspace.list', { projectId: project.id })).items;
      const session = await client.call('session.create', {
        projectId: project.id,
        kind: 'agent',
        runtime: 'claude-agent-sdk',
        workspaceId: main!.id,
      });
      const { runId } = await client.call('session.send', {
        sessionId: session.id,
        content: 'README を読んで',
      });
      let run = await client.call('run.get', { runId: runId! });
      for (let i = 0; i < 200 && !['failed', 'completed'].includes(run.status); i++) {
        await new Promise((r) => setTimeout(r, 50));
        run = await client.call('run.get', { runId: runId! });
      }
      expect(run.status).toBe('failed');
      expect(run.error?.message).toContain('ACC_CLAUDE_CODE_PATH');

      await expect(client.call('system.shutdown', {})).resolves.toMatchObject({
        pid: first.child.pid,
      });
    } finally {
      client.close();
    }
    expect(await first.exited).toBe(0);
    await repo.cleanup();
    expect(existsSync(join(home, 'daemon.json'))).toBe(false);
  }, 60_000);
});
