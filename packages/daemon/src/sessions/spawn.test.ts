/**
 * T2 acceptance (spec 20261029 §5.4): children through session.spawn — the four ways to
 * start one, where they work, `after` / child slots / depth, budgets, how they end (§3.4),
 * the request as the first message, neutral prompts, and the code flow through spawn.
 *
 * The services of later tracks are stand-ins here, as the spec allows: outputs.finalize
 * turns the final answer into a document (T3), attention.open stores the item (T4),
 * inbox.deliver records what the parent is told (T1).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentActor, Attention, Run, Session, Task } from '@acc/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunInput, AgentRuntime, InboxDeliverInput } from '../contracts';
import { ApiError } from '../core/errors';
import { deriveSessionState, readStateFacts } from '../home';
import { textOfParts } from '../llm/messages';
import { buildAgentPrompt } from '../runtime/executor';
import { MockAgentRuntime } from '../runtime/mock/runtime';
import { HUMAN, type TestDaemonNoServer, agentActor, createTestDaemon } from '../testing';
import { type TempRepo, createTempRepo, isolateGitConfig } from '../workspace/git-fixture';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let restoreGit: () => void;
beforeAll(() => {
  restoreGit = isolateGitConfig();
});
afterAll(() => restoreGit());

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof ApiError ? err.code : String(err);
  }
}

function tempDir(prefix: string, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

/** An acc-mock plan for the mock agent (paths relative to its workspace, or absolute). */
function plan(steps: unknown[], summary?: string): string {
  return `\n\`\`\`acc-mock\n${JSON.stringify({ steps, ...(summary ? { summary } : {}), delayScale: 0 })}\n\`\`\``;
}

interface Harness {
  d: TestDaemonNoServer;
  inputs: AgentRunInput[];
  opened: Attention[];
  delivered: { sessionId: string; input: InboxDeliverInput }[];
}

async function setup(): Promise<Harness> {
  const d: TestDaemonNoServer = await createTestDaemon();
  cleanups.push(() => d.cleanup());
  d.ctx.service('llm').mock.chunkDelayMs = 0;
  const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
  const inputs: AgentRunInput[] = [];
  vi.spyOn(d.ctx.service('runtimes').get('mock'), 'run').mockImplementation((i) => {
    inputs.push(i);
    return fast.run(i);
  });
  // T3 stand-in: the final answer becomes a document.
  vi.spyOn(d.ctx.service('outputs'), 'finalize').mockImplementation((run: Run) => {
    const text = d.ctx.repos.messages
      .find({ where: { session_id: run.sessionId, run_id: run.id }, orderBy: 'id' })
      .filter((m) => m.role === 'assistant')
      .map((m) => textOfParts(m.content).trim())
      .find(Boolean);
    if (!text) return Promise.resolve({ needsReview: false, artifactIds: [] });
    const a = d.ctx.service('artifacts').record({
      kind: 'document',
      title: '最後の回答',
      data: { format: 'markdown', content: text, path: null },
      sessionId: run.sessionId,
      runId: run.id,
      taskId: run.taskId,
      createdBy: { kind: 'system', component: 'outputs' },
    });
    return Promise.resolve({ needsReview: false, artifactIds: [a.id] });
  });
  // T4 stand-in: attention items are stored, so the derived state sees them.
  const opened: Attention[] = [];
  vi.spyOn(d.ctx.service('attention'), 'open').mockImplementation((input) => {
    const s = d.ctx.repos.sessions.require(input.sessionId);
    const a = insertAttention(d, s, input.kind, input.title, input.refs);
    opened.push(a);
    return a;
  });
  // T1 stand-in: record what parents are told.
  const delivered: Harness['delivered'] = [];
  vi.spyOn(d.ctx.service('inbox'), 'deliver').mockImplementation((sessionId, input) => {
    delivered.push({ sessionId, input });
    return { item: null, delivery: 'queued', runId: null };
  });
  return { d, inputs, opened, delivered };
}

function insertAttention(
  d: TestDaemonNoServer,
  s: Session,
  kind: Attention['kind'],
  title: string,
  refs: Attention['refs'] = {},
): Attention {
  return d.ctx.repos.attention.insert({
    id: d.ctx.ids.next('attention'),
    kind,
    status: 'open',
    sessionId: s.id,
    rootSessionId: s.rootSessionId,
    title,
    detail: null,
    choices: [],
    allowText: kind === 'question',
    priority: 0,
    refs,
    resolution: null,
    createdAt: d.ctx.clock.iso(),
    resolvedAt: null,
  });
}

/**
 * A supervisor: a chat with a session grant that allows session.spawn (what session.delegate
 * gives, T1) and a live turn of its own that stays open while the test acts as it.
 */
