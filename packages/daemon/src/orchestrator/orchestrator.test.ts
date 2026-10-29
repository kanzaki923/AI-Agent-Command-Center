import { existsSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { AgentActor, Event, Run } from '@acc/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunInput, RunController } from '../contracts';
import { ApiError } from '../core/errors';
import { MockAgentRuntime } from '../runtime/mock/runtime';
import { HUMAN, type TestDaemonNoServer, agentActor, createTestDaemon } from '../testing';
import { type TempRepo, createTempRepo, isolateGitConfig } from '../workspace/git-fixture';
import { DEMO_SESSION_TITLE } from './demo';
import { buildOrchestratorPrompt } from './executor';
import { ORCHESTRATOR_PERMISSIONS } from './grant';
import { MOCK_ORCHESTRATOR_MODEL } from './mockModel';
import { WORKER_DEFAULT_PERMISSIONS } from './workers';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

let restoreGit: () => void;
beforeAll(() => {
  restoreGit = isolateGitConfig();
});
afterAll(() => restoreGit());

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 20_000): Promise<T> {
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

async function setup(opts: { fastMock?: boolean } = {}) {
  const repo: TempRepo = await createTempRepo();
  cleanups.push(() => repo.cleanup());
  const d: TestDaemonNoServer = await createTestDaemon();
  cleanups.push(() => d.cleanup());
  d.ctx.service('llm').mock.chunkDelayMs = 0;
  if (opts.fastMock !== false) {
    const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
    vi.spyOn(d.ctx.service('runtimes').get('mock'), 'run').mockImplementation((i) => fast.run(i));
  }
  const project = await d.call(HUMAN, 'project.create', {
    name: 'p',
    repoPath: repo.path,
    defaultBranch: 'main',
    testCommand: 'node -e "process.exit(0)"',
  });
  return { d, repo, project };
}

/** A chat session with the orchestrator grant and a live orchestrator run that blocks. */
async function orchestrator(d: TestDaemonNoServer, projectId: string, budgetUsd?: number) {
  const session = await d.call(HUMAN, 'session.create', { projectId, title: 'orch' });
  const granted = await d.call(HUMAN, 'session.grantOrchestration', {
    sessionId: session.id,
    lifetime: 'session',
    ...(budgetUsd ? { budgetUsd } : {}),
  });
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  d.ctx.service('runs').registerExecutor('orchestrator', (ctl) => untilAborted(ctl, done));
  const run = d.ctx.service('runs').start({
    sessionId: session.id,
    kind: 'orchestrator',
    createdBy: HUMAN,
    budgetId: granted.budget?.id ?? null,
  });
  await until(() => d.ctx.repos.runs.require(run.id).status === 'running');
  const actor: AgentActor = agentActor(session.id, run.id);
  return { session, run, actor, granted, release };
}

/** Resolves when `done` resolves or the run is stopped (so shutdown never waits on it). */
function untilAborted(ctl: RunController, done: Promise<void> = new Promise(() => undefined)) {
  return Promise.race([
    done,
    new Promise<void>((r) => ctl.signal.addEventListener('abort', () => r(), { once: true })),
  ]);
}

const plan = (steps: unknown[]) => ['```acc-mock', JSON.stringify({ steps }), '```'].join('\n');

describe('task.spawnWorker', () => {
  it('starts a worker in its own worktree; the task goes running → review with the diff', async () => {
    const { d, repo, project } = await setup();
    const task = await d.call(HUMAN, 'task.create', {
      projectId: project.id,
      title: 'Write notes',
      description: plan([{ type: 'write', path: 'notes.md', content: '# notes\n' }]),
    });
    const r = await d.call(HUMAN, 'task.spawnWorker', { taskId: task.id });
    const session = d.ctx.repos.sessions.require(r.sessionId);
    expect(session).toMatchObject({
      kind: 'agent',
      taskId: task.id,
      workspaceId: r.workspaceId,
      parentSessionId: null,
      runtime: 'mock',
    });
    expect(d.ctx.repos.tasks.require(task.id)).toMatchObject({
      status: 'running',
      assigneeSessionId: r.sessionId,
      workspaceId: r.workspaceId,
    });
    const run = await d.ctx.service('runs').waitForEnd(r.runId);
    expect(run).toMatchObject({ status: 'completed', runtime: 'mock', parentRunId: null });

    const reviewed = await until(() => {
      const t = d.ctx.repos.tasks.require(task.id);
      return t.status === 'review' ? t : null;
    });
    expect(reviewed.statusReason).toBeNull();
    expect(reviewed.resultSummary).toBeTruthy();
    const ws = d.ctx.repos.workspaces.require(r.workspaceId);
    expect(await repo.git('show', `${ws.branch}:notes.md`)).toBe('# notes');

    const wait = await d.call(HUMAN, 'task.wait', { taskIds: [task.id], timeoutMs: 0 });
    expect(wait.timedOut).toBe(false);
    expect(wait.reached).toEqual([task.id]);
    expect(wait.tasks[0]).toMatchObject({
      status: 'review',
      branch: ws.branch,
      pendingApprovals: 0,
      diff: { files: 1, additions: 1, deletions: 0 },
      run: { id: r.runId, status: 'completed' },
    });

    const decisions = d.ctx.bus.list({ types: ['orchestrator.decision'] }).events;
    expect(decisions.map((e) => e.type === 'orchestrator.decision' && e.payload.decision)).toEqual([
      'Worker を起動しました: Write notes',
      'Task をレビュー待ちにしました: Write notes',
    ]);
  });

  it('refuses tasks that are running, waiting on dependencies, or finished', async () => {
    const { d, project } = await setup();
    const a = await d.call(HUMAN, 'task.create', { projectId: project.id, title: 'a' });
    const b = await d.call(HUMAN, 'task.create', {
      projectId: project.id,
      title: 'b',
      dependsOn: [a.id],
    });
    expect(await codeOf(d.call(HUMAN, 'task.spawnWorker', { taskId: b.id }))).toBe('conflict');
    await d.call(HUMAN, 'task.update', { taskId: a.id, status: 'done' });
    expect(await codeOf(d.call(HUMAN, 'task.spawnWorker', { taskId: a.id }))).toBe('conflict');
    expect(await codeOf(d.call(HUMAN, 'task.spawnWorker', { taskId: b.id, runtime: 'nope' }))).toBe(
      'not_found',
    );
  });

  it('a failed worker fails the task (worktree kept); spawning again reuses the worktree', async () => {
    const { d, project } = await setup();
    const task = await d.call(HUMAN, 'task.create', {
      projectId: project.id,
      title: 'Breaks',
      description: plan([{ type: 'fail', message: 'ビルドが通りません' }]),
    });
    const first = await d.call(HUMAN, 'task.spawnWorker', { taskId: task.id });
    await d.ctx.service('runs').waitForEnd(first.runId);
    const failed = await until(() => {
      const t = d.ctx.repos.tasks.require(task.id);
      return t.status === 'failed' ? t : null;
    });
    expect(failed).toMatchObject({
      statusReason: 'worker_failed',
      resultSummary: 'ビルドが通りません',
    });
    expect(d.ctx.repos.workspaces.require(first.workspaceId).status).toBe('ready');

    const second = await d.call(HUMAN, 'task.spawnWorker', { taskId: task.id });
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.sessionId).not.toBe(first.sessionId);
    await d.ctx.service('runs').waitForEnd(second.runId);
  });

  it('a cancelled task stays cancelled when its worker stops', async () => {
    const { d, project } = await setup();
    const task = await d.call(HUMAN, 'task.create', {
      projectId: project.id,
      title: 'Long',
      description: plan([{ type: 'sleep', ms: 60_000 }]),
    });
    const r = await d.call(HUMAN, 'task.spawnWorker', { taskId: task.id });
    await until(() => d.ctx.repos.runs.require(r.runId).status === 'running');
    await d.call(HUMAN, 'task.cancel', { taskId: task.id });
    expect((await d.ctx.service('runs').waitForEnd(r.runId)).status).toBe('cancelled');
    expect(d.ctx.repos.tasks.require(task.id).status).toBe('cancelled');
  });

  it('agents: limits from the grant, a delegated worker grant, a budget slice — and workers cannot delegate', async () => {
    const { d, project } = await setup();
    // Workers that block until released, so they stay "active".
    let releaseWorkers!: () => void;
    const workersDone = new Promise<void>((r) => (releaseWorkers = r));
    const started: RunController[] = [];
    d.ctx.service('runs').registerExecutor('agent', (ctl) => {
      started.push(ctl);
      return untilAborted(ctl, workersDone);
    });
    const orch = await orchestrator(d, project.id, 10);
    const tasks = await Promise.all(
      ['a', 'b', 'c'].map((title) =>
        d.call(orch.actor, 'task.create', { projectId: project.id, title }),
      ),
    );
    const w1 = await d.call(orch.actor, 'task.spawnWorker', { taskId: tasks[0]!.id });
    const w2 = await d.call(orch.actor, 'task.spawnWorker', { taskId: tasks[1]!.id, budgetUsd: 1 });
    // maxWorkers 2 (default of grantOrchestration).
    expect(await codeOf(d.call(orch.actor, 'task.spawnWorker', { taskId: tasks[2]!.id }))).toBe(
      'limit_exceeded',
    );

    // Budget: an equal share of what was free for the first (2 worker slots + 1 share the
    // orchestrator keeps for its own calls), the requested $1 for the second.
    const budget = d.ctx.service('budget');
    expect(budget.get(w1.budgetId!)).toMatchObject({
      limitUsd: 3.333333,
      parentId: orch.granted.budget!.id,
    });
    expect(budget.get(w2.budgetId!).limitUsd).toBe(1);

    // The worker's grant: delegated, depth 1, cannot delegate further.
    const run1 = d.ctx.repos.runs.require(w1.runId);
    expect(run1.parentRunId).toBe(orch.run.id);
    expect(d.ctx.repos.sessions.require(w1.sessionId).parentSessionId).toBe(orch.session.id);
    const workerGrants = await d.call(HUMAN, 'grant.list', { runId: w1.runId });
    expect(workerGrants.items).toHaveLength(1);
    expect(workerGrants.items[0]).toMatchObject({
      depth: 1,
      parentGrantId: orch.granted.grant.id,
      permissions: [...WORKER_DEFAULT_PERMISSIONS],
      limits: { maxWorkers: 0, maxDepth: 0 },
      scope: { projectIds: [project.id] },
    });
    const worker = agentActor(w1.sessionId, w1.runId);
    expect(await codeOf(d.call(worker, 'task.get', { taskId: tasks[0]!.id }))).toBe('ok');
    expect(await codeOf(d.call(worker, 'task.spawnWorker', { taskId: tasks[2]!.id }))).toBe(
      'forbidden',
    );
    expect(
      await codeOf(
        d.call(worker, 'grant.create', {
          subject: { kind: 'run', runId: w1.runId },
          permissions: ['task.get'],
        }),
      ),
    ).toBe('forbidden');
    releaseWorkers();
    await d.ctx.service('runs').waitForEnd(w1.runId);
    await d.ctx.service('runs').waitForEnd(w2.runId);
    expect(started).toHaveLength(2);

    // A slot is free again. Even a worker handed task.spawnWorker cannot use it (depth).
    d.ctx.service('runs').registerExecutor('agent', (ctl) => untilAborted(ctl));
    const w3 = await d.call(orch.actor, 'task.spawnWorker', {
      taskId: tasks[2]!.id,
      permissions: ['task.spawnWorker'],
    });
    const w3actor = agentActor(w3.sessionId, w3.runId);
    const extra = await d.call(HUMAN, 'task.create', { projectId: project.id, title: 'd' });
    expect(await codeOf(d.call(w3actor, 'task.spawnWorker', { taskId: extra.id }))).toBe(
      'limit_exceeded',
    );
    await d.call(HUMAN, 'run.cancel', { runId: w3.runId });
    orch.release();
  });

  it('agents outside the grant scope or without a grant are refused', async () => {
    const { d, project } = await setup();
    const session = await d.call(HUMAN, 'session.create', { projectId: project.id });
    d.ctx.service('runs').registerExecutor('chat', (ctl) => untilAborted(ctl));
    const run = d.ctx
      .service('runs')
      .start({ sessionId: session.id, kind: 'chat', createdBy: HUMAN });
    const task = await d.call(HUMAN, 'task.create', { projectId: project.id, title: 't' });
    expect(
      await codeOf(d.call(agentActor(session.id, run.id), 'task.spawnWorker', { taskId: task.id })),
    ).toBe('forbidden');
    await d.call(HUMAN, 'run.cancel', { runId: run.id });
  });
});

