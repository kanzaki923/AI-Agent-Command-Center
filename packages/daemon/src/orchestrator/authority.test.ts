/**
 * The daemon, not the prompt, keeps agents inside what they were given: projects, budgets,
 * worker limits and delegation hold however the Control API calls are combined.
 */
import type { AgentActor } from '@acc/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunController } from '../contracts';
import { ApiError } from '../core/errors';
import { MockAgentRuntime } from '../runtime/mock/runtime';
import { HUMAN, type TestDaemonNoServer, agentActor, createTestDaemon } from '../testing';
import { type TempRepo, createTempRepo, isolateGitConfig } from '../workspace/git-fixture';

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

/** Resolves when `done` resolves or the run is stopped. */
function untilAborted(ctl: RunController, done: Promise<void> = new Promise(() => undefined)) {
  return Promise.race([
    done,
    new Promise<void>((r) => ctl.signal.addEventListener('abort', () => r(), { once: true })),
  ]);
}

async function setup(home?: string) {
  const d: TestDaemonNoServer = await createTestDaemon(home ? { home } : {});
  cleanups.push(() => d.cleanup());
  d.ctx.service('llm').mock.chunkDelayMs = 0;
  const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
  vi.spyOn(d.ctx.service('runtimes').get('mock'), 'run').mockImplementation((i) => fast.run(i));
  return d;
}

async function project(d: TestDaemonNoServer, name: string) {
  const repo: TempRepo = await createTempRepo();
  cleanups.push(() => repo.cleanup());
  return d.call(HUMAN, 'project.create', {
    name,
    repoPath: repo.path,
    defaultBranch: 'main',
  });
}

/** An orchestrator chat for `projectId` with a live orchestrator run that blocks. */
async function orchestrator(
  d: TestDaemonNoServer,
  projectId: string,
  opts: { maxWorkers?: number; budgetUsd?: number } = {},
) {
  const session = await d.call(HUMAN, 'session.create', { projectId, title: 'orch' });
  const granted = await d.call(HUMAN, 'session.grantOrchestration', {
    sessionId: session.id,
    lifetime: 'session',
    ...opts,
  });
  const runs: { release: () => void }[] = [];
  d.ctx.service('runs').registerExecutor('orchestrator', (ctl) => {
    let release!: () => void;
    const done = new Promise<void>((r) => (release = r));
    runs.push({ release });
    return untilAborted(ctl, done);
  });
  const startRun = async () => {
    const run = d.ctx.service('runs').start({
      sessionId: session.id,
      kind: 'orchestrator',
      createdBy: HUMAN,
      budgetId: granted.budget?.id ?? null,
    });
    await until(() => d.ctx.repos.runs.require(run.id).status === 'running');
    const actor: AgentActor = agentActor(session.id, run.id);
    const release = async () => {
      runs.at(-1)!.release();
      await d.ctx.service('runs').waitForEnd(run.id);
    };
    return { run, actor, release };
  };
  return { session, granted, startRun };
}