async function supervisor(
  d: TestDaemonNoServer,
  opts: { maxChildren?: number; budgetUsd?: number; permissions?: string[]; title?: string } = {},
) {
  const session = await d.call(HUMAN, 'session.create', { title: opts.title ?? '指揮役' });
  d.ctx.service('policy').createGrant(
    {
      subject: { kind: 'session', sessionId: session.id },
      permissions: opts.permissions ?? [
        'session.spawn',
        'session.send',
        'session.get',
        'task.retry',
        'task.get',
      ],
      limits: { maxChildren: opts.maxChildren ?? 4, maxDepth: 1 },
      lifetime: 'session',
      reason: 'supervisor',
    },
    HUMAN,
  );
  const budget =
    opts.budgetUsd === undefined
      ? null
      : d.ctx.service('budget').createRoot({
          subject: { kind: 'session', id: session.id },
          limitUsd: opts.budgetUsd,
          actor: HUMAN,
        });
  d.ctx
    .service('runs')
    .registerExecutor(
      'orchestrator',
      (ctl) =>
        new Promise<void>((r) => ctl.signal.addEventListener('abort', () => r(), { once: true })),
    );
  const run = d.ctx.service('runs').start({
    sessionId: session.id,
    kind: 'orchestrator',
    createdBy: HUMAN,
    budgetId: budget?.id ?? null,
  });
  await until(() => d.ctx.repos.runs.require(run.id).status === 'running');
  const actor: AgentActor = agentActor(session.id, run.id);
  return { session, budget, run, actor };
}

function taskOf(d: TestDaemonNoServer, sessionId: string): Task {
  const s = d.ctx.repos.sessions.require(sessionId);
  return d.ctx.repos.tasks.require(s.taskId!);
}

async function taskSettles(h: Harness, sessionId: string, status: Task['status']): Promise<Task> {
  return until(() => {
    const t = taskOf(h.d, sessionId);
    return t.status === status && t;
  });
}

function stateOf(d: TestDaemonNoServer, sessionId: string) {
  return deriveSessionState(readStateFacts(d.ctx, d.ctx.repos.sessions.require(sessionId)));
}

function childUpdates(h: Harness, parentId: string, childId: string) {
  return h.delivered.filter(
    (x) =>
      x.sessionId === parentId &&
      x.input.kind === 'child_update' &&
      x.input.refs?.childSessionId === childId,
  );
}

async function codeProject(d: TestDaemonNoServer, name = 'app') {
  const repo: TempRepo = await createTempRepo();
  cleanups.push(() => repo.cleanup());
  const project = await d.call(HUMAN, 'project.create', {
    name,
    repoPath: repo.path,
    defaultBranch: 'main',
    testCommand: 'node --version',
  });
  return { repo, project };
}

// ---------------------------------------------------------------------------