describe('task.wait / integration.wait', () => {
  it('waits for any or all, times out with a snapshot, and stops when aborted', async () => {
    const { d, project } = await setup();
    const a = await d.call(HUMAN, 'task.create', { projectId: project.id, title: 'a' });
    const b = await d.call(HUMAN, 'task.create', { projectId: project.id, title: 'b' });

    const timedOut = await d.call(HUMAN, 'task.wait', { taskIds: [a.id, b.id], timeoutMs: 30 });
    expect(timedOut).toMatchObject({ timedOut: true, reached: [] });
    expect(timedOut.tasks.map((t) => t.status)).toEqual(['ready', 'ready']);

    const any = d.call(HUMAN, 'task.wait', { taskIds: [a.id, b.id], timeoutMs: 10_000 });
    const all = d.call(HUMAN, 'task.wait', {
      taskIds: [a.id, b.id],
      mode: 'all',
      timeoutMs: 10_000,
    });
    await d.call(HUMAN, 'task.update', { taskId: a.id, status: 'review' });
    expect(await any).toMatchObject({ timedOut: false, reached: [a.id] });
    await d.call(HUMAN, 'task.update', { taskId: b.id, status: 'blocked' });
    expect(await all).toMatchObject({ timedOut: false, reached: [a.id, b.id] });

    const terminal = await d.call(HUMAN, 'task.wait', {
      taskIds: [a.id],
      until: 'terminal',
      timeoutMs: 0,
    });
    expect(terminal.timedOut).toBe(true);

    const ac = new AbortController();
    const aborted = d.ctx.call(
      HUMAN,
      'task.wait',
      { taskIds: [a.id], until: 'terminal', timeoutMs: 600_000 },
      { signal: ac.signal },
    );
    ac.abort();
    expect((await aborted).timedOut).toBe(true);
    expect(
      await codeOf(d.call(HUMAN, 'task.wait', { taskIds: ['tsk_00000000000000000000000000'] })),
    ).toBe('not_found');
  });

  it('integration.wait returns when the integration settles', async () => {
    const { d, project } = await setup();
    const task = await d.call(HUMAN, 'task.create', {
      projectId: project.id,
      title: 'Change',
      description: plan([{ type: 'write', path: 'x.txt', content: 'x\n' }]),
    });
    const r = await d.call(HUMAN, 'task.spawnWorker', { taskId: task.id });
    await d.ctx.service('runs').waitForEnd(r.runId);
    await until(() => d.ctx.repos.tasks.require(task.id).status === 'review');
    const integ = await d.call(HUMAN, 'integration.create', {
      projectId: project.id,
      taskIds: [task.id],
    });
    const early = await d.call(HUMAN, 'integration.wait', {
      integrationId: integ.id,
      timeoutMs: 0,
    });
    expect(early).toMatchObject({ timedOut: true, integration: { status: 'pending' } });
    await d.call(HUMAN, 'integration.run', { integrationId: integ.id });
    const settled = await d.call(HUMAN, 'integration.wait', {
      integrationId: integ.id,
      timeoutMs: 60_000,
    });
    expect(settled).toMatchObject({
      timedOut: false,
      integration: { status: 'awaiting_approval' },
    });
  });
});

