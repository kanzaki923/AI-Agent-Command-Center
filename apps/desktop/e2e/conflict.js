// End-to-end check of "Integrator に解消を任せる" against a REAL Core Daemon (no paid LLM
// calls: the mock agent runtime resolves conflicts by keeping both sides).
//
//   pnpm --filter @acc/desktop e2e:conflict [-- --headed] [--keep] [--out <dir>] [--daemon-root <checkout>]
//
//   1. A temporary git repository becomes a project; two tasks each get a worktree whose
//      commit appends a different section to README.md (as the demo orchestrator does when
//      the goal mentions README), and are put in review.
//   2. integration.create + integration.run for both: the second merge conflicts on README.md.
//   3. In the UI (palette → 統合をレビュー): the review shows the conflict and the primary
//      action "Integrator に解消を任せる"; the confirmation says the target is not touched;
//      confirming starts the integrator (integration.resolveWithAgent).
//   4. The fix step runs live; the integration resumes and lands in 反映待ち with the fix step
//      done; README.md on the integration branch has both sections and no markers; main is
//      unchanged until a human approves.
//
// Screenshots go to the OS temp dir (never the repo). Exit code 0 = pass.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { flag, git, log, makeRepo, opt, repoRoot, startStack, waitFor } from './harness.js';

const headed = flag('headed');
const keep = flag('keep');
const out = opt('out', join(tmpdir(), 'acc-e2e-conflict'));
const daemonRoot = resolve(opt('daemon-root', repoRoot));
mkdirSync(out, { recursive: true });

let browser;
let stack;
let repo;
let failed = false;

try {
  repo = makeRepo();
  stack = await startStack({ daemonRoot });
  const { rpc, url } = stack;
  const methods = new Set((await rpc.call('system.info')).methods);
  if (!methods.has('integration.resolveWithAgent'))
    throw new Error('this daemon cannot hand conflicts to an integrator (integration.resolveWithAgent)');

  // ------------------------------------------------------------------ data (real API)
  const project = await rpc.call('project.create', {
    name: 'conflict-e2e',
    repoPath: repo,
    defaultBranch: 'main',
    testCommand: 'node scripts/test.js',
  });
  await rpc.call('workspace.create', { projectId: project.id, kind: 'main' });
  const work = async (title, section) => {
    const t = await rpc.call('task.create', { projectId: project.id, title });
    const ws = await rpc.call('workspace.create', { projectId: project.id, taskId: t.id, label: title });
    const readme = join(ws.path, 'README.md');
    writeFileSync(readme, `${readFileSync(readme, 'utf8')}\n${section}`);
    git(ws.path, 'add', '-A');
    git(ws.path, '-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '-q', '-m', title);
    await rpc.call('task.update', { taskId: t.id, status: 'review' });
    return t;
  };
  const docs = await work('ドキュメントを書く', '## 使い方\n\n`node scripts/test.js` で確認します。\n');
  const tests = await work('テストを足す', '## テスト\n\nテストの実行方法を書きます。\n');
  const created = await rpc.call('integration.create', {
    projectId: project.id,
    taskIds: [docs.id, tests.id],
    title: '統合: README の 2 つの節',
  });
  await rpc.call('integration.run', { integrationId: created.id });
  const conflicted = (await rpc.call('integration.wait', { integrationId: created.id, timeoutMs: 60_000 }))
    .integration;
  if (conflicted.status !== 'conflict') throw new Error(`expected a conflict, got ${conflicted.status}`);
  const files = conflicted.steps.flatMap((s) => s.conflictFiles);
  log(`integration ${conflicted.id} in conflict on ${files.join(', ')}`);
  const mainBefore = git(repo, 'rev-parse', 'main');

  // ------------------------------------------------------------------ browser
  browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    localStorage.setItem('acc.ui', JSON.stringify({ state: { onboardingDone: true }, version: 1 }));
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

  await page.goto(url);
  await page.getByRole('heading', { name: '司令室' }).waitFor({ timeout: 30_000 });

  // 3. open the review from the palette
  await page.keyboard.press('Control+k');
  await page.keyboard.type('README の 2 つの節');
  await page.getByText('統合をレビュー: README の 2 つの節').first().click();
  const view = page.getByTestId('integration-view');
  await view.waitFor();
  await view.getByText('README.md').first().waitFor({ timeout: 15_000 });
  const resolveButton = page.getByTestId('resolve-with-agent');
  await resolveButton.waitFor();
  await shot('conflict-review');
  log('review shows the conflict and offers the Integrator');

  await resolveButton.click();
  const dialog = page.getByTestId('resolve-dialog');
  await dialog.waitFor();
  const wording = await dialog.innerText();
  if (!wording.includes('README.md') || !/main はまだ変更しません/.test(wording))
    throw new Error(`confirmation does not say what happens: ${wording}`);
  await dialog.getByLabel('Integrator への補足').fill('両方の節を残してください');
  await shot('resolve-confirm');
  await dialog.getByRole('button', { name: /Integrator に任せる/ }).click();

  // 4. live progress, then the result
  const started = await waitFor(
    async () => {
      const i = await rpc.call('integration.get', { integrationId: created.id });
      return i.resolverRunId ? i : null;
    },
    'the integrator run to start',
    30_000,
  );
  log(`integrator run ${started.resolverRunId}`);
  await page.locator('[data-step="fix"]').first().waitFor({ timeout: 15_000 });
  if (await page.getByTestId('resolving').isVisible().catch(() => false)) await shot('resolving');

  const settled = (await rpc.call('integration.wait', { integrationId: created.id, timeoutMs: 120_000 }))
    .integration;
  if (settled.status !== 'awaiting_approval')
    throw new Error(`integration ended in ${settled.status}: ${settled.error?.message ?? ''}`);
  await page.getByTestId('approve-integration').waitFor({ timeout: 30_000 });
  await page.locator('[data-step="fix"][data-status="succeeded"]').waitFor({ timeout: 15_000 });
  await page.getByTestId('integration-tests').waitFor({ timeout: 30_000 });
  await shot('resolved-awaiting-approval');

  // The resolution is real: both sections, no markers, and the target has not moved.
  const ws = await rpc.call('workspace.get', { workspaceId: settled.workspaceId });
  const merged = readFileSync(join(ws.path, 'README.md'), 'utf8');
  if (!merged.includes('## 使い方') || !merged.includes('## テスト') || /^(<{7}|={7}|>{7})/m.test(merged))
    throw new Error(`README.md was not resolved:\n${merged}`);
  if (git(repo, 'rev-parse', 'main') !== mainBefore) throw new Error('main moved without approval');
  const integrator = (await rpc.call('run.get', { runId: settled.resolverRunId })).sessionId;
  const message = (await rpc.call('session.messages', { sessionId: integrator, limit: 50 })).items;
  if (!JSON.stringify(message).includes('両方の節を残してください'))
    throw new Error('the guidance did not reach the integrator');
  log('resolved by the integrator: both sections kept, tests ran, main unchanged');

  if (pageErrors.length) throw new Error(`page errors:\n${pageErrors.join('\n')}`);
  log('PASS');
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
  process.exitCode = failed ? 1 : 0;
}