describe('session.spawn: four ways to start a child', () => {
  it('chat child: an ordinary conversation without a workspace, done with its answer', async () => {
    const h = await setup();
    const { d } = h;
    const sup = await supervisor(d);
    const r = await d.call(sup.actor, 'session.spawn', {
      title: '告知文の下書き',
      goal: '新製品の告知文を 3 行で書いて',
      mode: 'chat',
    });
    expect(r.session).toMatchObject({
      kind: 'chat',
      parentSessionId: sup.session.id,
      rootSessionId: sup.session.id,
      workspaceId: null,
      title: '告知文の下書き',
      brief: { goal: '新製品の告知文を 3 行で書いて', fromSessionId: sup.session.id },
    });
    const run = await d.ctx.service('runs').waitForEnd(r.runId!);
    expect(run).toMatchObject({
      kind: 'chat',
      status: 'completed',
      trigger: 'spawn',
      parentRunId: sup.run.id,
    });
    const task = await taskSettles(h, r.session.id, 'done');
    expect(task).toMatchObject({
      projectId: null,
      assigneeSessionId: r.session.id,
      autoStart: true,
    });
    const docs = d.ctx.repos.artifacts.find({
      where: { session_id: r.session.id, kind: 'document' },
    });
    expect(docs).toHaveLength(1);
    expect(childUpdates(h, sup.session.id, r.session.id)).toHaveLength(1);
    expect(stateOf(d, r.session.id)).toBe('done');
  });

  it('agent + none: a scratch folder of its own, without git', async () => {
    const h = await setup();
    const { d } = h;
    const sup = await supervisor(d);
    const r = await d.call(sup.actor, 'session.spawn', {
      title: '市場調査メモ',
      goal: `競合の価格を調べてメモにまとめる${plan([{ type: 'write', path: 'memo.md', content: '# 調査\n' }], '調査メモを書きました')}`,
    });
    const ws = d.ctx.repos.workspaces.require(r.session.workspaceId!);
    expect(ws).toMatchObject({
      kind: 'scratch',
      status: 'ready',
      path: join(d.home, 'scratch', r.session.id),
      branch: null,
    });
    expect(taskOf(d, r.session.id).workspaceId).toBe(ws.id);
    await taskSettles(h, r.session.id, 'done');
    expect(readFileSync(join(ws.path, 'memo.md'), 'utf8')).toBe('# 調査\n');
    expect(
      d.ctx.repos.artifacts.find({ where: { session_id: r.session.id, kind: 'diff' } }),
    ).toEqual([]);
    expect(h.inputs[0]).toMatchObject({ cwd: ws.path, writeRoot: ws.path, readRoots: [] });
    expect(h.inputs[0]!.prompt).not.toMatch(/git|worktree|コミット|テスト/i);
    expect(stateOf(d, r.session.id)).toBe('done');
  });

  it('agent + folder: works in place in a folder of the user, one record per folder', async () => {
    const h = await setup();
    const { d } = h;
    const folder = tempDir('acc-folder-');
    const root = await d.call(HUMAN, 'session.create', { title: '資料の整理' });
    const a = await d.call(HUMAN, 'session.spawn', {
      parentSessionId: root.id,
      title: '索引を作る',
      goal: `索引を作る${plan([{ type: 'write', path: 'index.md', content: '- a\n' }])}`,
      workspace: { kind: 'folder', path: folder },
    });
    const ws = d.ctx.repos.workspaces.require(a.session.workspaceId!);
    expect(ws).toMatchObject({ kind: 'directory', path: folder, projectId: null });
    await taskSettles(h, a.session.id, 'done');
    expect(readFileSync(join(folder, 'index.md'), 'utf8')).toBe('- a\n');
    expect(h.inputs[0]!.prompt).not.toMatch(/git|worktree|コミット|テスト/i);
    // The same folder is the same workspace (its lock lets one run write at a time).
    const b = await d.call(HUMAN, 'session.spawn', {
      parentSessionId: root.id,
      title: '見出しをそろえる',
      goal: '見出しをそろえる',
      workspace: { kind: 'folder', path: folder },
      start: false,
    });
    expect(b.session.workspaceId).toBe(ws.id);
    // Agents may only pick a folder inside their project's own folder.
    const sup = await supervisor(d);
    expect(
      await codeOf(
        d.call(sup.actor, 'session.spawn', {
          title: 'x',
          goal: 'x',
          workspace: { kind: 'folder', path: folder },
        }),
      ),
    ).toBe('forbidden');
    // The daemon's own data folder is never a workspace.
    expect(
      await codeOf(
        d.call(HUMAN, 'session.spawn', {
          title: 'x',
          goal: 'x',
          workspace: { kind: 'folder', path: d.home },
        }),
      ),
    ).toBe('invalid_params');
  });

  it('agent + worktree: code changes go to review; a project needs no git otherwise', async () => {
    const h = await setup();
    const { d } = h;
    const { project } = await codeProject(d);
    const sup = await supervisor(d);
    const r = await d.call(sup.actor, 'session.spawn', {
      title: 'ログイン画面',
      goal: `ログイン画面を作る${plan([{ type: 'write', path: 'src/login.ts', content: 'export {};\n' }])}`,
      workspace: { kind: 'worktree', projectId: project.id },
    });
    expect(r.session.projectId).toBe(project.id);
    const ws = d.ctx.repos.workspaces.require(r.session.workspaceId!);
    expect(ws).toMatchObject({ kind: 'worktree', projectId: project.id });
    expect(ws.branch).toMatch(/^acc\//);
    await taskSettles(h, r.session.id, 'review');
    expect(h.inputs[0]!.prompt).toContain('git worktree');
    expect(h.inputs[0]!.readRoots).toEqual([project.repoPath]);
    // Its parent supervises: it is told, and decides on the outputs together (no attention).
    expect(childUpdates(h, sup.session.id, r.session.id)).toHaveLength(1);
    expect(h.opened).toEqual([]);
    expect(stateOf(d, r.session.id)).toBe('review');

    // A project made from a name alone (no git, no folder) takes children too.
    const plain = await d.call(HUMAN, 'project.create', { name: '新製品ローンチ準備' });
    expect(plain).toMatchObject({ repoPath: null, folderPath: null });
    const c = await d.call(HUMAN, 'session.spawn', {
      title: 'FAQ',
      goal: 'FAQ を書く',
      projectId: plain.id,
      start: false,
    });
    expect(c.session.projectId).toBe(plain.id);
    expect(d.ctx.repos.workspaces.require(c.session.workspaceId!).kind).toBe('scratch');
    expect(
      await codeOf(
        d.call(HUMAN, 'session.spawn', {
          title: 'x',
          goal: 'x',
          workspace: { kind: 'worktree', projectId: plain.id },
        }),
      ),
    ).toBe('invalid_params');
  });
});

describe('where a child may read and write', () => {
  it('a scratch agent reads its project folder and cannot write outside its scratch', async () => {
    const h = await setup();
    const { d } = h;
    const folder = tempDir('acc-docs-', { 'pricing.md': '月額 980 円\n' });
    const project = await d.call(HUMAN, 'project.create', { name: '資料', folderPath: folder });
    const r = await d.call(HUMAN, 'session.spawn', {
      title: 'FAQ を書く',
      goal: `価格を確かめて FAQ を書く${plan([
        { type: 'check', path: join(folder, 'pricing.md'), contains: '980' },
        { type: 'write', path: join(folder, 'leak.md'), content: 'x' },
        { type: 'write', path: 'faq.md', content: '# FAQ\n980 円\n' },
      ])}`,
      projectId: project.id,
    });
    await taskSettles(h, r.session.id, 'done');
    const ws = d.ctx.repos.workspaces.require(r.session.workspaceId!);
    expect(existsSync(join(ws.path, 'faq.md'))).toBe(true);
    expect(existsSync(join(folder, 'leak.md'))).toBe(false);
    expect(h.inputs[0]!.readRoots).toEqual([folder]);
    expect(h.inputs[0]!.prompt).toContain(folder);
    const decided = d.ctx.bus
      .list({ types: ['tool.decided'], limit: 1000 })
      .events.flatMap((e) => (e.type === 'tool.decided' ? [e.payload] : []));
    expect(decided).toContainEqual(
      expect.objectContaining({ decision: 'denied', rule: 'outside_write' }),
    );
  });
});

describe('after, child slots and depth', () => {
  it('after: a child waiting for a sibling starts by itself once that sibling is done', async () => {
    const h = await setup();
    const { d } = h;
    const sup = await supervisor(d);
    const a = await d.call(sup.actor, 'session.spawn', {
      title: '調査',
      goal: `調べる${plan([{ type: 'sleep', ms: 200 }])}`,
    });
    const b = await d.call(sup.actor, 'session.spawn', {
      title: 'まとめ',
      goal: 'まとめる',
      after: [a.session.id],
    });
    expect(b).toMatchObject({ runId: null, waitingFor: [a.session.id] });
    expect(taskOf(d, b.session.id)).toMatchObject({
      status: 'pending',
      dependsOn: [taskOf(d, a.session.id).id],
    });
    expect(stateOf(d, b.session.id)).toBe('queued');
    const doneA = await taskSettles(h, a.session.id, 'done');
    await taskSettles(h, b.session.id, 'done');
    const runsB = d.ctx.repos.runs.find({ where: { session_id: b.session.id } });
    expect(runsB).toHaveLength(1);
    expect(runsB[0]).toMatchObject({ trigger: 'spawn', kind: 'agent' });
    expect(runsB[0]!.createdAt >= doneA.completedAt!).toBe(true);
    // Only siblings can be waited for.
    const other = await d.call(HUMAN, 'session.create', {});
    expect(
      await codeOf(
        d.call(sup.actor, 'session.spawn', { title: 'x', goal: 'x', after: [other.id] }),
      ),
    ).toBe('invalid_params');
  });

  it('maxChildren: a spawn beyond the limit waits and starts when a slot frees', async () => {
    const h = await setup();
    const { d } = h;
    const sup = await supervisor(d, { maxChildren: 1 });
    const a = await d.call(sup.actor, 'session.spawn', {
      title: '一人目',
      goal: `作業する${plan([{ type: 'sleep', ms: 200 }])}`,
    });
    const b = await d.call(sup.actor, 'session.spawn', { title: '二人目', goal: '作業する' });
    expect(a.runId).not.toBeNull();
    expect(b).toMatchObject({ runId: null, waitingFor: [] });
    expect(taskOf(d, b.session.id).status).toBe('ready');
    await taskSettles(h, a.session.id, 'done');
    await taskSettles(h, b.session.id, 'done');
    const [runA] = d.ctx.repos.runs.find({ where: { session_id: a.session.id } });
    const [runB] = d.ctx.repos.runs.find({ where: { session_id: b.session.id } });
    expect(runB!.createdAt >= runA!.endedAt!).toBe(true);
  });

  it('depth 2 is limit_exceeded: children cannot start children, nor be made parents', async () => {
    const h = await setup();
    const { d } = h;
    const sup = await supervisor(d);
    const c = await d.call(sup.actor, 'session.spawn', {
      title: '子',
      goal: 'g',
      start: false,
      permissions: ['session.spawn'],
    });
    const child = agentActor(c.session.id, d.ctx.ids.next('run'));
    expect(await codeOf(d.call(child, 'session.spawn', { title: '孫', goal: 'g' }))).toBe(
      'limit_exceeded',
    );
    expect(
      await codeOf(
        d.call(sup.actor, 'session.spawn', {
          parentSessionId: c.session.id,
          title: '孫',
          goal: 'g',
        }),
      ),
    ).toBe('limit_exceeded');
    // Without the permission it is refused before any limit.
    const plain = await d.call(sup.actor, 'session.spawn', {
      title: '子2',
      goal: 'g',
      start: false,
    });
    expect(
      await codeOf(
        d.call(agentActor(plain.session.id, d.ctx.ids.next('run')), 'session.spawn', {
          title: '孫',
          goal: 'g',
        }),
      ),
    ).toBe('forbidden');
    // Another tree is out of reach.
    const other = await d.call(HUMAN, 'session.create', {});
    expect(
      await codeOf(
        d.call(sup.actor, 'session.spawn', { parentSessionId: other.id, title: 'x', goal: 'g' }),
      ),
    ).toBe('forbidden');
  });
});

describe('AI-started children inside permission and budget', () => {
  it('an AI starts a chat child with a slice of its budget', async () => {
    const h = await setup();
    const { d } = h;
    const sup = await supervisor(d, { budgetUsd: 1, maxChildren: 4 });
    const r = await d.call(sup.actor, 'session.spawn', {
      title: '言い換え案',
      goal: 'キャッチコピーを 3 案',
      mode: 'chat',
    });
    expect(r.budgetId).not.toBeNull();
    // The equal share — (free $1 − two $0.25 reservations kept for the caller) / (4 slots + 1)
    // = $0.10 — is raised to one call reservation ($0.25), or a chat child could never run.
    expect(d.ctx.service('budget').get(r.budgetId!)).toMatchObject({
      parentId: sup.budget!.id,
      limitUsd: 0.25,
      subject: { kind: 'session', id: r.session.id },
    });
    const run = await d.ctx.service('runs').waitForEnd(r.runId!);
    expect(run).toMatchObject({ status: 'completed', budgetId: r.budgetId });
    // An agent child (it reports cost afterwards) gets the plain share of what is left.
    const a = await d.call(sup.actor, 'session.spawn', {
      title: '下調べ',
      goal: 'g',
      start: false,
    });
    expect(d.ctx.service('budget').get(a.budgetId!).limitUsd).toBe(0.05);
  });

  it('a caller with a budget cannot start a child outside it; without the permission it cannot start one', async () => {
    const h = await setup();
    const { d } = h;
    const poor = await supervisor(d, { budgetUsd: 0.4 });
    expect(await codeOf(d.call(poor.actor, 'session.spawn', { title: 'x', goal: 'g' }))).toBe(
      'budget_exceeded',
    );
    const rich = await supervisor(d, { budgetUsd: 1 });
    expect(
      await codeOf(d.call(rich.actor, 'session.spawn', { title: 'x', goal: 'g', budgetUsd: 5 })),
    ).toBe('budget_exceeded');
    // Nothing was left behind by the refused spawns.
    expect(d.ctx.repos.sessions.count({ where: { parent_session_id: poor.session.id } })).toBe(0);
    const reader = await supervisor(d, { permissions: ['session.get'] });
    expect(await codeOf(d.call(reader.actor, 'session.spawn', { title: 'x', goal: 'g' }))).toBe(
      'forbidden',
    );
  });
});

describe('how a child ends (§3.4)', () => {
  it('unsupervised code changes wait for a person: review attention, nobody to tell', async () => {
    const h = await setup();
    const { d } = h;
    const { project } = await codeProject(d);
    const r = await d.call(HUMAN, 'session.spawn', {
      title: '設定画面',
      goal: `設定画面${plan([{ type: 'write', path: 'src/settings.ts', content: 'export {};\n' }])}`,
      workspace: { kind: 'worktree', projectId: project.id },
    });
    await taskSettles(h, r.session.id, 'review');
    expect(h.opened).toEqual([
      expect.objectContaining({
        kind: 'review',
        sessionId: r.session.id,
        title: '「設定画面」の成果物を確認',
      }),
    ]);
    expect(h.delivered).toEqual([]);
    expect(stateOf(d, r.session.id)).toBe('review');
  });

  it('reviewBy human puts even a document in review', async () => {
    const h = await setup();
    const { d } = h;
    const root = await d.call(HUMAN, 'session.create', {});
    const r = await d.call(HUMAN, 'session.spawn', {
      parentSessionId: root.id,
      title: '契約書の要約',
      goal: '要約する',
      reviewBy: 'human',
    });
    await taskSettles(h, r.session.id, 'review');
    expect(h.opened.map((a) => a.kind)).toEqual(['review']);
  });

  it('an open question keeps the child waiting for a person; the answer resumes it', async () => {
    const h = await setup();
    const { d } = h;
    let asks = 0;
    const asker: AgentRuntime = {
      id: 'asker',
      displayName: 'asker',
      available: () => Promise.resolve({ ok: true }),
      async *run(input: AgentRunInput): AsyncGenerator<AgentEvent> {
        const run = d.ctx.repos.runs.require(input.runId);
        if (asks++ === 0) {
          // What human.ask (T4) leaves behind: an open question on the child.
          insertAttention(
            d,
            d.ctx.repos.sessions.require(run.sessionId),
            'question',
            '価格を載せる？',
          );
        }
        yield {
          type: 'message',
          messageId: `m${asks}`,
          role: 'assistant',
          content: [{ type: 'text', text: asks === 1 ? '確認待ちです' : 'FAQ を書きました' }],
        };
      },
    };
    d.ctx.service('runtimes').register(asker);
    const sup = await supervisor(d);
    const r = await d.call(sup.actor, 'session.spawn', {
      title: 'FAQ',
      goal: 'FAQ を書く',
      runtime: 'asker',
    });
    const blocked = await taskSettles(h, r.session.id, 'blocked');
    expect(blocked.statusReason).toBe('waiting_for_human');
    expect(stateOf(d, r.session.id)).toBe('needs_you');
    expect(childUpdates(h, sup.session.id, r.session.id)).toHaveLength(1);

    // The answer (T4 resolves the question and sends it as a message) starts a new run.
    for (const a of d.ctx.repos.attention.find({ where: { session_id: r.session.id } })) {
      d.ctx.repos.attention.update(a.id, (x) => ({ ...x, status: 'resolved' }));
    }
    const sent = await d.call(HUMAN, 'session.send', {
      sessionId: r.session.id,
      content: '回答: 載せる',
    });
    expect(taskOf(d, r.session.id).status).toBe('running');
    await d.ctx.service('runs').waitForEnd(sent.runId!);
    await taskSettles(h, r.session.id, 'done');
  });

  it('a failure opens a failure item on the child and tells the parent', async () => {
    const h = await setup();
    const { d } = h;
    const sup = await supervisor(d);
    const r = await d.call(sup.actor, 'session.spawn', {
      title: 'ビルド',
      goal: `ビルドする${plan([{ type: 'fail', message: 'ビルドが通りませんでした' }])}`,
    });
    const task = await taskSettles(h, r.session.id, 'failed');
    expect(task.statusReason).toBe('worker_failed');
    expect(h.opened).toEqual([
      expect.objectContaining({
        kind: 'failure',
        sessionId: r.session.id,
        title: '「ビルド」が失敗しました',
        refs: expect.objectContaining({ runId: r.runId, taskId: task.id }),
      }),
    ]);
    expect(childUpdates(h, sup.session.id, r.session.id)).toHaveLength(1);
    expect(stateOf(d, r.session.id)).toBe('failed');
  });

  it('running out of budget opens a budget item (needs you)', async () => {
    const h = await setup();
    const { d } = h;
    const sup = await supervisor(d, { budgetUsd: 1 });
    const r = await d.call(sup.actor, 'session.spawn', {
      title: '長い調査',
      goal: `調べる${plan([{ type: 'say', text: '長い説明'.repeat(200) }])}`,
      budgetUsd: 0.000_01,
    });
    const task = await taskSettles(h, r.session.id, 'failed');
    expect(task.statusReason).toBe('budget_exhausted');
    expect(h.opened).toEqual([
      expect.objectContaining({
        kind: 'budget',
        title: '「長い調査」の予算が尽きました',
        refs: expect.objectContaining({ budgetId: r.budgetId }),
      }),
    ]);
    expect(stateOf(d, r.session.id)).toBe('needs_you');
  });

  it('a stop by its parent pauses it quietly; a stop by someone else tells the parent', async () => {
    const h = await setup();
    const { d } = h;
    const sup = await supervisor(d);
    const long = plan([{ type: 'sleep', ms: 30_000 }]);
    const a = await d.call(sup.actor, 'session.spawn', { title: 'A', goal: `a${long}` });
    const b = await d.call(sup.actor, 'session.spawn', { title: 'B', goal: `b${long}` });
    await until(() => d.ctx.repos.runs.require(a.runId!).status === 'running');
    await until(() => d.ctx.repos.runs.require(b.runId!).status === 'running');
    d.ctx.service('runs').cancel(a.runId!, sup.actor);
    d.ctx.service('runs').cancel(b.runId!, HUMAN);
    expect(await taskSettles(h, a.session.id, 'paused')).toMatchObject({ statusReason: 'stopped' });
    await taskSettles(h, b.session.id, 'paused');
    expect(childUpdates(h, sup.session.id, a.session.id)).toEqual([]);
    expect(childUpdates(h, sup.session.id, b.session.id)).toHaveLength(1);
    expect(stateOf(d, a.session.id)).toBe('stopped');
  });

  it.each([
    ['failed', 'loop_detected', 'failed', 'stuck', 'needs_you'],
    ['failed', 'turn_limit', 'failed', 'stuck', 'needs_you'],
    ['failed', 'daily_limit', 'failed', null, 'idle'],
    ['interrupted', 'daemon_restart', 'ready', null, 'queued'],
    ['cancelled', 'superseded', 'running', null, null],
  ] as const)(
    'a run %s (%s) → task %s, attention %s',
    async (runStatus, reason, taskStatus, attention, state) => {
      const h = await setup();
      const { d } = h;
      const sup = await supervisor(d);
      const c = await d.call(sup.actor, 'session.spawn', { title: '子', goal: 'g', start: false });
      const task = d.ctx.service('tasks').setStatus(taskOf(d, c.session.id).id, 'running', HUMAN);
      const now = d.ctx.clock.iso();
      const run = d.ctx.repos.runs.insert({
        id: d.ctx.ids.next('run'),
        sessionId: c.session.id,
        projectId: null,
        taskId: task.id,
        kind: 'agent',
        status: runStatus,
        statusReason: reason,
        model: null,
        runtime: 'mock',
        workspaceId: c.session.workspaceId,
        parentRunId: null,
        retryOfRunId: null,
        attempt: 1,
        budgetId: null,
        triggerMessageId: null,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'unknown' },
        error: runStatus === 'failed' ? { code: reason, message: '止めました' } : null,
        createdBy: HUMAN,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        endedAt: now,
      });
      await d.ctx
        .service('workers')
        .onChildRunEnded(run, task, d.ctx.repos.sessions.require(c.session.id));
      expect(taskOf(d, c.session.id).status).toBe(taskStatus);
      expect(h.opened.map((a) => a.kind)).toEqual(attention ? [attention] : []);
      if (state) expect(stateOf(d, c.session.id)).toBe(state);
    },
  );
});

