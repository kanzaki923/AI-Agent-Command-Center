// UI audit (ui-redesign spec §10): builds the scene of scripts/audit-scene.ts (real daemon,
// mock models and mock runtime only: three delegated trees, a schedule, plain chats; more
// than ten agents at once) in a fresh ACC_HOME on free ports, serves the UI with Vite, and
// screenshots every screen (e2e/audit-shots.js lists them) — first the empty app, then the
// scene.
//
//   node e2e/audit.js [--out <dir>] [--theme dark|light] [--serve] [--keep]
//
// --serve  build the scene and keep the stack running (no screenshots) for manual review
// --keep   keep ACC_HOME after the run
// Screenshots go to the OS temp dir by default (never into the repo).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { desktopDir, flag, freePort, log, opt, waitFor } from './harness.js';

const require = createRequire(import.meta.url);
const out = opt('out', join(tmpdir(), 'acc-audit-shots'));
const theme = opt('theme', 'dark');
const serve = flag('serve');

const home = mkdtempSync(join(tmpdir(), 'acc-audit-home-'));
const daemonPort = await freePort();
const uiPort = await freePort();
const children = [];

function start(name, args, env, { stdin = 'ignore' } = {}) {
  const merged = { ...process.env, ...env, ACC_HOME: home };
  // Never reach a real LLM endpoint or a real Claude (mock models and runtime only).
  delete merged.ACC_LITELLM_BASE_URL;
  delete merged.ACC_LITELLM_API_KEY;
  for (const k of Object.keys(merged)) if (k.startsWith('ANTHROPIC_')) delete merged[k];
  const child = spawn(process.execPath, args, {
    cwd: desktopDir,
    env: merged,
    stdio: [stdin, 'pipe', 'pipe'],
  });
  const lines = [];
  const keep = (b) => lines.push(...b.toString().split(/\r?\n/).filter(Boolean));
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('exit', (code) => {
    if (code) log(`${name} exited with ${code}\n  ${lines.slice(-40).join('\n  ')}`);
  });
  children.push(child);
  return { child, lines };
}

async function cleanup() {
  for (const c of children) c.kill();
  await new Promise((r) => setTimeout(r, 800));
  if (flag('keep')) {
    log(`kept ${home}`);
    return;
  }
  const { rmSync } = await import('node:fs');
  // The scene's folder project lives beside ACC_HOME (scripts/audit-scene.ts).
  for (const dir of [home, `${home}-market`]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      log(`could not remove ${dir}`);
    }
  }
}

process.on('SIGINT', () => void cleanup().finally(() => process.exit(130)));

try {
  log(`ACC_HOME ${home}`);
  const scene = start(
    'scene',
    [require.resolve('tsx/cli'), 'scripts/audit-scene.ts', '--hold'],
    { ACC_PORT: String(daemonPort), ACC_LOG_LEVEL: 'warn' },
    { stdin: 'pipe' },
  );
  await waitFor(() => scene.lines.includes('daemon ready'), 'daemon', 60_000);

  const viteBin = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
  start('vite', [viteBin, '--port', String(uiPort), '--strictPort', '--host', '127.0.0.1'], {});
  const url = `http://127.0.0.1:${uiPort}/`;
  await waitFor(async () => (await fetch(url)).ok, 'Vite dev server', 60_000);
  await waitFor(async () => (await fetch(`${url}__acc/connection`)).ok, 'connection endpoint');
  log(`ui ${url}`);

  const build = async () => {
    scene.child.stdin.write('build\n');
    await waitFor(() => scene.lines.includes('scene ready'), 'scene', 240_000, 300);
    log('scene ready');
  };

  if (serve) {
    await build();
    log(`serving ${url} (Ctrl+C to stop)`);
    await new Promise(() => {});
  }

  mkdirSync(out, { recursive: true });
  const { shoot } = await import('./audit-shots.js');
  const result = await shoot({ url, out, theme, build, home, daemonPort });
  if (result.errors.length) process.exitCode = 1;
} finally {
  await cleanup();
}
