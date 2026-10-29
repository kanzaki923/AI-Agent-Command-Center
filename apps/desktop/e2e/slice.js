// End-to-end check of the human side of the Vertical Slice against a REAL Core Daemon.
//
//   pnpm --filter @acc/desktop e2e:slice [-- --headed] [--keep] [--out <dir>] [--timeout-ms 240000]
//                                        [--daemon-root <checkout with the daemon to run>]
//
// What it does (no paid LLM calls: mock models and the mock agent runtime only):
//   1. Starts the daemon (`packages/daemon/src/main.ts` via tsx) and the Vite dev server on
//      free ports with a fresh temporary ACC_HOME (e2e/harness.js).
//   2. In Chromium (Playwright, 1440x900): onboarding → 「デモモードで試す」 → lands in the
//      demo design chat holding the orchestrator grant (chip + chat line) with the suggested
//      first message → sends it with one click → the reply streams in.
//   3. Zero approvals (the default おまかせ profile): the orchestrator splits the goal, two
//      mock workers run in parallel (the test worker's `git push` is blocked by the daemon's
//      hard rules and it carries on), the integration merges and tests — and nothing asks a
//      human until the integration waits for 承認して反映. Fails if any approval appears.
//      On the way: the worker's chat shows the block (ブロック + reason + ルール), the
//      Focus header's decision chip and its popover, and the Timeline's decision rows.
//   4. The human applies the integration (confirmation wording checked) and the target branch
//      really moves (git, not just the UI).
//   5. Careful profile + remember: a project in 慎重 asks before a worker's test command;
//      Ctrl+J lands on the card, A opens the scope choice, 3 approves for the project. The
//      same command later in the run runs without asking (記憶した許可), the rule is listed in
//      the project settings and can be taken back there.
//
// Screenshots of every step go to the OS temp dir (never the repo). Exit code 0 = pass.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { flag, git, log, makeRepo, opt, repoRoot, startStack, waitFor } from './harness.js';

const headed = flag('headed');
const keep = flag('keep');
const out = opt('out', join(tmpdir(), 'acc-e2e-slice'));
const sliceTimeout = Number(opt('timeout-ms', '240000'));
// Run the daemon from another checkout (e.g. a branch with newer daemon modules) against
// this UI. Default: this repository.
const daemonRoot = resolve(opt('daemon-root', repoRoot));
mkdirSync(out, { recursive: true });

/** A careful-profile worker: the test command asks once, then is remembered. */
const CAREFUL_PLAN = [
  'ドキュメントを書いて、テストで確かめます。',
  '',
  '```acc-mock',
  JSON.stringify({
    steps: [
      { type: 'write', path: 'docs/careful.md', content: '# 慎重\n\nWorker が書きました。\n' },
      { type: 'run', command: 'node', args: ['scripts/test.js'], title: 'テストを実行する' },
      { type: 'say', text: '念のためもう一度確かめます。' },
      { type: 'run', command: 'node', args: ['scripts/test.js'], title: 'テストをもう一度実行する' },
    ],
    summary: 'docs/careful.md を追加し、テストが通ることを確認しました',
    delayScale: 0.2,
  }),
  '```',
].join('\n');

const ALL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'cancelled'];

let browser;
let stack;
let repo;
let failed = false;