describe('the request', () => {
  it('the first message is the brief, and no title says "Worker:"', async () => {
    const h = await setup();
    const { d } = h;
    const sup = await supervisor(d);
    const r = await d.call(sup.actor, 'session.spawn', {
      title: 'FAQ を書く',
      goal: '価格と対応 OS を FAQ にまとめる',
      doneWhen: ['価格が載っている', '対応 OS が載っている'],
      start: false,
    });
    expect(r.session.title).toBe('FAQ を書く');
    const [first, ...rest] = d.ctx.repos.messages.find({
      where: { session_id: r.session.id },
      orderBy: 'id',
      direction: 'asc',
    });
    expect(rest).toEqual([]);
    expect(first).toMatchObject({
      role: 'user',
      author: sup.actor,
      meta: {
        kind: 'brief',
        brief: {
          goal: '価格と対応 OS を FAQ にまとめる',
          doneWhen: ['価格が載っている', '対応 OS が載っている'],
          fromSessionId: sup.session.id,
          reviewBy: 'none',
        },
      },
    });
    expect(textOfParts(first!.content)).toBe(
      '価格と対応 OS を FAQ にまとめる\n\n## 完了条件\n- 価格が載っている\n- 対応 OS が載っている',
    );
    const decision = d.ctx.bus
      .list({ types: ['orchestrator.decision'], limit: 100 })
      .events.map((e) => (e.type === 'orchestrator.decision' ? e.payload.decision : ''));
    expect(decision).toContain('「FAQ を書く」を任せました');

    // Workers started for a task are named after the task alone too.
    d.ctx.service('runs').registerExecutor('agent', () => Promise.resolve());
    const { project } = await codeProject(d);
    const t = await d.call(HUMAN, 'task.create', { projectId: project.id, title: '画面を作る' });
    const w = await d.call(HUMAN, 'task.spawnWorker', { taskId: t.id });
    expect(d.ctx.repos.sessions.require(w.sessionId).title).toBe('画面を作る');
  });

  it('prompts outside a worktree never mention git, worktrees or tests', () => {
    const task = {
      title: '告知文',
      description: '新製品の告知文を書く',
      acceptanceCriteria: ['3 行'],
    };
    for (const workspace of ['scratch', 'directory'] as const) {
      const p = buildAgentPrompt({
        task,
        instructions: null,
        workspace,
        readRoots: ['/docs'],
        brief: true,
      });
      expect(p).not.toMatch(/git|worktree|コミット|テスト/i);
      expect(p).toContain('/docs');
      expect(p).toContain('成果物');
    }
    expect(buildAgentPrompt({ task, instructions: null, workspace: 'worktree' })).toContain(
      'git worktree',
    );
  });
});

