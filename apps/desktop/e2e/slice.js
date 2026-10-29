// End-to-end check of the human side of the vertical slice against a REAL Core Daemon.
//
//   pnpm --filter @acc/desktop e2e:slice [-- --headed] [--keep] [--out <dir>]
//                                        [--daemon-root <checkout with the daemon to run>]
//
// No paid LLM calls: the conversation runs on the daemon's built-in mock supervisor
// (`mock/orchestrator`), its children on the mock agent runtime.
//   1. A temporary git repository becomes a project in the careful profile (a child's test
//      command asks first). The home is empty: only 何を頼みますか.
//   2. On the home composer: code as the workspace, 任せる on, the request, Enter. The
//      conversation is created delegated in that project and stays on home (no navigation).
//   3. The mock supervisor spawns three children (session.spawn); the code one works in a
//      worktree. Their chips appear in the conversation's lane.
//   4. The code child's test command waits for a human: an approval row on home (with the
//      count in the title bar). J selects it, Y allows it — no mouse, no chat opened.
//   5. The code child reaches review (its chip says so). Opening it shows the outputs panel
//      with the diff; 採用 applies the change (反映): the target branch really moves (git, not
//      just the UI) and the child is done.
//
// Screenshots of every step go to the OS temp dir (never the repo). Exit code 0 = pass.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { flag, git, log, makeRepo, openPage, opt, repoRoot, startStack, waitFor } from './harness.js';

const headed = flag('headed');
const keep = flag('keep');
const out = opt('out', join(tmpdir(), 'acc-e2e-slice'));
const daemonRoot = resolve(opt('daemon-root', repoRoot));
mkdirSync(out, { recursive: true });

const GOAL = 'ログイン画面のエラーメッセージを直して';

let browser;
let stack;
let repo;
let failed = false;

