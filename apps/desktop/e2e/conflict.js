// End-to-end check of two code changes that conflict, against a REAL Core Daemon (no paid LLM
// calls: mock models; the mock agent runtime resolves a conflict by keeping both sides).
//
//   pnpm --filter @acc/desktop e2e:conflict [-- --headed] [--keep] [--out <dir>] [--daemon-root <checkout>]
//
//   1. A temporary git repository becomes a project. A delegated conversation has two children
//      on the code (worktrees); each appends its own section to README.md, so whichever is
//      applied second conflicts. Both wait for review.
//   2. In the UI: open the first child from its chip on home, 採用 → 反映済み (main moves).
//   3. Open the second, 採用: the bar says 競合 and offers 解消を任せる; home shows the failure
//      row for it. main is unchanged by the failed attempt.
//   4. 解消を任せる: an agent merges both sections; the change then waits for 反映 (the resolution
//      is code nobody has seen yet), main still unchanged. Nothing asked for an approval.
//   5. 反映: main fast-forwards; README.md on main has both sections and no conflict markers;
//      both children are done.
//
// Screenshots go to the OS temp dir (never the repo). Exit code 0 = pass.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { flag, git, log, makeRepo, openPage, opt, repoRoot, startStack, waitFor } from './harness.js';

const headed = flag('headed');
const keep = flag('keep');
const out = opt('out', join(tmpdir(), 'acc-e2e-conflict'));
const daemonRoot = resolve(opt('daemon-root', repoRoot));
mkdirSync(out, { recursive: true });

const plan = (text, section) =>
  [
    text,
    '',
    '```acc-mock',
    JSON.stringify({ steps: [{ type: 'append', path: 'README.md', content: `\n${section}` }], delayScale: 0 }),
    '```',
  ].join('\n');

let browser;
let stack;
let repo;
let failed = false;