describe('driving its children', () => {
  it('a supervisor may message and retry its own children, never another tree', async () => {
    const h = await setup();
    const { d } = h;
    const mine = await supervisor(d, { title: 'A' });
    const theirs = await supervisor(d, { title: 'B' });
    const c = await d.call(mine.actor, 'session.spawn', {
      title: '要約',
      goal: `要約する${plan([{ type: 'write', path: 'summary.md', content: 'v1\n' }])}`,
      reviewBy: 'human',
    });
    const t = await taskSettles(h, c.session.id, 'review');
    // Redo: the same child and workspace, with the feedback.
    const retried = await d.call(mine.actor, 'task.retry', {
      taskId: t.id,
      feedback: 'もっと短く',
    });
    expect(retried).toMatchObject({ sessionId: c.session.id, workspaceId: c.session.workspaceId });
    const run = await d.ctx.service('runs').waitForEnd(retried.runId);
    expect(run).toMatchObject({ trigger: 'retry', retryOfRunId: c.runId, attempt: 2 });
    await taskSettles(h, c.session.id, 'review');
    expect(await codeOf(d.call(theirs.actor, 'task.retry', { taskId: t.id }))).toBe('forbidden');

    const sent = await d.call(mine.actor, 'session.send', {
      sessionId: c.session.id,
      content: 'ついでに見出しも',
    });
    expect(sent.delivery).toBe('started');
    await d.ctx.service('runs').waitForEnd(sent.runId!);
    expect(
      await codeOf(d.call(theirs.actor, 'session.send', { sessionId: c.session.id, content: 'x' })),
    ).toBe('forbidden');
  });
});

