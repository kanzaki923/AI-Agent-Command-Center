/**
 * T3 acceptance (spec 20261029 §5.5) for code: finalize in a git worktree (published + the
 * worktree diff, the mock's `publish` step), accepting a child's code change (integrate →
 * test → apply → task done, budget back; a failed test → attention failure → redo), and a
 * supervisor's integration of several children (attention review → human approves → done).
 */
import type {
  AgentActor,
  Integration,
  Project,
  Run,
  Session,
  Task,
  Workspace,
} from '@acc/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OpenAttentionInput } from '../contracts';
import { ApiError } from '../core/errors';
import { MockAgentRuntime } from '../runtime/mock/runtime';
import { HUMAN, SYSTEM, type TestDaemonNoServer, agentActor, createTestDaemon } from '../testing';
import { type TempRepo, createTempRepo, isolateGitConfig } from '../workspace/git-fixture';
import { onIntegrationUpdated } from './review';

// Real git, worktrees and test commands; Windows is slow under parallel load.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const PASS = 'node -e "process.exit(0)"';
const FAIL = `node -e "console.log('boom-output'); process.exit(3)"`;

let restoreGit: () => void;
beforeAll(() => {
  restoreGit = isolateGitConfig();
});
afterAll(() => restoreGit());

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'ok',
    (e: unknown) => (e instanceof ApiError ? e.code : String(e)),
  );
}

interface Setup {
  d: TestDaemonNoServer;
  repo: TempRepo;
  project: Project;
  supervisor: Session;
  /** The supervisor as an agent holding "*" on its own session tree. */
  agent: AgentActor;
  opened: OpenAttentionInput[];
  resolved: Record<string, unknown>[];
}

async function setup(testCommand = PASS): Promise<Setup> {
  const repo = await createTempRepo({ 'a.txt': 'a\n' });
  cleanups.push(() => repo.cleanup());
  const d = await createTestDaemon();
  cleanups.push(() => d.cleanup());
  const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
  vi.spyOn(d.ctx.service('runtimes').get('mock'), 'run').mockImplementation((input) =>
    fast.run(input),
  );
  // Attention is another track's: record what this one asks of it.
  const opened: OpenAttentionInput[] = [];
  const resolved: Record<string, unknown>[] = [];
  const attention = d.ctx.service('attention');
  vi.spyOn(attention, 'open').mockImplementation((input) => {
    opened.push(input);
    return null;
  });
  vi.spyOn(attention, 'resolveWhere').mockImplementation((refs) => {
    resolved.push(refs);
    return [];
  });
  const project = await d.call(HUMAN, 'project.create', {
    name: 'site',
    repoPath: repo.path,
    defaultBranch: 'main',
    testCommand,
  });
  const supervisor = await d.call(HUMAN, 'session.create', {
    projectId: project.id,
    title: 'サイト改修',
  });
  d.ctx.service('policy').createGrant(
    {
      subject: { kind: 'session', sessionId: supervisor.id },
      permissions: ['*'],
      lifetime: 'session',
    },
    HUMAN,
  );
  const agent = agentActor(supervisor.id, d.ctx.ids.next('run'));
  return { d, repo, project, supervisor, agent, opened, resolved };
}

interface Child {
  task: Task;
  ws: Workspace;
  session: Session;
  run: Run;
}

function plan(steps: unknown[]): string {
  return ['作業してください', '```acc-mock', JSON.stringify({ steps }), '```'].join('\n');
}

/** A child agent of the supervisor on its own worktree, run once to the end, in review. */
async function child(
  s: Setup,
  title: string,
  steps: unknown[],
  opts: { publish?: boolean } = {},
): Promise<Child> {
  const { d } = s;
  const task = await d.call(HUMAN, 'task.create', { projectId: s.project.id, title });
  const ws = await d.call(HUMAN, 'workspace.create', { projectId: s.project.id, taskId: task.id });
  const session = await d.call(HUMAN, 'session.create', {
    projectId: s.project.id,
    kind: 'agent',
    runtime: 'mock',
    title,
    workspaceId: ws.id,
    taskId: task.id,
    parentSessionId: s.supervisor.id,
  });
  if (opts.publish) {
    d.ctx.service('policy').createGrant(
      {
        subject: { kind: 'session', sessionId: session.id },
        permissions: ['artifact.publish'],
        lifetime: 'session',
      },
      HUMAN,
    );
  }
  const { runId } = await d.call(HUMAN, 'session.send', {
    sessionId: session.id,
    content: plan(steps),
  });
  const run = await d.ctx.service('runs').waitForEnd(runId!);
  expect(run.status).toBe('completed');
  const inReview = d.ctx.service('tasks').setStatus(task.id, 'review', SYSTEM, null, {
    assigneeSessionId: session.id,
    workspaceId: ws.id,
  });
  return { task: inReview, ws, session, run };
}