try {
  repo = makeRepo();
  stack = await startStack({ daemonRoot });
  const { rpc, url } = stack;
  const methods = new Set((await rpc.call('system.info')).methods);
  for (const m of ['session.spawn', 'artifact.review', 'integration.resolveWithAgent']) {
    if (!methods.has(m)) throw new Error(`this daemon has no ${m}`);
  }

  // ------------------------------------------------------------------ data (real API)
  await rpc.call('settings.update', { defaultRuntime: 'mock' });
  const project = await rpc.call('project.create', {
    name: 'conflict-e2e',
    repoPath: repo,
    defaultBranch: 'main',
    testCommand: 'node scripts/test.js',
  });
  const lead = await rpc.call('session.create', {
    kind: 'chat',
    title: 'README の整備',
    projectId: project.id,
    model: 'mock/fast',
  });
  await rpc.call('session.delegate', { sessionId: lead.id });
  const spawn = (title, section) =>
    rpc.call('session.spawn', {
      parentSessionId: lead.id,
      title,
      goal: plan(`README.md に「${section.split('\n')[0]}」の節を足してください。`, section),
      workspace: { kind: 'worktree', projectId: project.id },
      projectId: project.id,
    });
  const first = (await spawn('使い方の節', '## 使い方\n\n`node scripts/test.js` で確認します。\n')).session;
  const second = (await spawn('テストの節', '## テスト\n\nテストの実行方法を書きます。\n')).session;
  const stateOf = async (id) =>
    (await rpc.call('session.tree', { sessionId: lead.id })).nodes.find((n) => n.id === id)?.state;
  for (const s of [first, second]) {
    await waitFor(async () => (await stateOf(s.id)) === 'review', `「${s.title}」 to wait for review`, 60_000);
  }
  const mainBefore = git(repo, 'rev-parse', 'main');
  log('two code changes wait for review');

  // ------------------------------------------------------------------ browser
  browser = await chromium.launch({ headless: !headed });
  const { page, errors, shot } = await openPage(browser, { url, out });
  const panel = page.locator('aside[data-region="panel"]');
  const bar = panel.locator('[data-review-bar]');
  const openChild = async (s) => {
    await page.keyboard.press('Control+1');
    await page.locator(`[data-session-chip="${s.id}"]`).click();
    await page.getByRole('heading', { name: s.title }).or(page.locator('h1', { hasText: s.title })).first().waitFor();
    await panel.locator('[data-output-body="code"]').waitFor({ timeout: 15_000 });
  };

  // 2. the first change: 採用 → 反映済み
  await page.locator(`[data-session-chip="${first.id}"]`).waitFor({ timeout: 30_000 });
  await openChild(first);
  await panel.locator('[data-action="adopt"]').click();
  await panel.locator('[data-review-bar][data-phase="adopted"]').waitFor({ timeout: 60_000 });
  const mainAfterFirst = git(repo, 'rev-parse', 'main');
  if (mainAfterFirst === mainBefore) throw new Error('main did not move for the first change');
  log(`first change applied: main ${mainBefore.slice(0, 7)} → ${mainAfterFirst.slice(0, 7)}`);

  // 3. the second change: 採用 → 競合, with 解消を任せる
  await openChild(second);
  await panel.getByText('README.md').first().waitFor();
  await panel.locator('[data-action="adopt"]').click();
  await panel.locator('[data-review-bar][data-phase="apply_failed"]').waitFor({ timeout: 60_000 });
  const failedText = await bar.innerText();
  if (!failedText.includes('競合')) throw new Error(`the bar says "${failedText}" on a conflict`);
  const resolveButton = panel.locator('[data-action="resolve"]');
  await resolveButton.waitFor();
  await shot('conflict-in-panel');
  if (git(repo, 'rev-parse', 'main') !== mainAfterFirst) throw new Error('main moved on a conflict');
  // Home shows it where the human looks first.
  await page.keyboard.press('Control+1');
  const failureRow = page.locator('[data-attention-row]').filter({ hasText: '競合' });
  await failureRow.waitFor({ timeout: 15_000 });
  const rowLabel = await failureRow.getAttribute('aria-label');
  if (!rowLabel?.startsWith('失敗: ')) throw new Error(`the conflict row is "${rowLabel}"`);
  await page.locator(`[data-session-chip="${second.id}"][data-state="failed"]`).waitFor({ timeout: 15_000 });
  await shot('conflict-on-home');
  log(`conflict shown: bar "${failedText.replace(/\s+/g, ' ')}", home "${rowLabel}"`);

  // 4. 解消を任せる → the resolution waits for 反映
  await openChild(second);
  await resolveButton.click();
  await panel.locator('[data-review-bar][data-phase="apply_wait"]').waitFor({ timeout: 120_000 });
  const applyButton = panel.locator('[data-action="apply"]');
  await applyButton.waitFor();
  // The conflict is gone: its failure row goes, and the agent that resolved it is named by
  // what it did (no role names).
  await failureRow.waitFor({ state: 'detached', timeout: 15_000 });
  const machine = /Integrator|Integration|Task|Worker/.exec(await page.locator('body').innerText());
  if (machine) throw new Error(`"${machine[0]}" on screen after the resolution`);
  await shot('resolved-waiting');
  if (git(repo, 'rev-parse', 'main') !== mainAfterFirst) throw new Error('main moved before 反映');
  const integ = (await rpc.call('integration.list', {})).items.find(
    (i) => i.status === 'awaiting_approval' && i.workspaceIds.includes(second.workspaceId),
  );
  if (!integ) throw new Error('no resolved integration waits for 反映');
  if (!integ.steps.some((s) => s.kind === 'fix' && s.status === 'succeeded')) throw new Error('no resolution step');
  const asked = (
    await rpc.call('approval.list', {
      status: ['pending', 'approved', 'rejected', 'expired', 'cancelled'],
      projectId: project.id,
    })
  ).items;
  if (asked.length > 0) throw new Error(`approvals on the way: ${asked.map((a) => a.title).join(', ')}`);

  // 5. 反映 → main has both sections
  await applyButton.click();
  await panel.locator('[data-review-bar][data-phase="adopted"]').waitFor({ timeout: 60_000 });
  const readme = git(repo, 'show', 'main:README.md');
  if (!readme.includes('## 使い方') || !readme.includes('## テスト') || /^(<{7}|={7}|>{7})/m.test(readme))
    throw new Error(`README.md on main was not resolved:\n${readme}`);
  for (const s of [first, second]) {
    await waitFor(async () => (await stateOf(s.id)) === 'done', `「${s.title}」 to be done`, 30_000);
  }
  await shot('applied');
  log('resolved by an agent and applied by the human: README.md has both sections');

  if (errors.length) throw new Error(`page errors:\n  ${errors.join('\n  ')}`);
  log('PASS');
} catch (err) {
  failed = true;
  console.error(err);
  try {
    const items = (await stack.rpc.call('integration.list', {})).items;
    log(`integrations: ${JSON.stringify(items.map((i) => [i.status, i.error?.message, i.steps.map((s) => `${s.kind}:${s.status}`)]))}`);
  } catch {
    /* the daemon is gone */
  }
} finally {
  await browser?.close().catch(() => {});
  if (repo) {
    try {
      git(repo, 'worktree', 'prune');
    } catch {
      /* the repo may already be gone */
    }
  }
  await stack?.stop({ keep, extraDirs: repo ? [repo] : [] });
  process.exit(failed ? 1 : 0);
}
