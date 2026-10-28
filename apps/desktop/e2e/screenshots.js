// Visual check of the desktop UI in browser mode, against the REAL daemon scene
// (scripts/scene.ts) and the Vite dev server pointed at the same ACC_HOME:
//
//   ACC_HOME=<dir> pnpm --filter @acc/desktop scene
//   ACC_HOME=<dir> pnpm --filter @acc/desktop dev
//   node e2e/screenshots.js [--url http://127.0.0.1:5173/] [--out <dir>] [--only a,b]
//
// Screenshots go to the OS temp dir by default (never into the repo), at 1440x900.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : def;
};
const url = arg('url', 'http://127.0.0.1:5173/');
const out = arg('out', join(tmpdir(), 'acc-desktop-screenshots'));
const only = arg('only', null);
const theme = arg('theme', 'dark');
// --size 1100x720 for the narrow layout (default 1440x900).
const [width, height] = arg('size', '1440x900').split('x').map(Number);
const prefix = arg('prefix', '');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
// The scene is already set up: skip the first-run screen; pick the theme (--theme light).
await context.addInitScript((t) => {
  try {
    const raw = localStorage.getItem('acc.ui');
    const cur = raw ? JSON.parse(raw) : { state: {}, version: 1 };
    cur.state = { ...cur.state, onboardingDone: true, theme: t };
    localStorage.setItem('acc.ui', JSON.stringify(cur));
  } catch {
    /* storage blocked: the onboarding check also yields to existing sessions */
  }
}, theme);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const shot = async (name) => {
  const path = join(out, `${prefix}${name}.png`);
  await page.screenshot({ path });
  console.log(path);
};
const want = (name) => !only || only.split(',').includes(name);

await page.goto(url);
await page.getByRole('heading', { name: '司令室' }).waitFor({ timeout: 20_000 });
await page.waitForTimeout(1200);

if (want('command')) await shot('01-command');

if (want('task')) {
  await page.getByRole('treeitem', { name: /認証のテストを追加する/ }).first().click();
  await page.waitForTimeout(500);
  await shot('02-task-detail');
}

if (want('integration')) {
  await page.getByRole('button', { name: /統合: 反映待ち/ }).first().click();
  await page.getByTestId('integration-view').waitFor();
  await page.waitForTimeout(1200);
  await shot('03-integration');
  await page.keyboard.press('j');
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+Enter');
  await page.getByTestId('apply-dialog').waitFor();
  await page.waitForTimeout(300);
  await shot('04-apply-confirm');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

if (want('focus')) {
  await page.getByRole('button', { name: '設計チャット を開く' }).first().click();
  await page.waitForTimeout(1200);
  await shot('05-focus-orchestrator');
  await page.getByTestId('grant-chip').getByRole('button').first().click();
  await page.waitForTimeout(400);
  await shot('06-grant-popover');
  await page.keyboard.press('Escape');
}

if (want('grant')) {
  await page.getByRole('button', { name: '週次レポートの下書き を開く' }).first().click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: /Orchestrator 権限: なし/ }).click();
  await page.waitForTimeout(400);
  await shot('07-grant-dialog');
  await page.getByRole('button', { name: '権限を与える' }).click();
  await page.waitForTimeout(700);
  await shot('08-granted');
}

if (want('approval')) {
  await page.keyboard.press('Control+1');
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+J');
  await page.waitForTimeout(400);
  await shot('09-ctrl-j-approval');
}

if (want('project')) {
  await page.getByRole('button', { name: /acme-web|すべてのプロジェクト/ }).first().click();
  await page.waitForTimeout(300);
  await shot('10-project-menu');
  await page.getByRole('menuitem', { name: 'プロジェクトを追加…' }).click();
  await page.waitForTimeout(300);
  await page.getByLabel('Git リポジトリのフォルダ').fill('C:\\not\\a\\repo');
  await page.getByRole('button', { name: 'プロジェクトを追加' }).click();
  await page.waitForTimeout(600);
  await shot('11-project-add-error');
  await page.keyboard.press('Escape');
}

if (want('timeline')) {
  await page.keyboard.press('Control+3');
  await page.waitForTimeout(1200);
  await shot('12-timeline');
}

if (want('board')) {
  await page.keyboard.press('Control+1');
  await page.waitForTimeout(400);
  await page.getByRole('tab', { name: /Task/ }).click();
  await page.getByTestId('task-board').waitFor();
  await page.keyboard.press('j');
  await page.waitForTimeout(400);
  await shot('13-task-board');
  await page.getByRole('tab', { name: 'エージェント' }).click();
  await page.waitForTimeout(300);
}

if (want('palette')) {
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(400);
  await shot('14-palette');
  await page.keyboard.type('進捗');
  await page.waitForTimeout(900);
  await shot('15-palette-search');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

if (want('chat')) {
  await page.getByRole('button', { name: 'レビュー観点の整理 を開く' }).first().click();
  await page.waitForTimeout(1000);
  await page.mouse.move(600, 200);
  await shot('16-chat');
}

if (want('settings')) {
  await page.keyboard.press('Control+,');
  await page.waitForTimeout(500);
  await shot('17-settings');
  await page.keyboard.press('Escape');
}

if (errors.length) {
  console.log('--- page errors ---');
  for (const e of errors) console.log(e);
}
await browser.close();
