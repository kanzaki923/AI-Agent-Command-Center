// Shared harness for the real-daemon e2e scripts (slice.js, perf.js): a temporary
// ACC_HOME, the Core Daemon (via tsx) and the Vite dev server on free ports, a tiny
// JSON-RPC client, and cleanup. No paid LLM endpoint is ever reachable from here.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
export const desktopDir = resolve(here, '..');
export const repoRoot = resolve(desktopDir, '../..');

const argv = process.argv.slice(2);
export const flag = (name) => argv.includes(`--${name}`);
export const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};

const t0 = Date.now();
export const log = (...a) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);

export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

export async function waitFor(fn, what, ms = 30_000, every = 200) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end)
      throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A temporary git repository with a README and a passing `node scripts/test.js`. */
export function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'acc-e2e-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of Object.entries({
    'core.autocrlf': 'false',
    'commit.gpgsign': 'false',
    'user.name': 'E2E',
    'user.email': 'e2e@example.com',
  })) {
    git(dir, 'config', k, v);
  }
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# demo repo\n');
  writeFileSync(join(dir, 'scripts', 'test.js'), "console.log('Tests  3 passed (3)');\n");
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

/** Minimal JSON-RPC over the daemon's WebSocket (Node 22 has a global WebSocket). */
export async function connect(port, token) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}&client=e2e`,
  );
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(String(m.data));
    const p = msg.id != null ? pending.get(msg.id) : null;
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.rej(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
    else p.res(msg.result);
  });
  return {
    call: (method, params = {}) =>
      new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method, params }));
      }),
    close: () => ws.close(),
  };
}

/**
 * Start daemon + Vite on free ports with a fresh ACC_HOME.
 * `daemonRoot`: checkout whose packages/daemon to run (default: this repository).
 * `prod`: serve a production build (vite build + preview) instead of the dev server.
 */
export async function startStack({ daemonRoot = repoRoot, prod = false } = {}) {
  const children = [];
  const home = mkdtempSync(join(tmpdir(), 'acc-e2e-home-'));
  const start = (name, args, env) => {
    const merged = { ...process.env, ...env };
    // Never reach a real LLM endpoint from an e2e run (mock models only).
    delete merged.ACC_LITELLM_BASE_URL;
    delete merged.ACC_LITELLM_API_KEY;
    const child = spawn(process.execPath, args, {
      cwd: desktopDir,
      env: merged,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tail = [];
    const keepTail = (b) => {
      tail.push(...b.toString().split(/\r?\n/).filter(Boolean));
      tail.splice(0, Math.max(0, tail.length - 40));
    };
    child.stdout.on('data', keepTail);
    child.stderr.on('data', keepTail);
    child.on('exit', (code) => {
      if (code && code !== 0) log(`${name} exited with ${code}\n  ${tail.join('\n  ')}`);
    });
    children.push(child);
  };

  const daemonPort = await freePort();
  const uiPort = await freePort();
  log(`ACC_HOME ${home}`);
  start('daemon', [require.resolve('tsx/cli'), join(daemonRoot, 'packages/daemon/src/main.ts')], {
    ACC_HOME: home,
    ACC_PORT: String(daemonPort),
    ACC_LOG_LEVEL: 'warn',
  });
  const info = await waitFor(
    () => {
      const f = join(home, 'daemon.json');
      return existsSync(f) && JSON.parse(readFileSync(f, 'utf8'));
    },
    'daemon.json',
    60_000,
  );
  log(`daemon pid ${info.pid} on :${info.port}`);

  const viteBin = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
  const serve = ['--port', String(uiPort), '--strictPort', '--host', '127.0.0.1'];
  if (prod) {
    // A production build served by `vite preview` (same connection endpoint): what the
    // Tauri window runs, without React's development overhead.
    const outDir = join(home, 'ui-dist');
    log('building the UI (production)…');
    const b = spawnSync(process.execPath, [viteBin, 'build', '--outDir', outDir, '--emptyOutDir'], {
      cwd: desktopDir,
      encoding: 'utf8',
    });
    if (b.status !== 0) throw new Error(`vite build failed:\n${b.stdout}\n${b.stderr}`);
    start('vite', [viteBin, 'preview', '--outDir', outDir, ...serve], { ACC_HOME: home });
  } else {
    start('vite', [viteBin, ...serve], { ACC_HOME: home });
  }
  const url = `http://127.0.0.1:${uiPort}/`;
  await waitFor(async () => (await fetch(url)).ok, 'Vite dev server', 60_000);
  await waitFor(async () => (await fetch(`${url}__acc/connection`)).ok, 'connection endpoint');
  log(`ui ${url}`);
  const rpc = await connect(info.port, info.token);

  return {
    home,
    url,
    info,
    rpc,
    async stop({ keep = false, extraDirs = [] } = {}) {
      rpc.close();
      for (const c of children) c.kill();
      await new Promise((r) => setTimeout(r, 500));
      if (keep) {
        log(`kept ${[home, ...extraDirs].join(', ')}`);
        return;
      }
      for (const dir of [home, ...extraDirs]) {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        } catch {
          log(`could not remove ${dir} (a process may still hold it)`);
        }
      }
    },
  };
}
