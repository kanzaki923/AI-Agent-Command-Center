// End-to-end check of the human side of the Vertical Slice against a REAL Core Daemon.
//
//   pnpm --filter @acc/desktop e2e:slice [-- --headed] [--keep] [--out <dir>] [--timeout-ms 240000]
//                                        [--daemon-root <checkout with the daemon to run>]
//
// What it does (no paid LLM calls: mock models and the mock agent runtime only):
//   1. Creates a temporary ACC_HOME and a temporary git repository.
//   2. Starts the daemon (`packages/daemon/src/main.ts` via tsx) and the Vite dev server on
//      free ports, both pointed at that ACC_HOME.
//   3. In Chromium (Playwright, 1440x900): onboarding → 「デモモードで試す」 → lands in the
//      demo design chat holding the orchestrator grant (chip + chat line) with the suggested
//      first message → sends it with one click → the reply streams in.
//   4. Approvals: a mock worker asks for approval; Ctrl+J lands on it, Y approves, the run
//      finishes.
//   5. Integration: if the daemon can spawn workers (task.spawnWorker — the orchestrator
//      track), it waits for the orchestrator's task tree and its integration candidate,
//      approving tool requests on the way; otherwise it builds a candidate from the worker's
//      task itself. Either way it opens the review, checks the confirmation wording, applies
//      it and verifies the target branch moved (git, not just the UI).
//
// Screenshots of every step go to the OS temp dir (never the repo). Exit code 0 = pass.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, '..');
const repoRoot = resolve(desktopDir, '../..');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};
const headed = flag('headed');
const keep = flag('keep');
const out = opt('out', join(tmpdir(), 'acc-e2e-slice'));
const sliceTimeout = Number(opt('timeout-ms', '240000'));
// Run the daemon from another checkout (e.g. a branch with newer daemon modules) against
// this UI. Default: this repository.
const daemonRoot = resolve(opt('daemon-root', repoRoot));
mkdirSync(out, { recursive: true });

const children = [];
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

