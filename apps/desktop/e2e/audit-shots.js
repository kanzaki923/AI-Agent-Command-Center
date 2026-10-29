/* global document -- used inside page.evaluate callbacks (browser context) */
// Screenshot sequence for e2e/audit.js (ui-redesign spec §10). Each shot is independent: a
// missing control is logged and the sequence goes on, so one UI change never hides the other
// screens. File names are stable so every track can find its own screen.
//
//   00-onboarding           first run
//   01-home-empty           the empty home
//   10-home-1440            home, 1440x900 (3 trees, 10+ children, attention on top)
//   11-home-1280            home, 1280x800
//   12-home-attention       home with the first attention item selected (Ctrl+J)
//   13-home-light           home in the light theme
//   20-sidebar-tree         the sidebar while conversation A is open
//   30-session-supervisor   conversation A (the supervisor)
//   31-child-working        a working child of A
//   32-child-question       the child asking a question
//   33-child-failed         the failed child
//   34-child-done           the finished child (a document)
//   35-child-code-review    B's child waiting for review of code, with the outputs panel
//   36-child-approval       B's child waiting for a command approval
//   37-chat-streaming       a plain chat still being written (opened mid-stream)
//   40-settings             settings
//   41-cost-popover         the title bar's cost popover
//   42-repeat-popover       繰り返す of conversation A
//   50-timeline             timeline (default)
//   51-timeline-detail      timeline with details
//   60-palette              the palette with a search
//   61-draft                Ctrl+N: the draft of a new conversation
import { join } from 'node:path';
import { chromium } from 'playwright';
import { log } from './harness.js';

const W = 1440;
const H = 900;

/** localStorage of the UI store (zustand persist, version 2). */
const uiState = (state) => JSON.stringify({ state, version: 2 });