describe('code through session.spawn (the daemon side of e2e:slice)', () => {
  it('a code child is integrated, verified and applied once a human approves', async () => {
    const h = await setup();
    const { d } = h;
    const { repo, project } = await codeProject(d);
    const sup = await supervisor(d);
    const r = await d.call(sup.actor, 'session.spawn', {
      title: 'hello を追加',
      goal: `hello を追加する${plan([{ type: 'write', path: 'src/hello.txt', content: 'hello\n' }])}`,
      workspace: { kind: 'worktree', projectId: project.id },
    });
    const task = await taskSettles(h, r.session.id, 'review');
    const diff = d.ctx.repos.artifacts.findOne({ where: { task_id: task.id, kind: 'diff' } });
    expect(diff).toMatchObject({ kind: 'diff', runId: r.runId });
    const integ = await d.call(HUMAN, 'integration.create', {
      projectId: project.id,
      taskIds: [task.id],
    });
    await d.call(HUMAN, 'integration.run', { integrationId: integ.id });
    await until(() => {
      const i = d.ctx.repos.integrations.require(integ.id);
      if (i.status === 'failed' || i.status === 'conflict') throw new Error(i.status);
      return i.status === 'awaiting_approval';
    }, 60_000);
    const applied = await d.call(HUMAN, 'integration.approve', { integrationId: integ.id });
    expect(applied.status).toBe('applied');
    expect(await repo.git('show', 'main:src/hello.txt')).toBe('hello');
  });
});

