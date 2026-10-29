/* global document -- used inside page.evaluate callbacks (browser context) */
// The 5-second test, made mechanical (ui-redesign spec §0, §3): with more than ten agents at
// once (the audit scene: scripts/audit-scene.ts, mock models and the mock runtime only), the
// home must show — without opening any conversation — overall progress, problems and where
// the human is needed. Checked in the DOM against the daemon's own snapshot (home.get):
//
//   - the attention rows, in the daemon's priority order (5 + 「あと N 件」 when more than 6);
//   - the attention count in the title bar, and today's spend against the daily limit;
//   - one lane per tree, in the daemon's order, named like the tree; settled trees folded;
//   - every child as a chip with its state (data-state and the state icon), ordered by state
//     priority; a working child says what it is doing now; an alarm chip names its problem;
//   - all of it at 1440x900 without scrolling, and no machine words (ids, Task / Run …).
//
//   pnpm --filter @acc/desktop e2e:home [-- --headed] [--keep] [--out <dir>]
//
// Screenshots go to the OS temp dir (never the repo). Exit code 0 = pass.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { flag, log, openPage, opt, startScene, waitFor } from './harness.js';

const keep = flag('keep');
const out = opt('out', join(tmpdir(), 'acc-e2e-home'));
mkdirSync(out, { recursive: true });