describe('agent authority', () => {
  it('maxWorkers of a session grant counts the workers of every run of that session', async () => {
    const d = await setup();
    const p = await project(d, 'a');
    d.ctx.service('runs').registerExecutor('agent', (ctl) => untilAborted(ctl));
    const orch = await orchestrator(d, p.id, { maxWorkers: 1 });
    const t1 = await d.call(HUMAN, 'task.create', { projectId: p.id, title: 'one' });
    const t2 = await d.call(HUMAN, 'task.create', { projectId: p.id, title: 'two' });

    const r1 = await orch.startRun();
    const w1 = await d.call(r1.actor, 'task.spawnWorker', { taskId: t1.id });
    // The orchestrator's turn ends; its worker keeps going.
    await r1.release();
    expect(d.ctx.repos.runs.require(w1.runId).status).toBe('running');

    const r2 = await orch.startRun();
    expect(await codeOf(d.call(r2.actor, 'task.spawnWorker', { taskId: t2.id }))).toBe(
      'limit_exceeded',
    );
    await d.call(HUMAN, 'run.cancel', { runId: w1.runId });
    await d.ctx.service('runs').waitForEnd(w1.runId);
    expect(await codeOf(d.call(r2.actor, 'task.spawnWorker', { taskId: t2.id }))).toBe('ok');
    await r2.release();
  });

  it('a task cannot be pointed at, or retried in, a session outside the task', async () => {
    const d = await setup();
    const a = await project(d, 'a');
    const b = await project(d, 'b');
    const orch = await orchestrator(d, a.id, { budgetUsd: 1 });
    const r = await orch.startRun();
    const task = await d.call(r.actor, 'task.create', { projectId: a.id, title: 'work' });
    const first = await d.call(r.actor, 'task.spawnWorker', { taskId: task.id });
    await d.ctx.service('runs').waitForEnd(first.runId);
    expect(d.ctx.repos.tasks.require(task.id).status).toBe('review');

    // A strong session in project B, with its own big budget and a "*" session grant.
    const strong = await d.call(HUMAN, 'session.create', { projectId: b.id, kind: 'agent' });
    await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'session', sessionId: strong.id },
      permissions: ['*'],
      lifetime: 'session',
    });
    const other = await d.call(HUMAN, 'session.create', { projectId: a.id, kind: 'agent' });
    expect(
      await codeOf(
        d.call(r.actor, 'task.update', { taskId: task.id, assigneeSessionId: strong.id }),
      ),
    ).toBe('invalid_params');
    expect(
      await codeOf(
        d.call(r.actor, 'task.update', { taskId: task.id, assigneeSessionId: other.id }),
      ),
    ).toBe('forbidden');
    expect(d.ctx.repos.tasks.require(task.id).assigneeSessionId).toBe(first.sessionId);

    // Even with the assignee tampered with, task.retry does not adopt a foreign session.
    d.ctx.repos.tasks.update(task.id, (t) => ({ ...t, assigneeSessionId: strong.id }));
    const retried = await d.call(r.actor, 'task.retry', { taskId: task.id });
    expect(retried.sessionId).not.toBe(strong.id);
    const run = d.ctx.repos.runs.require(retried.runId);
    expect(d.ctx.repos.sessions.require(run.sessionId)).toMatchObject({
      projectId: a.id,
      taskId: task.id,
    });
    expect(d.ctx.service('budget').get(run.budgetId!).parentId).toBe(orch.granted.budget!.id);
    await d.ctx.service('runs').waitForEnd(retried.runId);
    await r.release();
  });

  it('agents start runs only in chat sessions they delegated, never in stronger ones', async () => {
    const d = await setup();
    const p = await project(d, 'a');
    const orch = await orchestrator(d, p.id);
    const r = await orch.startRun();
    await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'run', runId: r.run.id },
      permissions: ['session.*', 'run.*'],
      scope: { projectIds: [p.id] },
    });
    d.ctx.service('runs').registerExecutor('chat', (ctl) => untilAborted(ctl));

    // Someone else's orchestrator chat (session grant) and a plain chat the agent did not make.
    const strong = await d.call(HUMAN, 'session.create', { projectId: p.id, title: 'other orch' });
    await d.call(HUMAN, 'session.grantOrchestration', {
      sessionId: strong.id,
      lifetime: 'session',
    });
    const foreign = await d.call(HUMAN, 'session.create', { projectId: p.id });
    for (const target of [strong, foreign]) {
      expect(
        await codeOf(d.call(r.actor, 'session.send', { sessionId: target.id, content: 'go' })),
      ).toBe('forbidden');
    }
    expect(d.ctx.repos.runs.count({ where: { session_id: strong.id } })).toBe(0);

    // Its own delegated chat works.
    const mine = await d.call(r.actor, 'session.create', {
      projectId: p.id,
      parentSessionId: orch.session.id,
    });
    const sent = await d.call(r.actor, 'session.send', { sessionId: mine.id, content: 'go' });
    await d.call(HUMAN, 'run.cancel', { runId: sent.runId! });
    await d.ctx.service('runs').waitForEnd(sent.runId!);

    // A worker session is driven through task.retry only.
    const task = await d.call(r.actor, 'task.create', { projectId: p.id, title: 'w' });
    const w = await d.call(r.actor, 'task.spawnWorker', { taskId: task.id });
    await d.ctx.service('runs').waitForEnd(w.runId);
    expect(
      await codeOf(d.call(r.actor, 'session.send', { sessionId: w.sessionId, content: 'more' })),
    ).toBe('forbidden');
    expect(
      d.ctx.service('policy').assertCanSpawnWorker(r.actor, { projectId: p.id }),
    ).not.toBeNull();
    await r.release();
  });

  it('run.retry of a worker goes through task.retry; an integrator run cannot be retried', async () => {
    const d = await setup();
    const p = await project(d, 'a');
    const task = await d.call(HUMAN, 'task.create', { projectId: p.id, title: 'w' });
    d.ctx.service('runs').registerExecutor('agent', () => Promise.reject(new Error('boom')));
    const first = await d.call(HUMAN, 'task.spawnWorker', { taskId: task.id });
    await d.ctx.service('runs').waitForEnd(first.runId);
    expect(d.ctx.repos.tasks.require(task.id).status).toBe('failed');

    let finish!: () => void;
    d.ctx
      .service('runs')
      .registerExecutor('agent', (ctl) =>
        untilAborted(ctl, new Promise<void>((r) => (finish = r))),
      );
    const retried = await d.call(HUMAN, 'run.retry', { runId: first.runId });
    expect(d.ctx.repos.runs.require(retried.runId)).toMatchObject({
      sessionId: first.sessionId,
      retryOfRunId: first.runId,
    });
    expect(d.ctx.repos.tasks.require(task.id).status).toBe('running');
    await until(() => d.ctx.repos.runs.require(retried.runId).status === 'running');
    finish();
    await d.ctx.service('runs').waitForEnd(retried.runId);
    expect(d.ctx.repos.tasks.require(task.id).status).toBe('review');

    // An integrator's run (no task) belongs to its integration.
    const ws = await d.call(HUMAN, 'workspace.create', { projectId: p.id });
    const integ = await d.call(HUMAN, 'integration.create', {
      projectId: p.id,
      workspaceIds: [ws.id],
    });
    const s = await d.call(HUMAN, 'session.create', { projectId: p.id, kind: 'agent' });
    d.ctx.service('runs').registerExecutor('agent', () => Promise.reject(new Error('boom')));
    const resolver = d.ctx.service('runs').start({
      sessionId: s.id,
      kind: 'agent',
      createdBy: HUMAN,
      workspaceId: integ.workspaceId,
    });
    await d.ctx.service('runs').waitForEnd(resolver.id);
    d.ctx.repos.integrations.update(integ.id, (i) => ({ ...i, resolverRunId: resolver.id }));
    expect(await codeOf(d.call(HUMAN, 'run.retry', { runId: resolver.id }))).toBe('conflict');
  });

  it('a budget in use cannot be released, and spend that cannot be booked stops the run', async () => {
    const d = await setup();
    const p = await project(d, 'a');
    const session = await d.call(HUMAN, 'session.create', { projectId: p.id, kind: 'agent' });
    const budget = d.ctx.service('budget');
    const root = budget.createRoot({
      subject: { kind: 'session', id: session.id },
      limitUsd: 1,
      actor: HUMAN,
    });
    let ctl!: RunController;
    d.ctx.service('runs').registerExecutor('agent', (c) => {
      ctl = c;
      return untilAborted(c);
    });
    const run = d.ctx.service('runs').start({
      sessionId: session.id,
      kind: 'agent',
      createdBy: HUMAN,
      budgetId: root.id,
    });
    await until(() => d.ctx.repos.runs.require(run.id).status === 'running');
    expect(await codeOf(d.call(HUMAN, 'budget.release', { budgetId: root.id }))).toBe('conflict');
    expect(budget.get(root.id).status).toBe('active');

    // Released behind its back (e.g. an older daemon): the next spend stops the run.
    d.ctx.repos.budgets.update(root.id, (b) => ({ ...b, status: 'released' }));
    expect(() => ctl.assertBudgetLeft()).toThrow(ApiError);
    ctl.reportUsage({ inputTokens: 10, outputTokens: 10, costUsd: 0.1, costSource: 'reported' });
    const ended = await d.ctx.service('runs').waitForEnd(run.id);
    expect(ended).toMatchObject({ status: 'failed', statusReason: 'budget_exhausted' });
    expect(ended.usage.costUsd).toBeCloseTo(0.1);

    // And no new run may use it.
    expect(() =>
      d.ctx.service('runs').start({
        sessionId: session.id,
        kind: 'agent',
        createdBy: HUMAN,
        budgetId: root.id,
      }),
    ).toThrow(ApiError);
  });

  it('a session run-lifetime grant (read as work) survives the run a crash interrupted', async () => {
    const d1 = await setup();
    const p = await project(d1, 'a');
    const session = await d1.call(HUMAN, 'session.create', { projectId: p.id, title: 'orch' });
    const { grant } = await d1.call(HUMAN, 'session.grantOrchestration', {
      sessionId: session.id,
      lifetime: 'run',
    });
    // The orchestrator run the crash cuts off: still "running" on disk, unknown to the
    // run manager, so the clean close below does not end it (as a kill would not).
    const now = d1.ctx.clock.iso();
    d1.ctx.repos.runs.insert({
      id: d1.ctx.ids.next('run'),
      sessionId: session.id,
      projectId: p.id,
      taskId: null,
      kind: 'orchestrator',
      status: 'running',
      statusReason: null,
      model: 'mock/orchestrator',
      runtime: null,
      workspaceId: null,
      parentRunId: null,
      retryOfRunId: null,
      attempt: 1,
      budgetId: null,
      triggerMessageId: null,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'unknown' },
      error: null,
      activity: null,
      createdBy: HUMAN,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      endedAt: null,
    });
    const home = d1.home;
    await d1.close();

    const d2 = await setup(home);
    // D17: a restart ends no work; the interrupted orchestrator keeps its authority.
    expect(d2.ctx.repos.grants.require(grant.id).revokedAt).toBeNull();
    const runs = d2.ctx.repos.runs.find({ where: { session_id: session.id } });
    expect(runs.find((r) => r.status === 'interrupted')?.statusReason).toBe('daemon_restart');
    await d2.close();
  });

  it("a session's workspace and task stay in the session's project", async () => {
    const d = await setup();
    const a = await project(d, 'a');
    const b = await project(d, 'b');
    const wsB = await d.call(HUMAN, 'workspace.create', { projectId: b.id });
    const taskB = await d.call(HUMAN, 'task.create', { projectId: b.id, title: 'b' });
    const s = await d.call(HUMAN, 'session.create', { projectId: a.id, kind: 'agent' });
    expect(
      await codeOf(d.call(HUMAN, 'session.update', { sessionId: s.id, workspaceId: wsB.id })),
    ).toBe('invalid_params');
    expect(
      await codeOf(
        d.call(HUMAN, 'session.create', { projectId: a.id, kind: 'agent', taskId: taskB.id }),
      ),
    ).toBe('invalid_params');
    const wsA = await d.call(HUMAN, 'workspace.create', { projectId: a.id });
    await d.call(HUMAN, 'session.update', { sessionId: s.id, workspaceId: wsA.id });
    // Moving the session would strand its workspace in the old project.
    expect(
      await codeOf(d.call(HUMAN, 'session.update', { sessionId: s.id, projectId: b.id })),
    ).toBe('invalid_params');
  });
});