describe('restart', () => {
  it('a child left waiting for a slot starts after a restart; an interrupted one waits to resume', async () => {
    const home = tempDir('acc-restart-');
    const first = await createTestDaemon({ home });
    let closed = false;
    cleanups.push(() => (closed ? undefined : first.close()));
    first.ctx.service('llm').mock.chunkDelayMs = 0;
    const slow = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
    vi.spyOn(first.ctx.service('runtimes').get('mock'), 'run').mockImplementation((i) =>
      slow.run(i),
    );
    const sup = await supervisor(first, { maxChildren: 1 });
    const a = await first.call(sup.actor, 'session.spawn', {
      title: 'A',
      goal: `a${plan([{ type: 'sleep', ms: 60_000 }])}`,
    });
    const b = await first.call(sup.actor, 'session.spawn', { title: 'B', goal: 'b' });
    expect(b.runId).toBeNull();
    await until(() => first.ctx.repos.runs.require(a.runId!).status === 'running');
    await first.close();
    closed = true;

    const second = await createTestDaemon({ home });
    cleanups.push(() => second.close());
    second.ctx.service('llm').mock.chunkDelayMs = 0;
    const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
    vi.spyOn(second.ctx.service('runtimes').get('mock'), 'run').mockImplementation((i) =>
      fast.run(i),
    );
    const doneB = await until(() => {
      const t = second.ctx.repos.tasks.require(
        second.ctx.repos.sessions.require(b.session.id).taskId!,
      );
      return t.status === 'done' && t;
    });
    expect(doneB.status).toBe('done');
    const taskA = second.ctx.repos.tasks.require(
      second.ctx.repos.sessions.require(a.session.id).taskId!,
    );
    expect(taskA).toMatchObject({ status: 'ready', statusReason: 'interrupted' });
  });
});