try {
  repo = makeRepo();
  stack = await startStack({ daemonRoot });
  const { rpc, url } = stack;
  const methods = new Set((await rpc.call('system.info')).methods);
  for (const m of ['session.spawn', 'session.delegate', 'home.get', 'attention.respond', 'artifact.review']) {
    if (!methods.has(m)) throw new Error(`this daemon has no ${m}`);
  }

  // ------------------------------------------------------------------ data (real API)
  // Offline: the built-in mock supervisor answers conversations, the mock runtime runs agents.
  await rpc.call('settings.update', { defaultRuntime: 'mock', defaultModel: 'mock/orchestrator' });
  const project = await rpc.call('project.create', {
    name: 'slice-e2e',
    repoPath: repo,
    defaultBranch: 'main',
    testCommand: 'node scripts/test.js',
    permissionProfile: 'careful',
  });
  const mainBefore = git(repo, 'rev-parse', 'main');

  // ------------------------------------------------------------------ browser
  browser = await chromium.launch({ headless: !headed });
  const { page, errors, shot } = await openPage(browser, { url, out });

  // 1. the empty home: the request field alone
  const field = page.getByRole('textbox', { name: '何を頼みますか' });
  await field.waitFor({ timeout: 30_000 });
  if ((await page.locator('[data-lane]').count()) > 0) throw new Error('the home is not empty');
  await shot('home-empty');

  // 2. code + 任せる + the request, Enter (stays on home)
  await page.locator('[data-workspace="worktree"]').click();
  await page.locator('[data-workspace="worktree"][aria-checked="true"]').waitFor();
  const toggle = page.locator('[data-delegate-toggle]');
  await toggle.click();
  await page.locator('[data-delegate-toggle][aria-pressed="true"]').waitFor();
  await field.fill(GOAL);
  await shot('home-request-delegated');
  await field.press('Enter');

  const lead = await waitFor(
    async () => (await rpc.call('session.list', {})).items.find((s) => s.kind === 'chat' && s.parentId == null),
    'the conversation to be created',
  );
  if (lead.projectId !== project.id) throw new Error(`the conversation is in ${lead.projectId}, not the code project`);
  // create → delegate → send: the grant lands right after the session.
  await waitFor(
    async () =>
      (await rpc.call('grant.list', { sessionId: lead.id })).items.some((g) => g.permissions.includes('session.spawn')),
    'the conversation to be delegated (a session.spawn grant)',
  );
  const lane = page.locator(`[data-lane="${lead.id}"]`);
  await lane.waitFor({ timeout: 15_000 });
  // The lane is named by what was asked (not 「新しい会話」).
  const laneTitle = (await lane.locator(`[data-lane-root="${lead.id}"]`).innerText()).trim();
  if (laneTitle !== GOAL) throw new Error(`the lane is titled "${laneTitle}"`);
  log(`delegated conversation ${lead.id} in ${project.name}`);

  // 3. three children, one of them on the code (a worktree)
  const children = await waitFor(
    async () => {
      const nodes = (await rpc.call('session.tree', { sessionId: lead.id })).nodes.filter((n) => n.depth > 0);
      return nodes.length >= 3 ? nodes : null;
    },
    'the supervisor to spawn its children',
    60_000,
  );
  const sessions = await Promise.all(children.map((c) => rpc.call('session.get', { sessionId: c.id })));
  const kinds = await Promise.all(
    sessions.map(async (s) =>
      s.workspaceId ? (await rpc.call('workspace.get', { workspaceId: s.workspaceId })).kind : 'none',
    ),
  );
  if (kinds.filter((k) => k === 'worktree').length !== 1)
    throw new Error(`expected one child on the code, got workspaces ${kinds.join(', ')}`);
  const codeChild = sessions[kinds.indexOf('worktree')];
  await waitFor(async () => (await lane.locator('[data-session-chip]').count()) >= 3, 'three chips in the lane', 15_000);
  log(`children: ${children.map((c) => c.title).join(' / ')}; code: ${codeChild.title}`);

  // 4. the approval row on home, answered with J then Y
  const row = page.locator('[data-attention-row]').filter({ hasText: 'node --test' });
  await row.waitFor({ timeout: 60_000 });
  const label = await row.getAttribute('aria-label');
  if (!label?.startsWith('確認: ')) throw new Error(`the row is not an approval: ${label}`);
  const count = await page.getByTestId('attention-count').innerText();
  if (count.trim() !== '1') throw new Error(`the title bar counts ${count} attention items`);
  const codeChip = page.locator(`[data-session-chip="${codeChild.id}"]`);
  await page.locator(`[data-session-chip="${codeChild.id}"][data-state="needs_you"]`).waitFor({ timeout: 15_000 });
  await shot('home-approval');
  const approval = await waitFor(
    async () => (await rpc.call('approval.list', { status: ['pending'], sessionId: codeChild.id })).items[0],
    'the pending approval',
  );
  await page.keyboard.press('j');
  await page.locator('[data-attention-row][data-selected]').filter({ hasText: 'node --test' }).waitFor();
  await shot('home-approval-selected');
  await page.keyboard.press('y');
  await row.waitFor({ state: 'detached', timeout: 15_000 });
  const answered = await waitFor(
    async () => {
      const a = (
        await rpc.call('approval.list', {
          status: ['pending', 'approved', 'rejected', 'expired', 'cancelled'],
          sessionId: codeChild.id,
        })
      ).items.find((x) => x.id === approval.id);
      return a && a.status !== 'pending' ? a : null;
    },
    'the approval to be answered',
  );
  if (answered.status !== 'approved') throw new Error(`Y answered the approval with ${answered.status}`);
  log('approved from home with the keyboard (J, Y)');

  // 5. review → open the child → the diff in the outputs panel → 採用 → 反映
  await page.locator(`[data-session-chip="${codeChild.id}"][data-state="review"]`).waitFor({ timeout: 60_000 });
  await shot('home-code-review');
  await codeChip.click();
  const panel = page.locator('aside[data-region="panel"]');
  await panel.waitFor({ timeout: 15_000 });
  await panel.locator('[data-output-body="code"]').waitFor({ timeout: 15_000 });
  await panel.getByText('docs/notes.md').first().waitFor({ timeout: 15_000 });
  await shot('child-outputs-diff');
  await panel.locator('[data-action="adopt"]').click();
  await panel.locator('[data-review-bar][data-phase="adopted"]').waitFor({ timeout: 60_000 });
  const adopted = await panel.locator('[data-review-bar]').innerText();
  if (!adopted.includes('反映済み')) throw new Error(`the bar says "${adopted}" after the change was applied`);
  const mainAfter = git(repo, 'rev-parse', 'main');
  if (mainAfter === mainBefore) throw new Error('main did not move');
  const notes = git(repo, 'show', 'main:docs/notes.md');
  if (!notes.includes(GOAL)) throw new Error(`docs/notes.md on main: ${notes}`);
  await waitFor(
    async () =>
      (await rpc.call('session.tree', { sessionId: lead.id })).nodes.find((n) => n.id === codeChild.id)?.state === 'done',
    'the code child to be done',
    30_000,
  );
  await shot('child-applied');
  log(`applied: main ${mainBefore.slice(0, 7)} → ${mainAfter.slice(0, 7)}; the code child is done`);

  // Back on home: the chip says done.
  await page.keyboard.press('Control+1');
  await page.locator(`[data-session-chip="${codeChild.id}"][data-state="done"]`).waitFor({ timeout: 15_000 });
  await shot('home-after');

  if (errors.length) throw new Error(`page errors:\n  ${errors.join('\n  ')}`);
  log('PASS (request with 任せる → children → approval by keyboard → review → 採用 → 反映)');
} catch (err) {
  failed = true;
  console.error(err);
  // What the daemon saw, to tell a UI miss from a daemon one.
  try {
    const home = await stack.rpc.call('home.get', {});
    log(`attention: ${JSON.stringify(home.attention.map((a) => [a.kind, a.title]))}`);
    for (const t of home.trees) log(`tree ${t.root.title}: ${t.nodes.map((n) => `${n.state} ${n.now ?? ''}`).join(' / ')}`);
    const approvals = await stack.rpc.call('approval.list', { status: ['pending', 'approved', 'rejected', 'expired', 'cancelled'] });
    log(`approvals: ${JSON.stringify(approvals.items.map((a) => [a.status, a.title]))}`);
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
