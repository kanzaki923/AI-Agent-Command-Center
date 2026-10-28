// Reconnect check: open the UI, stop the daemon (via the caller), screenshot the banner,
// then wait for the caller to restart it and screenshot the recovered state.
//
//   node e2e/reconnect.js --url http://127.0.0.1:5173/ --signal <file>
// The script writes "<file>.down-ready" when it wants the daemon stopped and waits for
// "<file>.up" before taking the recovered screenshot.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : def;
};
const url = arg('url', 'http://127.0.0.1:5173/');
const signal = arg('signal', join(tmpdir(), 'acc-reconnect'));
const out = arg('out', join(tmpdir(), 'acc-desktop-screenshots'));
mkdirSync(out, { recursive: true });
const waitFor = async (file, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!existsSync(file)) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url);
await page.getByRole('heading', { name: '司令室' }).waitFor({ timeout: 20_000 });
writeFileSync(`${signal}.down-ready`, '1');
await page.getByText('Core Daemon に再接続しています…').waitFor({ timeout: 60_000 });
await page.waitForTimeout(400);
await page.screenshot({ path: join(out, '18-reconnecting.png') });
console.log(join(out, '18-reconnecting.png'));
await waitFor(`${signal}.up`);
await page.getByText('Core Daemon に再接続しています…').waitFor({ state: 'detached', timeout: 60_000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: join(out, '19-reconnected.png') });
console.log(join(out, '19-reconnected.png'));
await browser.close();