describe('orchestrator role', () => {
  it('grantOrchestration: preset for one project, humans only, chat sessions only', async () => {
    const { d, project } = await setup();
    const chat = await d.call(HUMAN, 'session.create', { projectId: project.id });
    const { grant, budget } = await d.call(HUMAN, 'session.grantOrchestration', {
      sessionId: chat.id,
      budgetUsd: 3,
    });
    expect(grant).toMatchObject({
      subject: { kind: 'session', sessionId: chat.id },
      permissions: [...ORCHESTRATOR_PERMISSIONS],
      scope: { projectIds: [project.id] },
      limits: { maxWorkers: 2, maxDepth: 1 },
      lifetime: 'run',
      depth: 0,
    });
    expect(grant.permissions).not.toContain('integration.approve');
    expect(budget).toMatchObject({ limitUsd: 3, subject: { kind: 'session', id: chat.id } });

    // The next message runs as an orchestrator with the session budget.
    const { runId } = await d.call(HUMAN, 'session.send', { sessionId: chat.id, content: 'hi' });
    const run = d.ctx.repos.runs.require(runId!);
    expect(run).toMatchObject({ kind: 'orchestrator', budgetId: budget!.id });
    await d.ctx.service('runs').waitForEnd(runId!);
    // lifetime "run": afterwards it is a plain chat again.
    const next = await d.call(HUMAN, 'session.send', { sessionId: chat.id, content: 'again' });
    expect(d.ctx.repos.runs.require(next.runId!).kind).toBe('chat');
    await d.ctx.service('runs').waitForEnd(next.runId!);

    const agentSession = await d.call(HUMAN, 'session.create', {
      projectId: project.id,
      kind: 'agent',
    });
    expect(
      await codeOf(d.call(HUMAN, 'session.grantOrchestration', { sessionId: agentSession.id })),
    ).toBe('invalid_params');
    const noProject = await d.call(HUMAN, 'session.create', {});
    expect(
      await codeOf(d.call(HUMAN, 'session.grantOrchestration', { sessionId: noProject.id })),
    ).toBe('invalid_params');
    const orch = await orchestrator(d, project.id);
    expect(
      await codeOf(d.call(orch.actor, 'session.grantOrchestration', { sessionId: chat.id })),
    ).toBe('forbidden');
    orch.release();
  });

  it('the orchestrator prompt names the project, the limits and the rules', () => {
    const prompt = buildOrchestratorPrompt({
      project: {
        id: 'prj_00000000000000000000000000',
        name: 'demo',
        defaultBranch: 'main',
        testCommand: 'node --test',
      } as never,
      grant: { limits: { maxWorkers: 2 } } as never,
    });
    expect(prompt).toContain('projectId: prj_00000000000000000000000000');
    expect(prompt).toContain('at most 2 workers');
    expect(prompt).toContain('task.wait');
    expect(prompt).toContain('never edit code');
    expect(prompt).toContain('Japanese');
  });

  it('records decisions on the timeline with the run refs', async () => {
    const { d, project } = await setup();
    const orch = await orchestrator(d, project.id);
    await d.call(orch.actor, 'orchestrator.recordDecision', {
      decision: '2つに分ける',
      rationale: '独立しているため',
    });
    const e = d.ctx.bus.list({ types: ['orchestrator.decision'] }).events[0] as Event;
    expect(e).toMatchObject({
      actor: orch.actor,
      projectId: project.id,
      sessionId: orch.session.id,
      runId: orch.run.id,
      payload: { decision: '2つに分ける', rationale: '独立しているため' },
    });
    orch.release();
  });

  it('mock/orchestrator without orchestration tools answers as a plain chat', async () => {
    const { d, project } = await setup();
    const s = await d.call(HUMAN, 'session.create', {
      projectId: project.id,
      model: MOCK_ORCHESTRATOR_MODEL,
    });
    const { runId } = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: 'やって' });
    expect((await d.ctx.service('runs').waitForEnd(runId!)).kind).toBe('chat');
    const msgs = await d.call(HUMAN, 'session.messages', { sessionId: s.id });
    const reply = msgs.items.at(-1)!.content[0];
    expect(reply?.type === 'text' && reply.text).toContain('Orchestrator の権限がない');
    expect(d.ctx.repos.tasks.count({})).toBe(0);
  });
});

