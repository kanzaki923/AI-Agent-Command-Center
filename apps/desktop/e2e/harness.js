/* global document -- used inside page.waitForFunction callbacks (browser context) */
// Shared harness for the real-daemon e2e scripts (slice.js, home.js, conflict.js, perf.js,
// reconnect.js, audit.js): a temporary ACC_HOME, the Core Daemon (via tsx, or the audit scene
// that starts one) and the Vite dev server on free ports, a tiny JSON-RPC client, a browser
// page with the UI store preset, and cleanup. No paid LLM endpoint, no real Claude and none
// of the user's ~/.acc is ever reachable from here: mock models and the mock runtime only.
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

/** The environment of a process this harness starts: never a real LLM endpoint or Claude. */
export function cleanEnv(env = {}) {
  const merged = { ...process.env, ...env };
  delete merged.ACC_LITELLM_BASE_URL;
  delete merged.ACC_LITELLM_API_KEY;
  for (const k of Object.keys(merged)) if (k.startsWith('ANTHROPIC_')) delete merged[k];
  return merged;
}

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
 * A child process of the harness. Its output tail is kept for the log when it dies on its
 * own; one the harness stops (`stopping`) exits quietly.
 */
function spawnChild(children, name, args, env, { stdin = 'ignore' } = {}) {
  const child = spawn(process.execPath, args, {
    cwd: desktopDir,
    env: cleanEnv(env),
    stdio: [stdin, 'pipe', 'pipe'],
  });
  const lines = [];
  const keep = (b) => {
    lines.push(...b.toString().split(/\r?\n/).filter(Boolean));
    lines.splice(0, Math.max(0, lines.length - 400));
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('exit', (code) => {
    if (code && !child.stopping) log(`${name} exited with ${code}\n  ${lines.slice(-40).join('\n  ')}`);
  });
  children.push(child);
  return { child, lines };
}

const exited = (child, ms) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve(true)
    : new Promise((r) => {
        const t = setTimeout(() => r(false), ms);
        child.once('exit', () => {
          clearTimeout(t);
          r(true);
        });
      });

/** Stop children: the daemon first through its API (a killed tsx may leave it running), then the rest. */
async function stopChildren(children, rpc) {
  for (const c of children) c.stopping = true;
  if (rpc) {
    await Promise.race([
      rpc.call('system.shutdown', { force: true }).catch(() => {}),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    rpc.close();
  }
  for (const c of children) {
    if (!(await exited(c, rpc ? 1500 : 0))) c.kill();
  }
  await Promise.all(children.map((c) => exited(c, 5000)));
}

function removeDirs(dirs) {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      log(`could not remove ${dir} (a process may still hold it)`);
    }
  }
}

/** Vite (dev server, or a production build with `vite preview`) pointed at `home`. */
async function startVite(children, home, { prod = false } = {}) {
  const uiPort = await freePort();
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
      env: cleanEnv({ ACC_HOME: home }),
    });
    if (b.status !== 0) throw new Error(`vite build failed:\n${b.stdout}\n${b.stderr}`);
    spawnChild(children, 'vite', [viteBin, 'preview', '--outDir', outDir, ...serve], { ACC_HOME: home });
  } else {
    spawnChild(children, 'vite', [viteBin, ...serve], { ACC_HOME: home });
  }
  const url = `http://127.0.0.1:${uiPort}/`;
  await waitFor(async () => (await fetch(url)).ok, 'Vite dev server', 60_000);
  await waitFor(async () => (await fetch(`${url}__acc/connection`)).ok, 'connection endpoint');
  log(`ui ${url}`);
  return url;
}

/**
 * Start daemon + Vite on free ports with a fresh ACC_HOME.
 * `daemonRoot`: checkout whose packages/daemon to run (default: this repository).
 * `prod`: serve a production build (vite build + preview) instead of the dev server.
 * `stopDaemon()` / `startDaemon()` take the daemon down and up again on the same port and
 * ACC_HOME while the UI stays (reconnect.js).
 */
