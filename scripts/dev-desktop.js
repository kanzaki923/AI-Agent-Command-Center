// `pnpm dev:desktop`: the desktop app in development, in one terminal.
//
// 1. Core Daemon with `tsx watch` (restarts on source changes), unless a daemon is already
//    serving this ACC_HOME (then the app just connects to it, and it is left running).
// 2. `tauri dev` (Vite + the Rust shell). The shell's get_connection finds the daemon from
//    step 1 through daemon.json, so it never spawns its own detached one.
// Closing the window or Ctrl+C stops everything this script started (`acc daemon stop`).
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.ACC_HOME || join(homedir(), '.acc');
const isWin = process.platform === 'win32';

function readInfo() {
  try {
    return JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function healthy() {
  const info = readInfo();
  if (!info) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
      signal: AbortSignal.timeout(800),
    });
    const body = await res.json();
    return body.service === 'acc-daemon' && body.pid === info.pid ? info : null;
  } catch {
    return null;
  }
}

/** Run a pnpm script with each output line prefixed, in its own process group. */
function start(label, args) {
  const child = spawn('pnpm', args, {
    cwd: root,
    // pnpm is pnpm.cmd on Windows
    shell: isWin,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWin,
    env: process.env,
  });
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(`[${label}] ${line}\n`);
    });
  }
  child.exited = new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 1)));
  return child;
}

function killTree(child) {
  if (child.exitCode !== null || !child.pid) return;
  if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

let daemon = null;
const existing = await healthy();
if (existing) {
  console.log(
    `[dev] 既存の Core Daemon（pid ${existing.pid}、ポート ${existing.port}）に接続します。` +
      'ソースの変更を反映するには `pnpm acc daemon stop` で止めてから実行し直してください。',
  );
} else {
  daemon = start('daemon', ['--filter', '@acc/daemon', 'dev']);
  const deadline = Date.now() + 60_000;
  while (!(await healthy())) {
    if (daemon.exitCode !== null || Date.now() > deadline) {
      console.error('[dev] Core Daemon を起動できませんでした（上のログを確認してください）');
      killTree(daemon);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

const desktop = start('desktop', ['--filter', '@acc/desktop', 'tauri:dev']);

let stopping = false;
async function stopAll(code) {
  if (stopping) return;
  stopping = true;
  killTree(desktop);
  if (daemon) {
    // Graceful first (closes the DB, removes daemon.json), then the watcher itself.
    spawnSync(
      process.execPath,
      [join(root, 'packages', 'cli', 'bin', 'acc.js'), 'daemon', 'stop', '--force'],
      {
        cwd: root,
        stdio: 'inherit',
        env: process.env,
      },
    );
    killTree(daemon);
  }
  process.exit(code);
}

process.on('SIGINT', () => void stopAll(130));
process.on('SIGTERM', () => void stopAll(143));
void desktop.exited.then((code) => stopAll(code));
if (daemon) {
  void daemon.exited.then((code) => {
    if (stopping) return;
    console.error(`[dev] Core Daemon の watch が終了しました（${code}）`);
    void stopAll(code || 1);
  });
}