async function waitFor(fn, what, ms = 30_000, every = 200) {
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

function start(name, args, env, cwd = desktopDir) {
  const merged = { ...process.env, ...env };
  // Never reach a real LLM endpoint from the e2e run (mock models only).
  delete merged.ACC_LITELLM_BASE_URL;
  delete merged.ACC_LITELLM_API_KEY;
  const child = spawn(process.execPath, args, {
    cwd,
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
  child.on(
    'exit',
    (code) => code && code !== 0 && log(`${name} exited with ${code}\n  ${tail.join('\n  ')}`),
  );
  children.push(child);
  return { child, tail };
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo() {
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
async function connect(port, token) {
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

const MOCK_ASK = [
  '本番の設定ファイルを確認します。',
  '',
  '```acc-mock',
  JSON.stringify({
    steps: [
      { type: 'write', path: 'docs/e2e.md', content: '# E2E\n\nWorker が書きました。\n' },
      {
        type: 'ask',
        title: '本番設定に触れてよいですか',
        detail: 'config/production.json を読みます',
      },
      { type: 'say', text: '確認できました。' },
    ],
    summary: 'docs/e2e.md を追加しました',
    delayScale: 0.2,
  }),
  '```',
].join('\n');

let browser;
let rpc;
let home;
let repo;
let failed = false;

try {
  home = mkdtempSync(join(tmpdir(), 'acc-e2e-home-'));
  repo = makeRepo();
  const daemonPort = await freePort();
  const uiPort = await freePort();
  log(`ACC_HOME ${home}`);

  // ------------------------------------------------------------------ daemon + Vite
  const tsxCli = require.resolve('tsx/cli');
  const daemon = start('daemon', [tsxCli, join(daemonRoot, 'packages/daemon/src/main.ts')], {
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
  void daemon;

  const viteBin = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
  start('vite', [viteBin, '--port', String(uiPort), '--strictPort', '--host', '127.0.0.1'], {
    ACC_HOME: home,
  });
  const url = `http://127.0.0.1:${uiPort}/`;
  await waitFor(async () => (await fetch(url)).ok, 'Vite dev server', 60_000);
  await waitFor(async () => (await fetch(`${url}__acc/connection`)).ok, 'connection endpoint');
  log(`ui ${url}`);

  rpc = await connect(info.port, info.token);
  const sysInfo = await rpc.call('system.info');
  const methods = new Set(sysInfo.methods);
  const orchestratorAvailable = methods.has('task.spawnWorker');
  log(
    `daemon ${sysInfo.version}: ${sysInfo.methods.length} methods; task.spawnWorker ${orchestratorAvailable ? 'available' : 'not available'}`,
  );

  // ------------------------------------------------------------------ browser
  browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  let n = 0;
  const shot = async (name) => {
    n++;
    const path = join(out, `${String(n).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path });
    log(`screenshot ${path}`);
  };

  // 1. onboarding → demo
  await page.goto(url);
  await page.getByText('AI エージェントのチームを始めましょう').waitFor({ timeout: 30_000 });
  await shot('onboarding');
  await page.getByRole('button', { name: /デモモードで試す/ }).click();
  log('demo chosen');

  // 2. landed in the design chat as an orchestrator
  const chip = page.getByTestId('grant-chip');
  await chip.waitFor({ timeout: 20_000 });
  await page.getByTestId('grant-line-given').waitFor();
  const chipText = await chip.innerText();
  if (!/Orchestrator/.test(chipText)) throw new Error(`grant chip says "${chipText}"`);
  const suggestion = page.getByTestId('suggestion-chip');
  await suggestion.waitFor();
  const suggested = (await suggestion.innerText()).split('\n')[0].trim();
  log(`grant chip "${chipText.replace(/\s+/g, ' ')}"; suggestion "${suggested}"`);
  await shot('demo-chat-granted');

  // The grant really exists in the daemon (not just in the UI).
  const sessions = (await rpc.call('session.list', {})).items;
  const design = sessions.find((s) => s.kind === 'chat');
  const grants = (await rpc.call('grant.list', { sessionId: design.id })).items;
  if (grants.length === 0) throw new Error('no grant on the demo chat in the daemon');
  log(
    `daemon grant ${grants[0].id}: ${grants[0].permissions.length} permissions, maxWorkers ${grants[0].limits.maxWorkers}`,
  );

  // 3. send the suggested message with one click → streaming reply
  await suggestion.click();
  await page.locator('.md').first().waitFor({ timeout: 60_000 });
  await shot('demo-message-streaming');
  if (orchestratorAvailable) {
    // The orchestrator run supervises its workers for a while; it only has to be underway.
    await waitFor(
      async () => {
        const runs = (await rpc.call('run.list', { sessionId: design.id })).items;
        return runs.some((r) => r.status !== 'created' && r.status !== 'queued') ? runs : null;
      },
      'the orchestrator run to start',
      60_000,
    );
    log('orchestrator run started');
  } else {
    await waitFor(
      async () => {
        const runs = (await rpc.call('run.list', { sessionId: design.id })).items;
        return runs.length > 0 &&
          runs.every((r) => !['created', 'queued', 'running'].includes(r.status))
          ? runs
          : null;
      },
      'the demo chat run to finish',
      90_000,
    );
    log('demo message answered');
  }
  await shot('demo-message-done');

  // 4. approvals: a mock worker asks; Ctrl+J lands on it and Y approves
  // Work in the demo's project when it has one (the board is filtered to it), else our repo.
  const project = design.projectId
    ? await rpc.call('project.get', { projectId: design.projectId })
    : await rpc.call('project.create', {
        name: 'e2e-repo',
        repoPath: repo,
        defaultBranch: 'main',
        testCommand: 'node scripts/test.js',
      });
  log(`project ${project.name} (${project.repoPath ? 'git' : 'no repo'})`);
  const task = await rpc.call('task.create', {
    projectId: project.id,
    title: 'E2E のドキュメントを書く',
  });
  const ws = await rpc.call('workspace.create', {
    projectId: project.id,
    taskId: task.id,
    label: 'e2e-worker',
  });
  await rpc.call('workspace.list', { projectId: project.id });
  const worker = await rpc.call('session.create', {
    kind: 'agent',
    projectId: project.id,
    workspaceId: ws.id,
    taskId: task.id,
    title: 'E2E Worker',
    runtime: 'mock',
  });
  await rpc.call('session.send', { sessionId: worker.id, content: MOCK_ASK });
  await waitFor(
    async () =>
      (await rpc.call('approval.list', { status: ['pending'], sessionId: worker.id })).items[0],
    'the worker approval',
    30_000,
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+1');
  await page.getByRole('heading', { name: '司令室' }).waitFor();
  await page.keyboard.press('Control+j');
  const card = page.getByRole('option', { name: /E2E Worker · 承認待ち/ });
  await card.waitFor();
  await shot('approval-ctrl-j');
  await card.focus();
  await page.keyboard.press('y');
  await waitFor(
    async () =>
      (await rpc.call('approval.list', { status: ['approved'], sessionId: worker.id })).items[0],
    'approval to be recorded',
  );
  await waitFor(
    async () => {
      const r = (await rpc.call('run.list', { sessionId: worker.id })).items[0];
      return r && r.status === 'completed';
    },
    'the worker run to complete',
    60_000,
  );
  log('approval approved from the keyboard; worker completed');
  await shot('approval-done');

  // 5. integration: orchestrator-driven when available, else from the worker's task
  let integrationId;
  if (orchestratorAvailable) {
    log('driving the orchestrator slice (task tree → workers → integration)');
    const end = Date.now() + sliceTimeout;
    while (Date.now() < end && !integrationId) {
      const pending = (await rpc.call('approval.list', { status: ['pending'] })).items;
      if (pending.length > 0) {
        await page.keyboard.press('Control+1');
        await page.keyboard.press('Control+j');
        await page.waitForTimeout(250);
        const danger = page.getByRole('button', { name: /承認（要注意）/ }).first();
        await page.keyboard.press(
          (await danger.isVisible().catch(() => false)) ? 'Control+y' : 'y',
        );
        log(`approved: ${pending[0].title}`);
      }
      const integ = (await rpc.call('integration.list', {})).items.find(
        (i) => i.status === 'awaiting_approval',
      );
      if (integ) integrationId = integ.id;
      else await page.waitForTimeout(1000);
    }
    if (!integrationId)
      throw new Error('the orchestrator did not produce an integration candidate in time');
    await page.getByTestId('task-tree').waitFor();
    await shot('orchestrator-task-tree');
  } else {
    log('task.spawnWorker not available: integrating the worker task directly');
    await rpc.call('task.update', { taskId: task.id, status: 'review' });
    await page.getByTestId('task-tree').waitFor();
    await shot('task-tree');
    await page
      .getByRole('button', { name: /統合する/ })
      .first()
      .click();
    await page.getByTestId('integration-view').waitFor();
    integrationId = await waitFor(
      async () => {
        const i = (await rpc.call('integration.list', {})).items[0];
        return i && i.status === 'awaiting_approval' ? i.id : null;
      },
      'integration to be ready',
      60_000,
    );
  }

  // Review: steps, tests, diff; approve with the exact confirmation; branch really moves.
  if (
    !(await page
      .getByTestId('integration-view')
      .isVisible()
      .catch(() => false))
  ) {
    await page.keyboard.press('Control+1');
    await page
      .getByRole('button', { name: /統合: 反映待ち|レビューを開始/ })
      .first()
      .click();
  }
  await page.getByTestId('integration-view').waitFor();
  await page.getByTestId('approve-integration').waitFor({ timeout: 30_000 });
  await page.getByTestId('integration-tests').waitFor({ timeout: 30_000 });
  await shot('integration-review');
  const pendingInteg = await rpc.call('integration.get', { integrationId });
  const targetRepo = (await rpc.call('project.get', { projectId: pendingInteg.projectId }))
    .repoPath;
  const targetRef = pendingInteg.targetRef ?? 'main';
  const before = git(targetRepo, 'rev-parse', targetRef);
  await page.getByTestId('approve-integration').click();
  const dialog = page.getByTestId('apply-dialog');
  await dialog.waitFor();
  const wording = await dialog.innerText();
  if (!/早送り（fast-forward）/.test(wording) || !wording.includes(targetRef))
    throw new Error(`confirmation does not say what happens: ${wording}`);
  await shot('integration-confirm');
  await page.getByRole('button', { name: '反映する' }).click();
  await page
    .getByText(/に反映しました/)
    .first()
    .waitFor({ timeout: 30_000 });
  const integ = await rpc.call('integration.get', { integrationId });
  const after = git(targetRepo, 'rev-parse', targetRef);
  if (integ.status !== 'applied' || before === after || after !== integ.headSha) {
    throw new Error(
      `integration not applied (status ${integ.status}, ${targetRef} ${before} → ${after}, head ${integ.headSha})`,
    );
  }
  log(`applied: ${targetRef} ${before.slice(0, 7)} → ${after.slice(0, 7)}`);
  await shot('integration-applied');

  if (pageErrors.length) {
    log(`page errors:\n  ${pageErrors.join('\n  ')}`);
    throw new Error('the page reported errors');
  }
  log(
    orchestratorAvailable
      ? 'PASS (full vertical slice)'
      : 'PASS (human side; orchestrator steps skipped: task.spawnWorker not implemented)',
  );
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  rpc?.close();
  await browser?.close().catch(() => {});
  for (const c of children) c.kill();
  await new Promise((r) => setTimeout(r, 500));
  if (!keep) {
    for (const dir of [home, repo]) {
      if (!dir) continue;
      try {
        spawnSync('git', ['worktree', 'prune'], { cwd: repo });
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        log(`could not remove ${dir} (a process may still hold it)`);
      }
    }
  } else {
    log(`kept ACC_HOME ${home} and repo ${repo}`);
  }
  process.exit(failed ? 1 : 0);
}