export async function startStack({ daemonRoot = repoRoot, prod = false } = {}) {
  const children = [];
  const home = mkdtempSync(join(tmpdir(), 'acc-e2e-home-'));
  const daemonPort = await freePort();
  const daemonFile = join(home, 'daemon.json');
  log(`ACC_HOME ${home}`);

  let daemon = null;
  let rpc = null;
  const bootDaemon = async () => {
    // daemon.json is (re)written once the new daemon listens.
    rmSync(daemonFile, { force: true });
    const { child } = spawnChild(
      children,
      'daemon',
      [require.resolve('tsx/cli'), join(daemonRoot, 'packages/daemon/src/main.ts')],
      { ACC_HOME: home, ACC_PORT: String(daemonPort), ACC_LOG_LEVEL: 'warn' },
    );
    const info = await waitFor(
      () => existsSync(daemonFile) && JSON.parse(readFileSync(daemonFile, 'utf8')),
      'daemon.json',
      60_000,
    );
    daemon = { child, info };
    rpc = await connect(info.port, info.token);
    log(`daemon pid ${info.pid} on :${info.port}`);
    return info;
  };
  const info = await bootDaemon();
  const url = await startVite(children, home, { prod });

  return {
    home,
    url,
    info,
    get rpc() {
      return rpc;
    },
    /** Stop the daemon process (the UI stays); resolves once it has exited. */
    async stopDaemon() {
      const { child } = daemon;
      await stopChildren([child], rpc);
      children.splice(children.indexOf(child), 1);
      rpc = null;
    },
    /** Start the daemon again on the same port and ACC_HOME. */
    startDaemon: bootDaemon,
    async stop({ keep = false, extraDirs = [] } = {}) {
      await stopChildren(children, rpc);
      if (keep) {
        log(`kept ${[home, ...extraDirs].join(', ')}`);
        return;
      }
      removeDirs([home, ...extraDirs]);
    },
  };
}

/**
 * The audit scene (scripts/audit-scene.ts: three delegated trees, a schedule, plain chats;
 * more than ten agents at once, mock models and the mock runtime only) in a fresh ACC_HOME,
 * with Vite pointed at it. `build()` builds the scene (the daemon is up and empty before)
 * and returns the ids of the sessions it made (the scene's `scene {...}` line).
 */
export async function startScene() {
  const children = [];
  const home = mkdtempSync(join(tmpdir(), 'acc-audit-home-'));
  const daemonPort = await freePort();
  log(`ACC_HOME ${home}`);
  const scene = spawnChild(
    children,
    'scene',
    [require.resolve('tsx/cli'), 'scripts/audit-scene.ts', '--hold'],
    { ACC_HOME: home, ACC_PORT: String(daemonPort), ACC_LOG_LEVEL: 'warn' },
    { stdin: 'pipe' },
  );
  await waitFor(() => scene.lines.includes('daemon ready'), 'daemon', 60_000);
  const daemonFile = join(home, 'daemon.json');
  const info = await waitFor(
    () => existsSync(daemonFile) && JSON.parse(readFileSync(daemonFile, 'utf8')),
    'daemon.json',
  );
  const rpc = await connect(info.port, info.token);
  const url = await startVite(children, home);
  let ids = null;
  return {
    home,
    url,
    info,
    rpc,
    async build() {
      if (ids) return ids;
      scene.child.stdin.write('build\n');
      await waitFor(() => scene.lines.includes('scene ready'), 'scene', 240_000, 300);
      const line = await waitFor(() => scene.lines.find((l) => l.startsWith('scene {')), 'scene ids');
      ids = JSON.parse(line.slice('scene '.length));
      log('scene ready');
      return ids;
    },
    async stop({ keep = false } = {}) {
      // The scene process runs the daemon in-process: stopping it through the API ends both.
      await stopChildren(children, rpc);
      if (keep) {
        log(`kept ${home}`);
        return;
      }
      // The scene's folder project lives beside ACC_HOME (scripts/audit-scene.ts).
      removeDirs([home, `${home}-market`]);
    },
  };
}

/**
 * Wait until no finite animation runs (enter / exit / layout moves; spinners loop forever and
 * do not count), so a screenshot shows where things land, not a frame of the way there.
 */
export async function settled(page, ms = 3000) {
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
      undefined,
      { timeout: ms, polling: 50 },
    )
    .catch(() => {});
}

/** localStorage of the UI store (zustand persist, version 2). */
export const uiState = (state) => JSON.stringify({ state, version: 2 });

/**
 * A browser page on the UI with the store preset (past the first-run screen unless
 * `onboarding`), collecting page errors. `shot(name)` saves a numbered screenshot in `out`.
 */
export async function openPage(
  browser,
  { url, out, theme = 'dark', onboarding = false, width = 1440, height = 900 },
) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await context.addInitScript(
    (preset) => {
      try {
        // Once per tab: a reload keeps what the app stored since.
        if (sessionStorage.getItem('acc.e2e.preset')) return;
        sessionStorage.setItem('acc.e2e.preset', '1');
        localStorage.setItem('acc.ui', preset);
      } catch {
        /* storage blocked: the onboarding check also yields to existing sessions */
      }
    },
    uiState({ theme, ...(onboarding ? {} : { onboardingDone: true }) }),
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  let n = 0;
  const shot = async (name) => {
    n++;
    const path = join(out, `${String(n).padStart(2, '0')}-${name}.png`);
    await settled(page);
    await page.screenshot({ path });
    log(`screenshot ${path}`);
    return path;
  };
  await page.goto(url);
  return { context, page, errors, shot };
}
