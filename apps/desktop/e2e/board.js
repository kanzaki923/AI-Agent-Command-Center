// End-to-end check of the task board and the palette's message search against a REAL
// Core Daemon (no paid LLM calls: mock models and the mock agent runtime only).
//
//   pnpm --filter @acc/desktop e2e:board [-- --headed] [--keep] [--out <dir>] [--daemon-root <checkout>]
//
//   1. A temporary git repository becomes a project; two tasks are created by "a human"
//      (one ready, one waiting for it) — tasks no worker has picked up yet.
//   2. Command Mode → T opens the task board: the ready task is under 着手可能 and the
//      waiting one under 未着手（依存待ち）.
//   3. j selects the ready task, R starts its worker (task.spawnWorker): the UI moves to the
//      worker's conversation and the daemon reports the task as no longer ready.
//   4. Ctrl+K, typing a word from an earlier chat message: the palette lists the message
//      (session.search) with the word marked; Enter opens that conversation.
//
// Screenshots go to the OS temp dir (never the repo). Exit code 0 = pass.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { flag, log, makeRepo, opt, repoRoot, startStack, waitFor } from './harness.js';

const headed = flag('headed');
const keep = flag('keep');
const out = opt('out', join(tmpdir(), 'acc-e2e-board'));
const daemonRoot = resolve(opt('daemon-root', repoRoot));
mkdirSync(out, { recursive: true });

let browser;
let stack;
let repo;
let failed = false;

try {
  repo = makeRepo();
  stack = await startStack({ daemonRoot });
  const { rpc, url } = stack;
  const methods = new Set((await rpc.call('system.info')).methods);
  if (!methods.has('task.spawnWorker')) throw new Error('this daemon cannot start workers (task.spawnWorker)');

  // ------------------------------------------------------------------ data (real API)
  const project = await rpc.call('project.create', {
    name: 'board-e2e',
    repoPath: repo,
    defaultBranch: 'main',
    testCommand: 'node scripts/test.js',
  });
  await rpc.call('workspace.create', { projectId: project.id, kind: 'main' });
  const ready = await rpc.call('task.create', {
    projectId: project.id,
    title: 'README に使い方を書く',
    description: 'README.md に起動方法を 3 行で書く。',
    acceptanceCriteria: ['起動方法が書かれている'],
  });
  const waiting = await rpc.call('task.create', {
    projectId: project.id,
    title: '使い方の節に図を足す',
    dependsOn: [ready.id],
  });
  log(`tasks: ${ready.title} (${ready.status}), ${waiting.title} (${waiting.status})`);
  const chat = await rpc.call('session.create', {
    kind: 'chat',
    projectId: project.id,
    title: '週次の相談',
    model: 'mock/fast',
  });
  const sent = await rpc.call('session.send', { sessionId: chat.id, content: '今週の進捗を整理したい' });
  await waitFor(
    async () => {
      const r = await rpc.call('run.get', { runId: sent.runId });
      return ['completed', 'failed', 'cancelled'].includes(r.status) ? r : null;
    },
    'the chat run to end',
  );

  // ------------------------------------------------------------------ browser
  browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    localStorage.setItem('acc.ui', JSON.stringify({ state: { onboardingDone: true }, version: 1 }));
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

  await page.goto(url);
  await page.getByRole('heading', { name: '司令室' }).waitFor({ timeout: 30_000 });

  // 2. the task board (keyboard: T)
  await page.keyboard.press('t');
  const board = page.getByTestId('task-board');
  await board.waitFor();
  const readySection = board.getByRole('region', { name: '着手可能' });
  await readySection.getByText(ready.title).waitFor({ timeout: 15_000 });
  await board.getByRole('region', { name: '未着手（依存待ち）' }).getByText(waiting.title).waitFor();
  await shot('task-board');
  log('task board lists both tasks by status');

  // 3. j selects the ready task, R starts its worker
  await page.keyboard.press('j');
  const row = page.getByRole('option', { name: new RegExp(ready.title) });
  if ((await row.getAttribute('aria-selected')) !== 'true') throw new Error('j did not select the ready task');
  await row.getByRole('button', { name: /このTaskを実行/ }).waitFor();
  await page.keyboard.press('r');
  const started = await waitFor(
    async () => {
      const t = await rpc.call('task.get', { taskId: ready.id });
      return t.status !== 'ready' && t.assigneeSessionId ? t : null;
    },
    'the task to get a worker',
    30_000,
  );
  log(`task ${started.status}, worker ${started.assigneeSessionId}`);
  // The UI follows into the worker's conversation (Focus).
  await page.getByRole('button', { name: /停止|再試行/ }).or(page.getByLabel('メッセージ')).first().waitFor({ timeout: 15_000 });
  await shot('worker-opened');

  // 4. message search in the palette
  await page.keyboard.press('Control+1');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('進捗');
  const hit = page.getByTestId('message-hit').first();
  await hit.waitFor({ timeout: 10_000 });
  const marked = await hit.locator('mark').first().innerText();
  if (marked !== '進捗') throw new Error(`expected the hit to mark 進捗, got "${marked}"`);
  await shot('palette-message-search');
  await hit.click();
  await page.getByText('今週の進捗を整理したい').first().waitFor({ timeout: 10_000 });
  await shot('jumped-to-message');
  log('palette search found the message and opened its conversation');

  if (pageErrors.length) throw new Error(`page errors:\n${pageErrors.join('\n')}`);
  log('PASS');
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await browser?.close().catch(() => {});
  await stack?.stop({ keep, extraDirs: repo ? [repo] : [] });
  process.exitCode = failed ? 1 : 0;
}