/** A carved-out budget for the child (from the supervisor's root budget). */
function childBudget(s: Setup, c: Child) {
  const budget = s.d.ctx.service('budget');
  const root = budget.createRoot({
    subject: { kind: 'session', id: s.supervisor.id },
    limitUsd: 5,
    actor: HUMAN,
  });
  const mine = budget.allocate({
    parentId: root.id,
    subject: { kind: 'session', id: c.session.id },
    limitUsd: 1,
    actor: HUMAN,
  });
  return { root, mine };
}

async function settled(s: Setup, integrationId: string): Promise<Integration> {
  return s.d.ctx.service('integrations').settled(integrationId);
}

function diffOf(s: Setup, c: Child) {
  const diffs = s.d.ctx.repos.artifacts.find({ where: { task_id: c.task.id, kind: 'diff' } });
  expect(diffs.length).toBeGreaterThan(0);
  return diffs[0]!;
}

// ---------------------------------------------------------------------------
// acceptance 2: finalize in a worktree
// ---------------------------------------------------------------------------

describe('finalize in a worktree', () => {
  it('keeps what the run published first, then its code change, which waits for a human', async () => {
    const s = await setup();
    const c = await child(
      s,
      'FAQ ページ',
      [
        { type: 'write', path: 'docs/faq.md', content: '# FAQ\n' },
        { type: 'publish', kind: 'document', title: 'FAQ の原稿', path: 'docs/faq.md' },
      ],
      { publish: true },
    );
    const own = s.d.ctx.repos.artifacts.find({ where: { run_id: c.run.id }, direction: 'asc' });
    expect(own.map((a) => [a.kind, a.source])).toEqual([
      ['document', 'published'],
      ['diff', 'workspace_diff'],
    ]);
    const published = s.d.ctx.bus
      .list({ runId: c.run.id, types: ['tool.result'] })
      .events.find((e) => e.type === 'tool.result' && e.payload.name.endsWith('artifact_publish'));
    expect(published).toMatchObject({ payload: { isError: false } });

    const res = await s.d.ctx.service('outputs').finalize(c.run);
    expect(res).toEqual({ needsReview: true, artifactIds: [own[0]!.id, own[1]!.id] });
    expect(s.d.ctx.service('artifacts').get(own[1]!.id).review.state).toBe('pending');
    expect(s.d.ctx.service('artifacts').get(own[0]!.id).review.state).toBe('none');
    // Nothing more is recorded: no tracked files, no final answer in a worktree.
    expect(await s.d.ctx.service('outputs').finalize(c.run)).toEqual(res);
    expect(s.d.ctx.repos.artifacts.count({ where: { run_id: c.run.id } })).toBe(2);
  });

  it('a publish the run may not do comes back as a tool error, and the plan goes on', async () => {
    const s = await setup();
    const c = await child(s, 'ノート', [
      { type: 'publish', kind: 'link', title: 'x', url: 'https://example.com' },
      { type: 'write', path: 'n.md', content: 'n\n' },
    ]);
    const err = s.d.ctx.bus
      .list({ runId: c.run.id, types: ['tool.result'] })
      .events.find((e) => e.type === 'tool.result' && e.payload.name.endsWith('artifact_publish'));
    expect(err).toMatchObject({ payload: { isError: true } });
    const res = await s.d.ctx.service('outputs').finalize(c.run);
    expect(res.artifactIds).toEqual([diffOf(s, c).id]);
    expect(res.needsReview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// acceptance 3: accepting a child's code
// ---------------------------------------------------------------------------

describe('accepting code', () => {
  it('integrates, tests and applies the change; the task is done and the budget goes back', async () => {
    const s = await setup();
    const c = await child(s, '料金ページ', [
      { type: 'write', path: 'pricing.md', content: '# 料金\n' },
    ]);
    const { root, mine } = childBudget(s, c);
    await s.d.ctx.service('outputs').finalize(c.run);
    const diff = diffOf(s, c);

    // Agents (even the supervisor holding "*") cannot accept code.
    expect(
      await codeOf(
        s.d.call(s.agent, 'artifact.review', { artifactId: diff.id, decision: 'accept' }),
      ),
    ).toBe('forbidden');

    // Two clicks at once start one integration.
    const [res, second] = await Promise.all([
      s.d.call(HUMAN, 'artifact.review', {
        artifactId: diff.id,
        decision: 'accept',
        note: '良さそう',
      }),
      codeOf(s.d.call(HUMAN, 'artifact.review', { artifactId: diff.id, decision: 'accept' })),
    ]);
    expect(second).toBe('conflict');
    expect(s.d.ctx.repos.integrations.count()).toBe(1);
    expect(res.integrationId).not.toBeNull();
    expect(res.artifact.review).toMatchObject({ state: 'pending', note: '良さそう' });
    // Asking again while it is on its way returns the same integration.
    expect(
      (await s.d.call(HUMAN, 'artifact.review', { artifactId: diff.id, decision: 'accept' }))
        .integrationId,
    ).toBe(res.integrationId);

    const integ = await settled(s, res.integrationId!);
    expect(integ).toMatchObject({
      status: 'applied',
      preApprovedBy: HUMAN,
      decidedBy: HUMAN,
      taskIds: [c.task.id],
    });
    expect(integ.steps.map((st) => [st.kind, st.status])).toEqual([
      ['merge', 'succeeded'],
      ['verify', 'succeeded'],
      ['apply', 'succeeded'],
    ]);
    expect(await s.repo.git('ls-tree', '-r', '--name-only', 'main')).toContain('pricing.md');
    expect(s.d.ctx.repos.tasks.require(c.task.id).status).toBe('done');
    expect(s.d.ctx.service('artifacts').get(diff.id).review).toMatchObject({
      state: 'accepted',
      by: HUMAN,
    });
    expect(s.d.ctx.repos.budgets.require(mine.id).status).toBe('released');
    expect(s.d.ctx.repos.budgets.require(root.id).allocatedUsd).toBe(0);
    expect(s.resolved).toContainEqual({ integrationId: integ.id });
    expect(s.opened.filter((o) => o.kind === 'review')).toEqual([]);
    expect(
      await codeOf(s.d.call(HUMAN, 'artifact.review', { artifactId: diff.id, decision: 'accept' })),
    ).toBe('conflict');
  });

  it('the failure item goes once that integration runs again (an agent resolving it, a re-run)', async () => {
    const s = await setup(FAIL);
    const c = await child(s, '料金表', [{ type: 'write', path: 'fees.md', content: '# 料金\n' }]);
    await s.d.ctx.service('outputs').finalize(c.run);
    const res = await s.d.call(HUMAN, 'artifact.review', {
      artifactId: diffOf(s, c).id,
      decision: 'accept',
    });
    const integ = await settled(s, res.integrationId!);
    expect(s.opened.map((o) => o.kind)).toEqual(['failure']);
    // Already a spy (setup): the same one, without detaching the method.
    const resolveWhere = vi.spyOn(s.d.ctx.service('attention'), 'resolveWhere');
    resolveWhere.mockClear();
    onIntegrationUpdated(s.d.ctx, { ...integ, status: 'running', error: null }, ['status']);
    expect(resolveWhere).toHaveBeenCalledWith(
      { integrationId: integ.id },
      expect.objectContaining({ choiceId: null }),
      ['failure'],
    );
    // Without a status change (progress of the same attempt) nothing more is resolved.
    resolveWhere.mockClear();
    onIntegrationUpdated(s.d.ctx, { ...integ, status: 'running', error: null }, ['steps']);
    expect(resolveWhere).not.toHaveBeenCalled();
  });

  it('a failing test opens attention failure on the child; redo sends it back with the output', async () => {
    const s = await setup(FAIL);
    const c = await child(s, 'お問い合わせ', [
      { type: 'write', path: 'contact.md', content: '# 連絡\n' },
    ]);
    await s.d.ctx.service('outputs').finalize(c.run);
    const diff = diffOf(s, c);
    const res = await s.d.call(HUMAN, 'artifact.review', {
      artifactId: diff.id,
      decision: 'accept',
    });
    const integ = await settled(s, res.integrationId!);
    expect(integ).toMatchObject({ status: 'failed', preApprovedBy: HUMAN, decidedBy: null });
    expect(s.opened).toEqual([
      expect.objectContaining({
        kind: 'failure',
        sessionId: c.session.id,
        title: '「お問い合わせ」のテストが失敗',
        allowText: true,
        refs: { integrationId: integ.id, taskId: c.task.id, artifactId: diff.id },
      }),
    ]);
    expect(s.opened[0]!.choices?.map((x) => x.id)).toEqual(['retry', 'stop']);
    expect(s.d.ctx.repos.tasks.require(c.task.id).status).toBe('review');
    expect(s.d.ctx.service('artifacts').get(diff.id).review.state).toBe('pending');
    expect(await s.repo.git('ls-tree', '-r', '--name-only', 'main')).not.toContain('contact.md');

    // Redo: the same child and worktree work again, told what failed.
    const redo = await s.d.call(HUMAN, 'artifact.review', {
      artifactId: diff.id,
      decision: 'redo',
      note: 'テストが通るように直して',
    });
    expect(redo).toMatchObject({
      integrationId: null,
      artifact: { review: { state: 'rejected', by: HUMAN, note: 'テストが通るように直して' } },
    });
    const task = s.d.ctx.repos.tasks.require(c.task.id);
    expect(task).toMatchObject({ status: 'running', assigneeSessionId: c.session.id });
    const retry = s.d.ctx.repos.runs.findOne({
      where: { session_id: c.session.id },
      direction: 'desc',
    })!;
    expect(retry.id).not.toBe(c.run.id);
    expect(retry.workspaceId).toBe(c.ws.id);
    const feedback = s.d.ctx.repos.messages.require(retry.triggerMessageId!);
    const text = JSON.stringify(feedback.content);
    expect(text).toContain('テストが通るように直して');
    expect(text).toContain('boom-output');
    expect(s.resolved).toContainEqual({ artifactId: diff.id });
    await s.d.ctx.service('runs').waitForEnd(retry.id);

    // The retry made a newer change: the old one can no longer be accepted.
    const newer = s.d.ctx.repos.artifacts.findOne({
      where: { task_id: c.task.id, kind: 'diff' },
      direction: 'desc',
    })!;
    expect(newer.id).not.toBe(diff.id);
    expect(
      await codeOf(s.d.call(HUMAN, 'artifact.review', { artifactId: diff.id, decision: 'accept' })),
    ).toBe('conflict');
  });

  it('when the target cannot be fast-forwarded it waits for a human with the reason', async () => {
    const s = await setup();
    const c = await child(s, 'ヘッダー', [{ type: 'write', path: 'header.md', content: 'h\n' }]);
    s.repo.write('a.txt', 'dirty in the main checkout\n');
    const diff = diffOf(s, c);
    const res = await s.d.call(HUMAN, 'artifact.review', {
      artifactId: diff.id,
      decision: 'accept',
    });
    const integ = await settled(s, res.integrationId!);
    expect(integ.status).toBe('awaiting_approval');
    expect(integ.error).toMatchObject({ code: 'apply_failed' });
    expect(s.opened).toEqual([
      expect.objectContaining({
        kind: 'review',
        sessionId: c.session.id,
        title: '「ヘッダー」の変更を反映',
        refs: { integrationId: integ.id },
      }),
    ]);
    expect(s.opened[0]!.detail).toContain('未コミット');
    s.repo.write('a.txt', 'a\n');
    const applied = await s.d.call(HUMAN, 'integration.approve', { integrationId: integ.id });
    expect(applied.status).toBe('applied');
    expect(s.d.ctx.repos.tasks.require(c.task.id).status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// acceptance 4: a supervisor integrates several children
// ---------------------------------------------------------------------------

describe("a supervisor's integration", () => {
  it('asks a human to apply it, and applying marks every task done', async () => {
    const s = await setup();
    const one = await child(s, 'ログイン', [{ type: 'write', path: 'login.md', content: 'l\n' }]);
    const two = await child(s, 'ログアウト', [
      { type: 'write', path: 'logout.md', content: 'o\n' },
    ]);
    for (const c of [one, two]) await s.d.ctx.service('outputs').finalize(c.run);
    const created = await s.d.call(s.agent, 'integration.create', {
      projectId: s.project.id,
      taskIds: [one.task.id, two.task.id],
    });
    await s.d.call(s.agent, 'integration.run', { integrationId: created.id });
    const integ = await settled(s, created.id);
    expect(integ.status).toBe('awaiting_approval');
    expect(s.opened).toEqual([
      expect.objectContaining({
        kind: 'review',
        sessionId: s.supervisor.id,
        title: '2 件のコードの変更を反映',
        refs: { integrationId: integ.id },
      }),
    ]);
    // The integration's own diff is evidence, not one more output to accept.
    const own = s.d.ctx.repos.artifacts.find({
      where: { kind: 'diff' },
      sql: { clause: "json_extract(data, '$.workspaceId') = ?", params: [integ.workspaceId] },
    });
    expect(own.map((a) => a.role)).toEqual(['evidence']);

    expect(
      await codeOf(s.d.call(s.agent, 'integration.approve', { integrationId: integ.id })),
    ).toBe('forbidden');
    const applied = await s.d.call(HUMAN, 'integration.approve', { integrationId: integ.id });
    expect(applied.status).toBe('applied');
    for (const c of [one, two]) {
      expect(s.d.ctx.repos.tasks.require(c.task.id).status).toBe('done');
      expect(s.d.ctx.service('artifacts').get(diffOf(s, c).id).review).toMatchObject({
        state: 'accepted',
        by: HUMAN,
      });
    }
    expect(s.resolved).toContainEqual({ integrationId: integ.id });
    const files = await s.repo.git('ls-tree', '-r', '--name-only', 'main');
    expect(files).toContain('login.md');
    expect(files).toContain('logout.md');
  });

  it('the supervisor may send a child back (redo), within its own tree only', async () => {
    const s = await setup();
    const c = await child(s, '検索', [{ type: 'write', path: 'search.md', content: 's\n' }]);
    const diff = diffOf(s, c);
    const outsider = await s.d.call(HUMAN, 'session.create', { title: 'other' });
    s.d.ctx.service('policy').createGrant(
      {
        subject: { kind: 'session', sessionId: outsider.id },
        permissions: ['*'],
        lifetime: 'session',
      },
      HUMAN,
    );
    const stranger = agentActor(outsider.id, s.d.ctx.ids.next('run'));
    expect(
      await codeOf(
        s.d.call(stranger, 'artifact.review', { artifactId: diff.id, decision: 'redo' }),
      ),
    ).toBe('forbidden');
    const res = await s.d.call(s.agent, 'artifact.review', {
      artifactId: diff.id,
      decision: 'redo',
      note: '検索結果を 10 件に',
    });
    expect(res.artifact.review).toMatchObject({ state: 'rejected', by: s.agent });
    expect(s.d.ctx.repos.tasks.require(c.task.id).status).toBe('running');
    const retry = s.d.ctx.repos.runs.findOne({
      where: { session_id: c.session.id },
      direction: 'desc',
    })!;
    const ended = await s.d.ctx.service('runs').waitForEnd(retry.id);
    expect(ended).toMatchObject({ workspaceId: c.ws.id, status: 'completed' });
  });

  it('a done child with an answer only is opened again for a redo', async () => {
    const s = await setup();
    const c = await child(s, '調査メモ', [{ type: 'say', text: '3 社を比べました。' }]);
    const res = await s.d.ctx.service('outputs').finalize(c.run);
    expect(res.needsReview).toBe(false);
    const answer = s.d.ctx.service('artifacts').get(res.artifactIds[0]!);
    expect(answer).toMatchObject({ kind: 'document', source: 'final_message' });
    s.d.ctx.service('tasks').setStatus(c.task.id, 'done', SYSTEM);
    await s.d.call(HUMAN, 'artifact.review', {
      artifactId: answer.id,
      decision: 'redo',
      note: '4 社目も',
    });
    expect(s.d.ctx.repos.tasks.require(c.task.id).status).toBe('running');
    const retry = s.d.ctx.repos.runs.findOne({
      where: { session_id: c.session.id },
      direction: 'desc',
    })!;
    await s.d.ctx.service('runs').waitForEnd(retry.id);
  });
});