export async function shoot({ url, out, theme, build }) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await context.addInitScript(
    ([t, initial]) => {
      try {
        // Theme only; the first run screen must stay visible on the empty app.
        const raw = localStorage.getItem('acc.ui');
        const cur = raw ? JSON.parse(raw) : JSON.parse(initial);
        cur.state = { ...cur.state, theme: t };
        localStorage.setItem('acc.ui', JSON.stringify(cur));
      } catch {
        /* storage blocked */
      }
    },
    [theme, uiState({})],
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const shots = [];
  const missed = [];
  const pause = (ms = 400) => page.waitForTimeout(ms);
  const snap = async (name, p = page) => {
    await p.screenshot({ path: join(out, `${name}.png`) });
    shots.push(name);
    log(`shot ${name}`);
  };
  /** Run one step; log and go on when the UI does not offer what it needs. */
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      missed.push(`${name}: ${String(err.message ?? err).split('\n')[0]}`);
      log(`skip ${name}: ${String(err.message ?? err).split('\n')[0]}`);
      await page.keyboard.press('Escape').catch(() => {});
    }
  };
  const calm = async () => {
    await page.mouse.move(W - 4, H / 2);
    await pause(700);
  };
  const home = async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+1');
    await calm();
  };
  /** Open a conversation by its title through the palette (as a user would). */
  const open = async (title) => {
    await page.keyboard.press('Control+1');
    await page.keyboard.press('Control+k');
    await pause(300);
    await page.keyboard.type(`#${title}`);
    await pause(500);
    // The row whose own label (not the parent named beside a child) is the title.
    const labels = await page.evaluate((t) => {
      const rows = [...document.querySelectorAll('[cmdk-item]')];
      const row = rows.find((el) => el.querySelector('span.truncate')?.textContent === t);
      row?.click();
      return row ? null : rows.map((el) => el.querySelector('span.truncate')?.textContent ?? '?');
    }, title);
    if (labels) throw new Error(`no conversation 「${title}」 in the palette (${labels.join(' / ')})`);
    await pause(1300);
    await calm();
  };

  // ------------------------------------------------------------------ empty app
  await page.goto(url);
  await step('onboarding', async () => {
    await page.getByRole('dialog', { name: 'はじめに' }).waitFor({ timeout: 20_000 });
    await pause(800);
    await snap('00-onboarding');
  });
  // Skip the first-run screen the way a returning user would have.
  await page.evaluate((initial) => {
    const raw = localStorage.getItem('acc.ui');
    const cur = raw ? JSON.parse(raw) : JSON.parse(initial);
    cur.state = { ...cur.state, onboardingDone: true };
    localStorage.setItem('acc.ui', JSON.stringify(cur));
  }, uiState({}));
  await page.reload();
  await step('empty home', async () => {
    await page.getByRole('textbox', { name: '何を頼みますか' }).waitFor({ timeout: 20_000 });
    await calm();
    await snap('01-home-empty');
  });

  // ------------------------------------------------------------------ the scene
  await build();
  await page.reload();
  await page.getByRole('region', { name: '新製品ローンチ準備' }).waitFor({ timeout: 30_000 });
  await pause(2500);

  await step('home 1440', async () => {
    await calm();
    await snap('10-home-1440');
  });
  await step('home 1280', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await calm();
    await snap('11-home-1280');
    await page.setViewportSize({ width: W, height: H });
    await pause(400);
  });
  await step('home attention selected', async () => {
    await page.keyboard.press('Control+j');
    await pause(600);
    await snap('12-home-attention');
  });

  await step('sidebar tree', async () => {
    await open('新製品ローンチ準備');
    await snap('20-sidebar-tree');
    await snap('30-session-supervisor');
  });
  await step('repeat popover', async () => {
    await page.getByRole('button', { name: '繰り返す' }).first().click();
    await pause(500);
    await snap('42-repeat-popover');
    await page.keyboard.press('Escape');
  });
  for (const [name, title] of [
    ['31-child-working', '競合 3 社の調査'],
    ['32-child-question', 'FAQ を 10 問つくる'],
    ['33-child-failed', '配信リストの整理'],
    ['34-child-done', 'プレスリリース案'],
    ['35-child-code-review', 'エラーメッセージを直す'],
    ['36-child-approval', '入力チェックを入れる'],
    ['37-chat-streaming', 'ブログ記事: リモートワークの 1 年'],
  ]) {
    await step(name, async () => {
      await open(title);
      await snap(name);
    });
  }

  await step('settings', async () => {
    await home();
    await page.keyboard.press('Control+,');
    await pause(700);
    await snap('40-settings');
    await page.keyboard.press('Escape');
  });
  await step('cost popover', async () => {
    await home();
    await page.getByRole('button', { name: '今日の費用' }).click();
    await pause(700);
    await snap('41-cost-popover');
    await page.keyboard.press('Escape');
  });

  await step('timeline', async () => {
    await page.keyboard.press('Control+2');
    await calm();
    await snap('50-timeline');
  });
  await step('timeline detail', async () => {
    await page.keyboard.press('Control+k');
    await pause(300);
    await page.keyboard.type('タイムライン: 詳細');
    await pause(400);
    await page.keyboard.press('Enter');
    await calm();
    await snap('51-timeline-detail');
  });

  await step('palette', async () => {
    await home();
    await page.keyboard.press('Control+k');
    await pause(400);
    await page.keyboard.type('FAQ');
    await pause(900);
    await snap('60-palette');
    await page.keyboard.press('Escape');
  });
  await step('draft', async () => {
    await home();
    await page.keyboard.press('Control+n');
    await pause(700);
    await snap('61-draft');
    await home();
  });

  // Light theme, home once (a context of its own: the init script sets the theme).
  await step('light theme', async () => {
    const light = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await light.addInitScript((s) => localStorage.setItem('acc.ui', s), uiState({ theme: 'light', onboardingDone: true }));
    const p2 = await light.newPage();
    await p2.goto(url);
    await p2.getByRole('region', { name: '新製品ローンチ準備' }).waitFor({ timeout: 20_000 });
    await p2.mouse.move(W - 4, H / 2);
    await p2.waitForTimeout(1500);
    await snap('13-home-light', p2);
    await light.close();
  });

  await browser.close();
  log(`${shots.length} screenshots in ${out}`);
  if (missed.length) log(`skipped:\n  ${missed.join('\n  ')}`);
  if (errors.length) log(`page errors:\n  ${[...new Set(errors)].slice(0, 20).join('\n  ')}`);
  return { shots, missed, errors };
}