/** Spec §1.1: priority of session states (sorting and counting). */
const STATE_RANK = ['needs_you', 'failed', 'working', 'supervising', 'queued', 'review', 'stopped', 'done', 'idle'];
/** The band's segments (spec §3.1): state and its key in HomeTree.counts. */
const BAND = [
  ['needs_you', 'needsYou'],
  ['failed', 'failed'],
  ['working', 'working'],
  ['queued', 'queued'],
  ['review', 'review'],
  ['stopped', 'stopped'],
  ['done', 'done'],
];
const SETTLED = new Set(['done', 'idle', 'stopped']);
const OPEN_COUNTS = ['working', 'queued', 'needsYou', 'failed', 'review'];
const ATTENTION_LABEL = {
  question: '質問',
  approval: '確認',
  failure: '失敗',
  review: '確認待ち',
  budget: '予算',
  stuck: '止まっている',
};
/** Words and shapes a person must never read on the home (spec §0.3). */
const MACHINE = /\b(Task|Run|Worker|Orchestrator|Integration|Grant)\b|\b(ses|atn|art|prj|run|int)_[0-9a-z]{6,}|\{"/;

const titleOf = (c) => (c.title.trim() ? c.title : c.kind === 'agent' ? '無題のエージェント' : '新しい会話');
const usd = (n) => (n < 0.005 ? '<$0.01' : `$${n.toFixed(2)}`);

/** What the home shows, read from the DOM. */
function readHome(page) {
  return page.evaluate(() => {
    const main = document.querySelector('[data-region="main"]');
    const text = (el) => (el?.textContent ?? '').trim();
    return {
      attention: [...document.querySelectorAll('[data-attention-row]')].map((el) => ({
        id: el.getAttribute('data-attention-row'),
        label: el.getAttribute('aria-label'),
        buttons: [...el.querySelectorAll('button')].map((b) => text(b)),
      })),
      more: [...document.querySelectorAll('section[aria-label="出番"] > button')].map((b) => text(b)),
      count: text(document.querySelector('[data-testid="attention-count"]')) || null,
      cost: (() => {
        const m = document.querySelector('[data-testid="today-cost"] [role="meter"]');
        return m ? { max: m.getAttribute('aria-valuemax'), text: m.getAttribute('aria-valuetext') } : null;
      })(),
      lanes: [...document.querySelectorAll('[data-lane]')].map((lane) => ({
        id: lane.getAttribute('data-lane'),
        compact: lane.hasAttribute('data-compact'),
        title: text(lane.querySelector('[data-lane-root]')),
        heading: text(lane.firstElementChild),
        headingStates: [...lane.firstElementChild.querySelectorAll('[role="img"][data-state]')].map((i) =>
          i.getAttribute('data-state'),
        ),
        band: [...lane.querySelectorAll('[data-band-state]')].map((b) => b.getAttribute('data-band-state')),
        chips: [...lane.querySelectorAll('[data-session-chip]')].map((c) => ({
          id: c.getAttribute('data-session-chip'),
          state: c.getAttribute('data-state'),
          icon: c.querySelector('[role="img"][data-state]')?.getAttribute('data-state') ?? null,
          iconLabel: c.querySelector('[role="img"][data-state]')?.getAttribute('aria-label') ?? null,
          text: c.innerText,
        })),
      })),
      scroll: main ? { height: main.scrollHeight, client: main.clientHeight } : null,
      body: document.body.innerText,
    };
  });
}

/** Everything the DOM gets wrong against the snapshot (empty: the home tells the truth). */
function mismatches(snap, dom) {
  const bad = [];
  // Attention: daemon order is priority order; the rows follow it (5 + more when over 6).
  const prio = snap.attention.map((a) => a.priority);
  if (prio.some((p, i) => i > 0 && p < prio[i - 1])) bad.push(`home.get attention is not in priority order: ${prio}`);
  const shown = snap.attention.length > 6 ? snap.attention.slice(0, 5) : snap.attention;
  const ids = dom.attention.map((r) => r.id);
  if (ids.join() !== shown.map((a) => a.id).join())
    bad.push(`attention rows ${ids.length} (${dom.attention.map((r) => r.label).join(' | ')}) ≠ ${shown.map((a) => a.title).join(' | ')}`);
  for (const [i, a] of shown.entries()) {
    const row = dom.attention[i];
    if (!row) continue;
    if (row.label !== `${ATTENTION_LABEL[a.kind]}: ${a.title}`) bad.push(`attention row ${i} says "${row.label}"`);
    for (const c of a.choices) if (!row.buttons.some((b) => b.includes(c.label))) bad.push(`attention "${a.title}" lacks the choice ${c.label}`);
  }
  if (snap.attention.length > 6 && !dom.more.some((t) => t === `あと ${snap.attention.length - 5} 件`))
    bad.push(`no 「あと N 件」 (${dom.more})`);
  // Title bar: attention count and today's spend against the limit.
  const needs = snap.totals.needsYou;
  if ((needs > 0 ? String(needs) : null) !== dom.count) bad.push(`attention count "${dom.count}", expected ${needs}`);
  const limit = snap.totals.dailyLimitUsd;
  if (!dom.cost) bad.push('no today-cost meter');
  else {
    if (Number(dom.cost.max) !== limit) bad.push(`cost meter limit ${dom.cost.max}, expected ${limit}`);
    if (!dom.cost.text?.startsWith(usd(snap.totals.spendTodayUsd))) bad.push(`cost meter "${dom.cost.text}", spent ${usd(snap.totals.spendTodayUsd)}`);
  }
  // Lanes: one per tree in the daemon's order.
  if (dom.lanes.map((l) => l.id).join() !== snap.trees.map((t) => t.root.id).join())
    bad.push(`lanes ${dom.lanes.map((l) => l.title).join(' / ')} ≠ trees ${snap.trees.map((t) => titleOf(t.root)).join(' / ')}`);
  for (const t of snap.trees) {
    const lane = dom.lanes.find((l) => l.id === t.root.id);
    if (!lane) continue;
    const name = titleOf(t.root);
    if (lane.title !== name) bad.push(`lane "${lane.title}" should be "${name}"`);
    const kids = t.nodes.filter((n) => n.depth >= 1);
    const settled =
      !snap.attention.some((a) => a.rootSessionId === t.root.id) &&
      !OPEN_COUNTS.some((k) => t.counts[k] > 0) &&
      [t.root, ...t.nodes].every((c) => SETTLED.has(c.state));
    if (lane.compact !== settled) bad.push(`lane "${name}" ${lane.compact ? 'folded' : 'open'} but ${settled ? 'settled' : 'busy'}`);
    if (kids.length === 0) {
      // A childless tree: its root's state beside the title (and what it does now).
      if (t.root.state !== 'idle' && !lane.headingStates.includes(t.root.state))
        bad.push(`lane "${name}" does not show its state ${t.root.state}`);
      if (t.root.state === 'working' && t.root.now && !lane.heading.includes(t.root.now))
        bad.push(`lane "${name}" does not say "${t.root.now}"`);
      continue;
    }
    // The state band: the tree's counts, in priority order.
    const band = BAND.filter(([, key]) => t.counts[key] > 0).map(([state]) => state);
    if (lane.band.join() !== band.join()) bad.push(`lane "${name}" band [${lane.band}] ≠ [${band}]`);
    if (settled) continue;
    const chipIds = lane.chips.map((c) => c.id).sort().join();
    if (chipIds !== kids.map((k) => k.id).sort().join())
      bad.push(`lane "${name}": ${lane.chips.length} chips for ${kids.length} children`);
    const ranks = lane.chips.map((c) => STATE_RANK.indexOf(c.state));
    if (ranks.some((r, i) => i > 0 && r < ranks[i - 1])) bad.push(`lane "${name}": chips not in state order (${lane.chips.map((c) => c.state)})`);
    for (const k of kids) {
      const chip = lane.chips.find((c) => c.id === k.id);
      if (!chip) continue;
      if (chip.state !== k.state || chip.icon !== k.state || !chip.iconLabel)
        bad.push(`chip "${titleOf(k)}": state ${chip.state}, icon ${chip.icon} (${chip.iconLabel}), expected ${k.state}`);
      if (k.state === 'working' && k.now && !chip.text.includes(k.now)) bad.push(`working chip "${titleOf(k)}" does not say "${k.now}"`);
      if (k.state === 'needs_you') {
        const a = snap.attention.find((x) => k.attentionIds.includes(x.id));
        if (a && !chip.text.includes(a.title)) bad.push(`chip "${titleOf(k)}" does not name its attention "${a.title}"`);
      }
    }
  }
  if (!dom.scroll) bad.push('no main region');
  else if (dom.scroll.height > dom.scroll.client + 1) bad.push(`the home scrolls (${dom.scroll.height} > ${dom.scroll.client})`);
  const machine = MACHINE.exec(dom.body);
  if (machine) bad.push(`machine words on the home: "${machine[0]}"`);
  return bad;
}

let browser;
let scene;
let failed = false;

try {
  scene = await startScene();
  const ids = await scene.build();
  const { rpc, url } = scene;
  const snap0 = await rpc.call('home.get', {});
  const agents = snap0.trees.reduce((n, t) => n + t.nodes.filter((x) => x.depth >= 1).length, 0);
  if (agents < 10) throw new Error(`the scene has ${agents} children, expected 10 or more`);
  log(`scene: ${snap0.trees.length} trees, ${agents} children, ${snap0.attention.length} attention items`);

  browser = await chromium.launch({ headless: !flag('headed') });
  const { page, errors, shot } = await openPage(browser, { url, out });
  await page.locator(`[data-lane="${ids.a}"]`).waitFor({ timeout: 30_000 });
  // The pointer off the board: places only hold still under it.
  await page.mouse.move(1436, 450);

  // The DOM follows the daemon through events: wait until it tells the same story.
  let last = [];
  let snap;
  let dom;
  try {
    await waitFor(
      async () => {
        snap = await rpc.call('home.get', {});
        dom = await readHome(page);
        last = mismatches(snap, dom);
        return last.length === 0;
      },
      'the home to show the snapshot',
      20_000,
      300,
    );
  } catch {
    await shot('home-mismatch');
    throw new Error(`the home does not tell the truth:\n  ${last.join('\n  ')}`);
  }
  await shot('home-1440');

  // The facts the scene was built to show, named (not just "equal to the snapshot").
  const a = snap.trees.find((t) => t.root.id === ids.a);
  const kinds = new Set(snap.attention.map((x) => x.kind));
  for (const k of ['question', 'approval']) if (!kinds.has(k)) throw new Error(`no ${k} on the home`);
  const states = new Set(a.nodes.map((n) => n.state));
  for (const s of ['working', 'needs_you', 'failed', 'done']) if (!states.has(s)) throw new Error(`tree A has no ${s} child`);
  const working = dom.lanes.flatMap((l) => l.chips).filter((c) => c.state === 'working');
  log(`attention ${dom.attention.length} rows (${dom.attention.map((r) => r.label).join(' | ')})`);
  log(`lanes: ${dom.lanes.map((l) => `${l.title}${l.compact ? ' (folded)' : ` [${l.chips.map((c) => c.state).join(' ')}]`}`).join(' / ')}`);
  log(`working chips say: ${working.map((c) => c.text.split('\n')[1]).join(' / ')}`);
  log(`title bar: 出番 ${dom.count}, ${dom.cost.text}`);

  if (errors.length) throw new Error(`page errors:\n  ${errors.join('\n  ')}`);
  log('PASS (the home tells progress, problems and where you are needed at a glance)');
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await browser?.close().catch(() => {});
  await scene?.stop({ keep });
  process.exit(failed ? 1 : 0);
}
