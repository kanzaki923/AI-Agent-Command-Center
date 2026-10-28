/* global requestAnimationFrame */
// Feel check (ui-design §10): N chats streaming at once must keep the UI at frame rate.
//
//   pnpm --filter @acc/desktop e2e:perf [-- --streams 10] [--seconds 6] [--dev] [--profile] [--headed] [--keep]
//
// Starts a real daemon + a production build of the UI (vite build + preview; --dev uses the
// dev server, whose React development checks cost ~5x), opens the app at 1440x900, starts
// N chat sessions on the offline mock/echo model with long replies, then measures frame
// pacing (requestAnimationFrame intervals) and long tasks: while all N start at once (rows
// move zones), while they stream on the Command board, and in Focus on one streaming chat
// (Markdown). --profile prints where the start burst's main-thread time went.
// Prints the numbers and fails only on clear jank (thresholds below), since headless
// timing varies by machine.
import { chromium } from 'playwright';
import { flag, log, opt, startStack, waitFor } from './harness.js';

const STREAMS = Number(opt('streams', '10'));
const SECONDS = Number(opt('seconds', '6'));
const LIMITS = { p95Ms: 34, longTaskMaxMs: 200 };

const LONG = Array.from(
  { length: 60 },
  (_, i) =>
    `段落 ${i + 1}: 並列で動くエージェントの出力を、**滑らかに**描画できるかを確かめるための長めの文章です。\`code\` も混ぜます。`,
).join('\n\n');

async function measure(page, seconds) {
  return page.evaluate(async (ms) => {
    const frames = [];
    const longTasks = [];
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push(e.duration);
    });
    try {
      po.observe({ type: 'longtask', buffered: false });
    } catch {
      /* not supported: frame pacing only */
    }
    await new Promise((resolve) => {
      let last = performance.now();
      const end = last + ms;
      const tick = (t) => {
        frames.push(t - last);
        last = t;
        if (t < end) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    po.disconnect();
    const sorted = [...frames].sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    return {
      frames: frames.length,
      p50: q(0.5),
      p95: q(0.95),
      max: sorted[sorted.length - 1],
      over33: frames.filter((f) => f > 33.4).length,
      longTasks: longTasks.length,
      longTaskMax: longTasks.length ? Math.max(...longTasks) : 0,
    };
  }, seconds * 1000);
}

const fmt = (r) =>
  `${r.frames} frames · p50 ${r.p50.toFixed(1)}ms · p95 ${r.p95.toFixed(1)}ms · max ${r.max.toFixed(0)}ms · >33ms ${r.over33} · long tasks ${r.longTasks} (max ${r.longTaskMax.toFixed(0)}ms)`;

let stack;
let browser;
let failed = false;
try {
  stack = await startStack({ prod: !flag('dev') });
  const { rpc, url } = stack;
  const sessions = [];
  for (let i = 0; i < STREAMS; i++) {
    sessions.push(
      await rpc.call('session.create', {
        kind: 'chat',
        title: `並列 ${i + 1}`,
        model: 'mock/echo',
      }),
    );
  }

  browser = await chromium.launch({ headless: !flag('headed') });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem('acc.ui', JSON.stringify({ state: { onboardingDone: true }, version: 1 }));
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.getByRole('heading', { name: '司令室' }).waitFor({ timeout: 30_000 });
  // Everything visible so the board has the most work to do.
  await page
    .getByRole('button', { name: /^未実行/ })
    .click()
    .catch(() => {});

  const idle = await measure(page, 2);
  log(`idle board        ${fmt(idle)}`);

  // The burst: N rows leave 未実行 and enter 実行中 at once (layout moves + first deltas).
  const cdp = flag('profile') ? await context.newCDPSession(page) : null;
  if (cdp) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
  }
  const burstP = measure(page, 1.5);
  for (const s of sessions) await rpc.call('session.send', { sessionId: s.id, content: LONG });
  const burst = await burstP;
  log(`${STREAMS} starts, burst ${fmt(burst)}`);
  if (cdp) {
    // --profile: where the burst's main-thread time went (self time per function).
    const { profile } = await cdp.send('Profiler.stop');
    const self = new Map();
    const dt = new Map();
    profile.samples.forEach((id, i) =>
      dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)),
    );
    for (const node of profile.nodes) {
      const { functionName, url, lineNumber } = node.callFrame;
      const key = `${functionName || '(anonymous)'} ${url.split('/').pop()}:${lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + (dt.get(node.id) ?? 0));
    }
    const top = [...self.entries()]
      .filter(([k]) => !k.startsWith('(idle)') && !k.startsWith('(program)'))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
    for (const [k, us] of top) log(`  ${(us / 1000).toFixed(1).padStart(7)}ms  ${k}`);
  }
  await waitFor(async () => {
    const runs = (await rpc.call('run.list', { status: ['running'] })).items;
    return runs.length >= Math.min(STREAMS, 10);
  }, 'runs to stream');
  const board = await measure(page, SECONDS);
  log(`${STREAMS} streams, board ${fmt(board)}`);

  await page.getByRole('button', { name: `並列 1 を開く` }).first().click();
  await page
    .locator('.md-streaming')
    .first()
    .waitFor({ timeout: 10_000 })
    .catch(() => {});
  const focus = await measure(page, SECONDS);
  log(`${STREAMS} streams, focus ${fmt(focus)}`);

  const still = (await rpc.call('run.list', { status: ['running'] })).items.length;
  log(`runs still streaming at the end: ${still}/${STREAMS}`);

  // The start burst is held to the same bar only on a production build.
  for (const [name, r] of [
    ...(flag('dev') ? [] : [['burst', burst]]),
    ['board', board],
    ['focus', focus],
  ]) {
    if (r.p95 > LIMITS.p95Ms || r.longTaskMax > LIMITS.longTaskMaxMs) {
      failed = true;
      log(
        `FAIL ${name}: p95 ${r.p95.toFixed(1)}ms (limit ${LIMITS.p95Ms}), longest task ${r.longTaskMax.toFixed(0)}ms (limit ${LIMITS.longTaskMaxMs})`,
      );
    }
  }
  if (!failed) log('PASS');
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await browser?.close().catch(() => {});
  await stack?.stop({ keep: flag('keep') });
  process.exit(failed ? 1 : 0);
}
