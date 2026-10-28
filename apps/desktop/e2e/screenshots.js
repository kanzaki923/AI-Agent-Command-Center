/* global document */
// Visual check of the desktop UI in browser mode (Vite dev server + a running daemon).
//
//   node e2e/screenshots.js [--url http://127.0.0.1:5173] [--onboarding-url http://127.0.0.1:5174] [--out <dir>]
//
// Screenshots go to the OS temp dir by default (never into the repo).
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : def;
};
const url = arg('url', 'http://127.0.0.1:5173/');
const onboardingUrl = arg('onboarding-url', null);
const out = arg('out', join(tmpdir(), 'acc-desktop-screenshots'));
const only = arg('only', null);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const shot = async (name) => {
  const path = join(out, `${name}.png`);
  await page.screenshot({ path });
  console.log(path);
};
const want = (name) => !only || only.split(',').includes(name);

await page.goto(url);
await page.getByRole('heading', { name: '司令室' }).waitFor({ timeout: 20_000 });
await page.waitForTimeout(1200);

if (want('command')) await shot('01-command');

if (want('palette')) {
  await page.keyboard.press('Control+K');
  await page.waitForTimeout(250);
  await shot('02-palette');
  await page.keyboard.type('てすと');
  await page.waitForTimeout(150);
  await shot('02b-palette-search');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

if (want('select')) {
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  await shot('03-command-panel');
  await page.keyboard.press('Space');
}

if (want('focus')) {
  await page.getByRole('button', { name: '認証機能の改善 を開く' }).first().click();
  await page.waitForTimeout(1500);
  await shot('04-focus');
  await page.getByRole('tab', { name: '変更' }).click();
  await page.waitForTimeout(300);
  await page.locator('[data-region="panel"]').getByRole('button', { name: /src\/auth\/session\.ts/ }).click();
  await page.waitForTimeout(300);
  await shot('05-focus-diff');
  await page.getByRole('tab', { name: '概要' }).click();
  await page.keyboard.press('Control+M');
  await page.waitForTimeout(300);
  await shot('05b-model-picker');
  await page.keyboard.press('Escape');
}

if (want('chat')) {
  await page.getByRole('button', { name: '週次レポートの下書き を開く' }).first().click();
  await page.waitForTimeout(800);
  await shot('06-focus-chat');
}

if (want('timeline')) {
  await page.keyboard.press('Control+3');
  await page.waitForTimeout(1200);
  await shot('07-timeline');
}

if (want('send')) {
  await page.getByRole('button', { name: 'レビュー観点の整理 を開く' }).first().click();
  await page.waitForTimeout(500);
  const box = page.getByRole('textbox', { name: 'メッセージ' });
  await box.click();
  await box.fill('レビューで見るべき観点を、優先度順に整理して');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1600);
  await shot('12-send-streaming');
  await page.waitForTimeout(4000);
  await shot('13-send-done');
}

if (want('approve')) {
  await page.keyboard.press('Control+1');
  await page.waitForTimeout(600);
  await page.keyboard.press('Control+J');
  await page.waitForTimeout(300);
  await shot('14-ctrl-j');
  await page.keyboard.press('y');
  await page.waitForTimeout(250);
  await shot('15-approved');
  await page.waitForTimeout(1500);
  await shot('16-after-approve');
}

if (want('ask')) {
  await page.keyboard.press('Control+K');
  await page.waitForTimeout(200);
  await page.keyboard.type('テスト担当をもう2人追加して');
  await page.waitForTimeout(200);
  await shot('17-palette-ask-ai');
  await page.keyboard.press('Escape');
}

if (want('light')) {
  await page.keyboard.press('Control+1');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.waitForTimeout(600);
  await shot('08-command-light');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
}

if (want('settings')) {
  await page.keyboard.press('Control+,');
  await page.waitForTimeout(400);
  await shot('09-settings');
  await page.keyboard.press('Escape');
}

if (onboardingUrl && want('onboarding')) {
  const p2 = await context.newPage();
  await p2.goto(onboardingUrl);
  await p2.getByText('AI エージェントのチームを始めましょう').waitFor({ timeout: 20_000 });
  await p2.waitForTimeout(500);
  await p2.screenshot({ path: join(out, '10-onboarding.png') });
  console.log(join(out, '10-onboarding.png'));
  await p2.keyboard.press('Enter');
  await p2.waitForTimeout(400);
  await p2.screenshot({ path: join(out, '11-onboarding-litellm.png') });
  console.log(join(out, '11-onboarding-litellm.png'));
}

if (errors.length) {
  console.log('--- page errors ---');
  for (const e of errors) console.log(e);
}
await browser.close();
