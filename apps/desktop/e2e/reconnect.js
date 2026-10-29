// Reconnect check against a REAL Core Daemon (no LLM calls): the UI keeps its place while the
// daemon is down and catches up by itself once it is back.
//
//   pnpm --filter @acc/desktop e2e:reconnect [-- --headed] [--keep] [--out <dir>]
//
//   1. A conversation exists; the home shows its lane.
//   2. The daemon stops: the band 「Core Daemon に再接続しています…」 appears above the main
//      area, the connection dot says so, and the home stays as it was (no blank screen).
//   3. The daemon starts again on the same port and ACC_HOME, and a conversation is created
//      right away (while the UI may still be waiting to retry).
//   4. The band goes, the dot is green again, and the home shows the conversation that was
//      created while the UI was disconnected (it fetched again, without a reload).
//
// Screenshots go to the OS temp dir (never the repo). Exit code 0 = pass.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { flag, log, openPage, opt, startStack } from './harness.js';

const keep = flag('keep');
const out = opt('out', join(tmpdir(), 'acc-e2e-reconnect'));
mkdirSync(out, { recursive: true });
const BANNER = 'Core Daemon に再接続しています…';

let browser;
let stack;
let failed = false;

try {
  stack = await startStack();
  const before = await stack.rpc.call('session.create', { kind: 'chat', title: '切断の前の会話', model: 'mock/fast' });

  browser = await chromium.launch({ headless: !flag('headed') });
  const { page, errors, shot } = await openPage(browser, { url: stack.url, out });
  /** The connection dot of the title bar. */
  const dot = (opts) => page.getByRole('banner').getByRole('status', opts);
  await page.locator(`[data-lane="${before.id}"]`).waitFor({ timeout: 30_000 });
  await dot({ name: '接続中' }).waitFor();

  // 2. down: the band, the dot, and the home as it was
  await stack.stopDaemon();
  log('daemon stopped');
  await page.getByText(BANNER).waitFor({ timeout: 30_000 });
  await dot({ name: /再接続中|接続しています/ }).waitFor();
  if (!(await page.locator(`[data-lane="${before.id}"]`).isVisible()))
    throw new Error('the home lost its lanes while the daemon was down');
  await shot('reconnecting');

  // 3. back up (same port and ACC_HOME), with a conversation the UI has not seen
  await stack.startDaemon();
  const during = await stack.rpc.call('session.create', { kind: 'chat', title: '再接続のあとの会話', model: 'mock/fast' });
  log('daemon started again');

  // 4. caught up without a reload
  await page.getByText(BANNER).waitFor({ state: 'detached', timeout: 60_000 });
  await dot({ name: '接続中' }).waitFor({ timeout: 30_000 });
  await page.locator(`[data-lane="${during.id}"]`).waitFor({ timeout: 30_000 });
  await page.locator(`[data-lane="${before.id}"]`).waitFor();
  await shot('reconnected');
  log('reconnected: the band went and the home shows what changed meanwhile');

  if (errors.length) throw new Error(`page errors:\n  ${errors.join('\n  ')}`);
  log('PASS');
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await browser?.close().catch(() => {});
  await stack?.stop({ keep });
  process.exit(failed ? 1 : 0);
}