describe('real path (no network)', () => {
  it('with LiteLLM configured, an orchestrator run sends the Control API tools to the gateway', async () => {
    const { d, project } = await setup();
    const bodies: string[] = [];
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        bodies.push(body);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '了解です' } }] })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => server.close(r)));
    const port = (server.address() as AddressInfo).port;
    await d.call(HUMAN, 'settings.update', {
      litellm: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-fake-0000000000' },
    });
    const s = await d.call(HUMAN, 'session.create', { projectId: project.id, model: 'gpt-real' });
    await d.call(HUMAN, 'session.grantOrchestration', { sessionId: s.id });
    const { runId } = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: '進めて' });
    const run = await d.ctx.service('runs').waitForEnd(runId!);
    expect(run).toMatchObject({ status: 'completed', kind: 'orchestrator', model: 'gpt-real' });

    const sent = JSON.parse(bodies[0]!) as {
      model: string;
      messages: { role: string; content: string }[];
      tools: { function: { name: string } }[];
    };
    expect(sent.model).toBe('gpt-real');
    expect(sent.messages[0]!.role).toBe('system');
    expect(sent.messages[0]!.content).toContain(`projectId: ${project.id}`);
    const names = sent.tools.map((t) => t.function.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'task__create',
        'task__spawnWorker',
        'task__wait',
        'integration__create',
        'integration__run',
        'integration__wait',
        'orchestrator__recordDecision',
      ]),
    );
    expect(names).not.toContain('integration__approve');
    expect(names).not.toContain('grant__create');
    expect(names).not.toContain('settings__update');
  });

  it('workers use the claude-agent-sdk runtime when it is selected', async () => {
    const { d, project } = await setup();
    const claude = d.ctx.service('runtimes').get('claude-agent-sdk');
    vi.spyOn(claude, 'available').mockResolvedValue({ ok: true });
    const inputs: AgentRunInput[] = [];
    vi.spyOn(claude, 'run').mockImplementation((input) => {
      inputs.push(input);
      return (async function* (): AsyncGenerator<AgentEvent> {
        yield {
          type: 'message',
          messageId: 'm1',
          role: 'assistant',
          content: [{ type: 'text', text: '確認しました' }],
        };
      })();
    });
    await d.call(HUMAN, 'settings.update', { defaultRuntime: 'claude-agent-sdk' });
    const task = await d.call(HUMAN, 'task.create', { projectId: project.id, title: 'Look' });
    const r = await d.call(HUMAN, 'task.spawnWorker', { taskId: task.id, model: 'claude-x' });
    const run: Run = await d.ctx.service('runs').waitForEnd(r.runId);
    expect(run).toMatchObject({
      status: 'completed',
      runtime: 'claude-agent-sdk',
      model: 'claude-x',
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.cwd).toBe(d.ctx.repos.workspaces.require(r.workspaceId).path);
    expect(inputs[0]!.prompt).toContain('# タスク: Look');
    const reviewed = await until(() => {
      const t = d.ctx.repos.tasks.require(task.id);
      return t.status === 'review' ? t : null;
    });
    expect(reviewed).toMatchObject({ statusReason: 'no_changes', resultSummary: '確認しました' });
  });
});

