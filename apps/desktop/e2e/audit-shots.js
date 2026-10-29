/* global document, getComputedStyle -- used inside page.evaluate callbacks (browser context) */
// Screenshot sequence for e2e/audit.js (see there). Each shot is independent: a missing
// control is logged and the sequence goes on, so one UI change never hides the other screens.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { connect, log } from './harness.js';

const W = 1440;
const H = 900;

export async function shoot({ url, out, theme, build, home }) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });
  await context.addInitScript((t) => {
    try {
      // Theme only; the first run screen must stay visible on the empty app.
      const raw = localStorage.getItem('acc.ui');
      const cur = raw ? JSON.parse(raw) : { state: {}, version: 1 };
      cur.state = { ...cur.state, theme: t };
      localStorage.setItem('acc.ui', JSON.stringify(cur));
    } catch {
      /* storage blocked */
    }
  }, theme);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const shots = [];
  const missed = [];
  const pause = (ms = 400) => page.waitForTimeout(ms);
  const snap = async (name, opts = {}) => {
    const path = join(out, `${name}.png`);
    await page.screenshot({ path, ...opts });
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
  const mode = async (n) => {
    await page.keyboard.press(`Control+${n}`);
    await pause(700);
  };
  const open = async (title) => {
    await page
      .getByRole('button', { name: `${title} を開く` })
      .first()
      .click();
    await pause(1200);
    await page.mouse.move(W / 2, 60);
  };
  /** Scroll the scrollable element under (x, y) to the bottom, one viewport at a time. */
  const scrollShots = async (prefix, x, y, max = 6) => {
    await page.mouse.move(x, y);
    for (let i = 1; i <= max; i++) {
      const before = await page.evaluate(
        ([px, py]) => {
          let el = document.elementFromPoint(px, py);
          while (
            el &&
            !(
              el.scrollHeight > el.clientHeight + 4 &&
              /(auto|scroll)/.test(getComputedStyle(el).overflowY)
            )
          )
            el = el.parentElement;
          if (!el) return null;
          const top = el.scrollTop;
          el.scrollTop = top + el.clientHeight - 60;
          return { moved: el.scrollTop !== top };
        },
        [x, y],
      );
      if (!before?.moved) return;
      await pause(500);
      await snap(`${prefix}-${i + 1}`);
    }
  };

  /** Scroll the scrollable element under (x, y) to its top; true when it moved. */
  const scrollToTop = async (x, y) => {
    await page.mouse.move(x, y);
    const moved = await page.evaluate(
      ([px, py]) => {
        let el = document.elementFromPoint(px, py);
        while (
          el &&
          !(
            el.scrollHeight > el.clientHeight + 4 &&
            /(auto|scroll)/.test(getComputedStyle(el).overflowY)
          )
        )
          el = el.parentElement;
        if (!el || el.scrollTop === 0) return false;
        el.scrollTop = 0;
        return true;
      },
      [x, y],
    );
    await pause(600);
    return moved;
  };

  // ------------------------------------------------------------------ empty app
  await page.goto(url);
  await step('onboarding', async () => {
    await page.getByRole('dialog', { name: 'はじめに' }).waitFor({ timeout: 20_000 });
    await pause(800);
    await snap('01-onboarding');
    await page.getByRole('button', { name: /LiteLLM Proxy に接続/ }).click();
    await pause(600);
    await snap('02-onboarding-litellm');
  });
  // Skip the first-run screen the way a returning user would have.
  await page.evaluate(() => {
    const raw = localStorage.getItem('acc.ui');
    const cur = raw ? JSON.parse(raw) : { state: {}, version: 1 };
    cur.state = { ...cur.state, onboardingDone: true };
    localStorage.setItem('acc.ui', JSON.stringify(cur));
  });
  await page.reload();
  await page.getByRole('heading', { name: '司令室' }).waitFor({ timeout: 20_000 });
  await pause(1000);
  await snap('03-empty-command');
  await step('empty task tab', async () => {
    await page.getByRole('tab', { name: 'Task' }).click();
    await pause(500);
    await snap('04-empty-command-task');
    await page.getByRole('tab', { name: 'エージェント' }).click();
  });
  await step('empty focus', async () => {
    await mode(2);
    await snap('05-empty-focus');
  });
  await step('empty timeline', async () => {
    await mode(3);
    await snap('06-empty-timeline');
  });
  await mode(1);

  // ------------------------------------------------------------------ the day
  await build();
  await page.reload();
  await page.getByRole('heading', { name: '司令室' }).waitFor({ timeout: 20_000 });
  await pause(2500);

  await snap('10-command-agents');
  await step('command scroll', () => scrollShots('10-command-agents', 900, 600));
  await step('sidebar closeup', () =>
    snap('11-sidebar', { clip: { x: 0, y: 0, width: 300, height: H } }),
  );
  await step('task tab', async () => {
    await mode(1);
    await page.getByRole('tab', { name: 'Task' }).click();
    await pause(800);
    await snap('12-command-task');
    await scrollShots('12-command-task', 900, 600, 3);
  });
  await step('task detail panel', async () => {
    await page.getByRole('tab', { name: 'エージェント' }).click();
    await pause(400);
    await page
      .getByRole('treeitem', { name: /FAQ を 10 問つくる/ })
      .first()
      .click();
    await pause(800);
    await snap('13-command-task-detail');
    await page.keyboard.press('Escape');
  });
  await step('goal header hover', async () => {
    await page
      .getByRole('treeitem', { name: /競合 3 社の調査/ })
      .first()
      .hover();
    await pause(500);
    await snap('14-command-row-hover');
  });

  // Focus: plain chats.
  await step('focus plain chat', async () => {
    await open('Excel の重複行を消したい');
    await snap('20-focus-plain-chat');
  });
  await step('focus streaming chat', async () => {
    await open('ブログ記事: リモートワークの 1 年');
    await snap('21-focus-plain-chat-streaming');
  });
  await step('focus project chat', async () => {
    await open('週次レポート（10/27 週）');
    await snap('22-focus-chat-in-project');
  });
  await step('grant dialog', async () => {
    await open('お詫びメールの下書き');
    await snap('23-focus-plain-chat-2');
    await page
      .getByRole('button', { name: /Orchestrator 権限/ })
      .first()
      .click();
    await pause(600);
    await snap('24-grant-dialog');
    await page.keyboard.press('Escape');
    await pause(300);
  });
  await step('model picker', async () => {
    await page.keyboard.press('Control+m');
    await pause(500);
    await snap('25-model-picker');
    await page.keyboard.press('Escape');
  });

  // Focus: orchestrators.
  await step('focus orchestrator (launch)', async () => {
    await open('ローンチ準備の相談');
    await snap('30-focus-orchestrator-launch');
    if (await scrollToTop(700, 300)) await snap('30-focus-orchestrator-launch-top');
  });
  await step('grant chip', async () => {
    await page.getByTestId('grant-chip').getByRole('button').first().click();
    await pause(500);
    await snap('31-grant-popover');
    await page.keyboard.press('Escape');
  });
  await step('focus orchestrator (web)', async () => {
    await open('ログイン改善の相談');
    await snap('32-focus-orchestrator-web');
    if (await scrollToTop(700, 300)) {
      await snap('32-focus-orchestrator-web-top');
      await scrollShots('32-focus-orchestrator-web-top', 700, 300, 2);
    }
  });

  // Focus: workers.
  await step('focus worker awaiting', async () => {
    await open('Worker: FAQ を 10 問つくる');
    await snap('40-focus-worker-awaiting-approval');
  });
  await step('detail panel tabs', async () => {
    const panel = page.getByRole('tablist').last();
    for (const [i, name] of ['概要', '変更', 'テスト', 'ログ'].entries()) {
      const tab = panel.getByRole('tab', { name });
      if ((await tab.count()) === 0) continue;
      await tab.first().click();
      await pause(600);
      await snap(`41-detail-panel-${i + 1}-${['overview', 'changes', 'tests', 'log'][i]}`);
    }
    await panel.getByRole('tab', { name: '概要' }).first().click();
  });
  await step('focus worker running', async () => {
    await open('Worker: 競合 3 社の調査');
    await snap('42-focus-worker-running');
  });
  await step('focus worker failed', async () => {
    await open('Worker: 既存顧客への告知メール');
    await snap('43-focus-worker-failed');
  });
  await step('focus worker done', async () => {
    await open('Worker: プレスリリース案を書く');
    await snap('44-focus-worker-done');
  });
  await step('focus human agent', async () => {
    await open('依存パッケージの更新');
    await snap('45-focus-agent-running');
  });

  // Approval card through Ctrl+J from the command view.
  await step('approval', async () => {
    await mode(1);
    await page.keyboard.press('Control+j');
    await pause(800);
    await snap('50-next-attention-ctrl-j');
  });

  // Integration review.
  await step('integration', async () => {
    await mode(1);
    await page
      .getByRole('button', { name: /統合: 反映待ち/ })
      .first()
      .click();
    await page.getByTestId('integration-view').waitFor();
    await pause(1200);
    await snap('51-integration-review');
    await page.keyboard.press('Control+Enter');
    await page.getByTestId('apply-dialog').waitFor();
    await pause(400);
    await snap('52-integration-apply-confirm');
    await page.keyboard.press('Escape');
    await pause(300);
    await page.keyboard.press('Escape');
    await pause(500);
  });

  // Timeline.
  await step('timeline', async () => {
    await mode(3);
    await pause(800);
    await snap('60-timeline');
    if (await scrollToTop(800, 400)) await snap('60-timeline-top');
  });
  await step('timeline expanded', async () => {
    await page.getByTestId('timeline-view-menu').click();
    await pause(300);
    await page.getByTestId('show-all-events').click();
    await pause(300);
    await snap('61-timeline-view-menu');
    await page.keyboard.press('Escape');
    await pause(300);
    await scrollToTop(800, 400);
    // Expand the collapsed run groups in view (the list is virtualized); a collapsed
    // header ends with its event count, "(N 件)".
    const collapsed = page.locator('[aria-label="イベント"] button', {
      hasText: /[(（]\d+ 件[)）]/,
    });
    // Bottom-up, so opening one group does not shift the ones still to open.
    const n = Math.min(await collapsed.count(), 40);
    for (let i = n - 1; i >= 0; i--) {
      // A row can scroll out of the virtual window meanwhile: skip it.
      await collapsed
        .nth(i)
        .click({ timeout: 1500 })
        .catch(() => {});
      await pause(100);
    }
    await pause(600);
    await snap('62-timeline-expanded-top');
    await scrollShots('62-timeline-expanded', 800, 400, 3);
  });

  // Palette, settings, project settings, dialogs.
  await step('palette', async () => {
    await mode(1);
    await page.keyboard.press('Control+k');
    await pause(500);
    await snap('70-palette');
    await page.keyboard.type('ローンチ');
    await pause(900);
    await snap('71-palette-search');
    await page.keyboard.press('Escape');
  });
  await step('settings', async () => {
    await page.keyboard.press('Control+,');
    await pause(700);
    await snap('80-settings-1');
    const box = await page.getByRole('dialog').first().boundingBox();
    await scrollShots('80-settings', box.x + box.width / 2, box.y + box.height / 2, 8);
    await page.keyboard.press('Escape');
  });
  await step('project settings', async () => {
    await page
      .getByRole('button', { name: /すべてのプロジェクト/ })
      .first()
      .click();
    await pause(400);
    await snap('81-project-menu');
    await page.getByRole('menuitem', { name: /新製品ローンチ/ }).click();
    await pause(800);
    await snap('82-command-filtered-project');
    await page
      .getByRole('button', { name: /新製品ローンチ/ })
      .first()
      .click();
    await pause(400);
    await page.getByRole('menuitem', { name: /の設定/ }).click();
    await pause(800);
    await snap('83-project-settings-1');
    const box = await page.getByRole('dialog').first().boundingBox();
    await scrollShots('83-project-settings', box.x + box.width / 2, box.y + box.height / 2, 6);
    await page.keyboard.press('Escape');
    await page
      .getByRole('button', { name: /新製品ローンチ/ })
      .first()
      .click();
    await pause(300);
    await page.getByRole('menuitem', { name: 'すべてのプロジェクト' }).click();
    await pause(500);
  });
  await step('shortcuts', async () => {
    await mode(1);
    await page.mouse.click(900, 300);
    await page.keyboard.press('?');
    await pause(600);
    await snap('84-shortcuts');
    await page.keyboard.press('Escape');
  });

  // Toasts: something fails and something asks while the user reads a plain chat.
  await step('toasts', async () => {
    const info = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8'));
    const rpc = await connect(info.port, info.token);
    try {
      await open('Excel の重複行を消したい');
      const projects = await rpc.call('project.list', {});
      const launch = projects.items.find((p) => p.name === '新製品ローンチ');
      const ws = await rpc.call('workspace.create', { projectId: launch.id, label: 'sns-posts' });
      const s = await rpc.call('session.create', {
        kind: 'agent',
        projectId: launch.id,
        workspaceId: ws.id,
        title: 'SNS 告知文の作成',
        runtime: 'mock',
      });
      const plan = {
        steps: [
          { type: 'say', text: '告知文を 3 案つくります。' },
          { type: 'fail', message: '画像素材のフォルダ（assets/sns）が見つかりません。' },
        ],
        delayScale: 0.3,
      };
      await rpc.call('session.send', {
        sessionId: s.id,
        content: `SNS 用の告知文を 3 案つくって\n\n\`\`\`acc-mock\n${JSON.stringify(plan)}\n\`\`\``,
      });
      await page.waitForTimeout(2500);
      await snap('90-toast-failed');
      await page.waitForTimeout(6000);
      await snap('91-toast-later');
    } finally {
      rpc.close();
    }
  });

  // Light theme, the command view once (a context of its own: the init script sets the theme).
  await step('light theme', async () => {
    const light = await browser.newContext({
      viewport: { width: W, height: H },
      deviceScaleFactor: 1,
    });
    await light.addInitScript(() => {
      localStorage.setItem(
        'acc.ui',
        JSON.stringify({ state: { theme: 'light', onboardingDone: true }, version: 1 }),
      );
    });
    const p2 = await light.newPage();
    await p2.goto(url);
    await p2.getByRole('heading', { name: '司令室' }).waitFor({ timeout: 20_000 });
    await p2.waitForTimeout(1500);
    await p2.screenshot({ path: join(out, '95-command-light.png') });
    shots.push('95-command-light');
    await light.close();
  });

  // Last: these create empty sessions that would show up in every later shot.
  await step('new chat', async () => {
    await page.keyboard.press('Control+n');
    await pause(800);
    await snap('96-new-chat-empty');
    await page.keyboard.press('Escape');
  });
  await step('new agent task', async () => {
    await page.keyboard.press('Control+Shift+N');
    await pause(800);
    await snap('97-new-agent-task');
    await page.keyboard.press('Escape');
  });
  await browser.close();
  log(`${shots.length} screenshots in ${out}`);
  if (missed.length) log(`skipped:\n  ${missed.join('\n  ')}`);
  if (errors.length) log(`page errors:\n  ${[...new Set(errors)].slice(0, 20).join('\n  ')}`);
  return { shots, missed, errors };
}