describe('session.create with a workspace', () => {
  it('creates scratch, folder and worktree agent sessions; chats take none', async () => {
    const h = await setup();
    const { d } = h;
    const s = await d.call(HUMAN, 'session.create', { kind: 'agent', workspace: { kind: 'none' } });
    expect(d.ctx.repos.workspaces.require(s.workspaceId!)).toMatchObject({
      kind: 'scratch',
      path: join(d.home, 'scratch', s.id),
    });
    const folder = tempDir('acc-folder-');
    const f = await d.call(HUMAN, 'session.create', {
      kind: 'agent',
      workspace: { kind: 'folder', path: folder },
    });
    expect(d.ctx.repos.workspaces.require(f.workspaceId!).kind).toBe('directory');
    const { project } = await codeProject(d);
    const w = await d.call(HUMAN, 'session.create', {
      kind: 'agent',
      workspace: { kind: 'worktree', projectId: project.id },
    });
    expect(w.projectId).toBe(project.id);
    expect(d.ctx.repos.workspaces.require(w.workspaceId!).kind).toBe('worktree');
    expect(
      await codeOf(
        d.call(HUMAN, 'session.create', {
          kind: 'chat',
          workspace: { kind: 'folder', path: folder },
        }),
      ),
    ).toBe('invalid_params');
    expect(
      (await d.call(HUMAN, 'session.create', { workspace: { kind: 'none' } })).workspaceId,
    ).toBeNull();
    // A scratch agent session runs without git.
    const sent = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: 'メモを書いて' });
    expect(await d.ctx.service('runs').waitForEnd(sent.runId!)).toMatchObject({
      status: 'completed',
    });
  });
});