try {
  repo = makeRepo();
  stack = await startStack({ daemonRoot });
  const { rpc, url } = stack;
  const sysInfo = await rpc.call('system.info');
  const methods = new Set(sysInfo.methods);
  if (!methods.has('task.spawnWorker')) throw new Error('this daemon cannot start workers (task.spawnWorker)');
  if (!methods.has('permissionRule.list')) throw new Error('this daemon has no permission rules (permissionRule.list)');
  log(`daemon ${sysInfo.version}: ${sysInfo.methods.length} methods`);

  // ------------------------------------------------------------------ browser
  browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
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
  const openFromPalette = async (text, option) => {
    await page.keyboard.press('Control+k');
    await page.keyboard.type(text);
    await page.getByRole('option', { name: option }).first().click();
  };

  // 1. onboarding → demo
  await page.goto(url);
  await page.getByText('AI エージェントのチームを始めましょう').waitFor({ timeout: 30_000 });
  await shot('onboarding');
  await page.getByRole('button', { name: /デモモードで試す/ }).click();
  log('demo chosen');

  // 2. landed in the design chat as an orchestrator
  const chip = page.getByTestId('grant-chip');
  await chip.waitFor({ timeout: 20_000 });
  await page.getByTestId('grant-line-given').waitFor();
  const chipText = await chip.innerText();
  if (!/Orchestrator/.test(chipText)) throw new Error(`grant chip says "${chipText}"`);
  const suggestion = page.getByTestId('suggestion-chip');
  await suggestion.waitFor();
  log(`grant chip "${chipText.replace(/\s+/g, ' ')}"`);
  await shot('demo-chat-granted');

  const sessions = (await rpc.call('session.list', {})).items;
  const design = sessions.find((s) => s.kind === 'chat');
  const grants = (await rpc.call('grant.list', { sessionId: design.id })).items;
  if (grants.length === 0) throw new Error('no grant on the demo chat in the daemon');
  const demoProject = await rpc.call('project.get', { projectId: design.projectId });
  const settings = await rpc.call('settings.get');
  const profile = demoProject.permissionProfile ?? settings.defaultPermissionProfile;
  if (profile !== 'autonomous') throw new Error(`the demo project runs in ${profile}, expected autonomous`);
  log(`demo project ${demoProject.name}: profile ${profile}`);

  // 3. send the suggested message → the orchestrator works; nothing may ask a human
  await suggestion.click();
  await page.locator('.md').first().waitFor({ timeout: 60_000 });
  await shot('demo-message-streaming');

  log('driving the orchestrator slice; it must not ask anything before the final apply');
  const end = Date.now() + sliceTimeout;
  let integrationId;
  let blockShown = false;
  while (Date.now() < end && !integrationId) {
    const asked = (await rpc.call('approval.list', { status: ALL_STATUSES, projectId: demoProject.id })).items;
    if (asked.length > 0) {
      await shot('unexpected-approval');
      throw new Error(`the autonomous profile asked a human: ${asked.map((a) => a.title).join(', ')}`);
    }
    // The test worker's push is blocked by the hard rules: show it where the human would look.
    if (!blockShown) {
      const decided = (await rpc.call('events.list', { types: ['tool.decided'], limit: 200 })).events;
      const block = decided.find((e) => e.payload.decision === 'denied' && /push/.test(e.payload.summary ?? ''));
      if (block?.sessionId) {
        blockShown = true;
        const worker = await rpc.call('session.get', { sessionId: block.sessionId });
        log(`blocked: ${block.payload.summary} (${block.payload.decidedBy}: ${block.payload.reason})`);
        await openFromPalette(worker.title, new RegExp(worker.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        // The blocked call is its own line, or folded into "ツール実行 N 件 … ブロック 1".
        const line = page.getByTestId('blocked-chip').first();
        const group = page.getByRole('button', { name: /ツール実行 \d+ 件.*ブロック 1/ }).first();
        await line.or(group).first().waitFor({ timeout: 15_000 });
        if (!(await line.isVisible().catch(() => false))) await group.click();
        await line.waitFor();
        await page.waitForTimeout(300);
        await shot('worker-blocked-push');
        const decisions = page.getByTestId('decisions-chip');
        await decisions.waitFor({ timeout: 10_000 });
        const chipLabel = await decisions.innerText();
        if (!/自動判断 \d+ 件/.test(chipLabel)) throw new Error(`decision chip says "${chipLabel}"`);
        await decisions.click();
        await page.getByTestId('decisions-popover').waitFor();
        await shot('worker-decisions-popover');
        log(`decision chip "${chipLabel}"`);
        // "タイムラインで見る": this run's permission decisions, the block with who decided.
        await page.getByRole('button', { name: 'タイムラインで見る' }).click();
        await page.getByTestId('decider-badge').first().waitFor({ timeout: 15_000 });
        await shot('timeline-run-decisions');
        await page.getByRole('button', { name: 'クリア' }).click();
      }
    }
    const integ = (await rpc.call('integration.list', {})).items.find((i) => i.status === 'awaiting_approval');
    if (integ) integrationId = integ.id;
    else await page.waitForTimeout(1000);
  }
  if (!integrationId) throw new Error('the orchestrator did not produce an integration candidate in time');
  if (!blockShown) throw new Error('the test worker\'s push was never blocked');

  await page.keyboard.press('Control+1');
  await page.getByTestId('task-tree').waitFor();
  await shot('orchestrator-task-tree');
  const beforeApply = (await rpc.call('approval.list', { status: ALL_STATUSES, projectId: demoProject.id })).items;
  if (beforeApply.length > 0) throw new Error(`approvals before the apply: ${beforeApply.map((a) => a.title).join(', ')}`);
  log('zero approvals from the goal to the integration candidate');

  // 4. review: steps, tests, diff; apply with the exact confirmation; the branch really moves
  await page
    .getByRole('button', { name: /統合: 反映待ち|レビューを開始/ })
    .first()
    .click();
  await page.getByTestId('integration-view').waitFor();
  await page.getByTestId('approve-integration').waitFor({ timeout: 30_000 });
  await page.getByTestId('integration-tests').waitFor({ timeout: 30_000 });
  await shot('integration-review');
  const pendingInteg = await rpc.call('integration.get', { integrationId });
  const targetRepo = (await rpc.call('project.get', { projectId: pendingInteg.projectId })).repoPath;
  const targetRef = pendingInteg.targetRef ?? 'main';
  const before = git(targetRepo, 'rev-parse', targetRef);
  await page.getByTestId('approve-integration').click();
  const dialog = page.getByTestId('apply-dialog');
  await dialog.waitFor();
  const wording = await dialog.innerText();
  if (!/早送り（fast-forward）/.test(wording) || !wording.includes(targetRef))
    throw new Error(`confirmation does not say what happens: ${wording}`);
  await shot('integration-confirm');
  await page.getByRole('button', { name: '反映する' }).click();
  await page
    .getByText(/に反映しました/)
    .first()
    .waitFor({ timeout: 30_000 });
  const integ = await waitFor(
    async () => {
      const i = await rpc.call('integration.get', { integrationId });
      return i.status !== 'awaiting_approval' ? i : null;
    },
    'the daemon to apply the integration',
    30_000,
  );
  const after = git(targetRepo, 'rev-parse', targetRef);
  if (integ.status !== 'applied' || before === after || after !== integ.headSha) {
    throw new Error(
      `integration not applied (status ${integ.status}, ${targetRef} ${before} → ${after}, head ${integ.headSha})`,
    );
  }
  log(`applied: ${targetRef} ${before.slice(0, 7)} → ${after.slice(0, 7)} (the only human decision)`);
  await shot('integration-applied');
  await page.keyboard.press('Escape');

  // 5. careful profile: one approval, remembered for the project
  const careful = await rpc.call('project.create', {
    name: 'careful-e2e',
    repoPath: repo,
    defaultBranch: 'main',
    testCommand: 'node scripts/test.js',
    permissionProfile: 'careful',
  });
  const task = await rpc.call('task.create', { projectId: careful.id, title: '慎重にドキュメントを書く' });
  const ws = await rpc.call('workspace.create', { projectId: careful.id, taskId: task.id, label: 'careful-worker' });
  const worker = await rpc.call('session.create', {
    kind: 'agent',
    projectId: careful.id,
    workspaceId: ws.id,
    taskId: task.id,
    title: '慎重な Worker',
    runtime: 'mock',
  });
  // The board follows the selected project: switch to the careful one.
  await page.keyboard.press('Control+1');
  await openFromPalette('careful-e2e', /careful-e2e に切り替え/);
  await rpc.call('session.send', { sessionId: worker.id, content: CAREFUL_PLAN });
  const ask = await waitFor(
    async () => (await rpc.call('approval.list', { status: ['pending'], sessionId: worker.id })).items[0],
    'the careful worker to ask',
    30_000,
  );
  log(`careful profile asked: ${ask.title} (${ask.payload?.reason ?? 'no reason'})`);
  await page.getByRole('heading', { name: '司令室' }).waitFor();
  await page.keyboard.press('Control+j');
  const card = page.getByRole('option', { name: /慎重な Worker · 承認待ち/ });
  await card.waitFor();
  await page.getByTestId('approve-always').first().waitFor();
  await shot('careful-approval-card');
  await page.keyboard.press('a');
  await page.getByTestId('remember-chooser').waitFor();
  await page.waitForTimeout(250); // the buttons cross-fade (120ms)
  await shot('careful-remember-chooser');
  await page.keyboard.press('3');
  const rule = await waitFor(
    async () => (await rpc.call('permissionRule.list', { projectId: careful.id })).items[0],
    'the approval to be remembered',
    15_000,
  );
  if (rule.scope !== 'project') throw new Error(`remembered for ${rule.scope}, expected project`);
  log(`remembered: ${rule.description} (${rule.scope})`);
  await waitFor(
    async () => {
      const r = (await rpc.call('run.list', { sessionId: worker.id })).items[0];
      return r && r.status === 'completed' ? r : null;
    },
    'the careful worker to finish',
    60_000,
  );
  const workerApprovals = (await rpc.call('approval.list', { status: ALL_STATUSES, sessionId: worker.id })).items;
  if (workerApprovals.length !== 1)
    throw new Error(`the remembered command asked again (${workerApprovals.length} approvals)`);
  const remembered = (await rpc.call('events.list', { sessionId: worker.id, types: ['tool.decided'] })).events.find(
    (e) => e.payload.decidedBy === 'remembered',
  );
  if (!remembered) throw new Error('the second test run was not allowed by the remembered approval');
  log('the second test run was allowed by the remembered approval (no second ask)');

  await openFromPalette('慎重な Worker', /慎重な Worker/);
  await page.getByTestId('remembered-scope').first().waitFor({ timeout: 15_000 });
  const note = page.getByTestId('decision-note').filter({ hasText: '記憶した許可' }).first();
  const folded = page.getByRole('button', { name: /ツール実行 \d+ 件/ }).last();
  await note.or(folded).first().waitFor({ timeout: 10_000 });
  if (!(await note.isVisible().catch(() => false))) await folded.click();
  await note.waitFor({ timeout: 10_000 });
  await shot('careful-worker-remembered');

  // The project settings list the rule; taking it back works from there.
  await openFromPalette('プロジェクトの設定', /プロジェクトの設定（権限・記憶した許可）/);
  const rules = page.getByTestId('remembered-rules');
  await rules.waitFor({ timeout: 10_000 });
  await rules.scrollIntoViewIfNeeded();
  await shot('project-settings-permissions');
  await rules.getByRole('button', { name: /取り消す/ }).first().click();
  await waitFor(
    async () => (await rpc.call('permissionRule.list', { projectId: careful.id })).items.length === 0,
    'the rule to be revoked',
    10_000,
  );
  await page.getByTestId('no-remembered-rules').waitFor();
  log('the remembered approval was taken back from the project settings');
  await page.keyboard.press('Escape');

  // The global default and auto mode live in the settings.
  await page.keyboard.press('Control+,');
  const defaults = page.getByRole('radiogroup', { name: '既定のプロファイル' });
  await defaults.waitFor({ timeout: 10_000 });
  await defaults.scrollIntoViewIfNeeded();
  await shot('settings-agent-permissions');
  await page.keyboard.press('Escape');

  // Timeline: the 表示 menu adds routine automatic allows without the plumbing.
  await page.keyboard.press('Control+3');
  await page.getByTestId('timeline-view-menu').click();
  await page.getByTestId('show-auto-allowed').click();
  await page.keyboard.press('Escape');
  const runHeader = page.getByRole('button', { name: /Run #.*慎重な Worker/ }).last();
  await runHeader.waitFor({ timeout: 10_000 });
  if (!(await page.getByText('記憶した許可').first().isVisible().catch(() => false))) await runHeader.click();
  await page.getByText('記憶した許可').first().waitFor({ timeout: 10_000 });
  await shot('timeline-auto-allowed');

  if (pageErrors.length) {
    log(`page errors:\n  ${pageErrors.join('\n  ')}`);
    throw new Error('the page reported errors');
  }
  log('PASS (zero-approval slice; careful approval remembered and revoked)');
} catch (err) {
  failed = true;
  console.error(err);
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