describe('system.setupDemo', () => {
  it('creates a demo folder, project and a delegated chat once (idempotent, no git)', async () => {
    const d = await createTestDaemon();
    cleanups.push(() => d.cleanup());
    const first = await d.call(HUMAN, 'system.setupDemo', {});
    expect(first.created).toBe(true);
    expect(first.repoPath).toBe(join(d.home, 'demo', 'launch-demo'));
    expect(existsSync(join(first.repoPath, 'brief.md'))).toBe(true);
    expect(existsSync(join(first.repoPath, '.git'))).toBe(false);
    expect(first.project).toMatchObject({ folderPath: first.repoPath, repoPath: null });
    expect(first.session).toMatchObject({
      kind: 'chat',
      title: DEMO_SESSION_TITLE,
      model: MOCK_ORCHESTRATOR_MODEL,
      projectId: first.project.id,
    });
    expect(first.grant).toMatchObject({
      lifetime: 'session',
      scope: { projectIds: [first.project.id] },
      limits: { maxChildren: 4, maxDepth: 1 },
    });
    // A folder project: no code permissions in the preset.
    expect(first.grant.permissions).toContain('session.spawn');
    expect(first.grant.permissions).not.toContain('integration.create');

    const again = await d.call(HUMAN, 'system.setupDemo', {});
    expect(again).toMatchObject({
      created: false,
      repoPath: first.repoPath,
      project: { id: first.project.id },
      session: { id: first.session.id },
      grant: { id: first.grant.id },
    });
    expect((await d.call(HUMAN, 'project.list', {})).items).toHaveLength(1);
    // The next message to the demo chat runs as a supervisor.
    expect(d.ctx.service('policy').sessionAllows(first.session.id, 'session.spawn')).toBe(true);
  });
});
