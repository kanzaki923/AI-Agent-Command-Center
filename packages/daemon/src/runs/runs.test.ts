import type { Event, Run, Workspace } from '@acc/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunController, RunsService, WorkspaceLock, WorkspacesService } from '../contracts';
import { conflict, invalidParams } from '../core/errors';
import { defineModule } from '../module';
import { modules } from '../modules';
import {
  HUMAN,
  type TestDaemonNoServer,
  agentActor,
  createTestDaemon,
  insertTestTask,
} from '../testing';
import { createTempRepo, isolateGitConfig } from '../workspace/git-fixture';
import { mergeUsage } from './manager';

let d: TestDaemonNoServer | null = null;
const removeHomes: (() => void)[] = [];
afterEach(async () => {
  await d?.cleanup();
  d = null;
  for (const fn of removeHomes.splice(0)) fn();
});

/** Close the current daemon and start a new one on the same ACC_HOME. */
async function restart(): Promise<TestDaemonNoServer> {
  const first = d!;
  await first.close();
  removeHomes.push(() => first.removeHome());
  d = await createTestDaemon({ home: first.home });
  return d;
}

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until<T>(fn: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Rejects when the signal aborts, like a real executor would. */
const aborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    const fail = () => reject(new DOMException('aborted', 'AbortError'));
    if (signal.aborted) fail();
    signal.addEventListener('abort', fail, { once: true });
  });

/**
 * Executor for kind "agent" whose runs block until the test finishes them.
 * `ctl[runId]` gives the controller, `finish(runId)` / `fail(runId, err)` end the run.
 */
function blockingExecutor(runs: RunsService) {
  const ctls = new Map<string, RunController>();
  const gates = new Map<string, Deferred>();
  const order: string[] = [];
  runs.registerExecutor('agent', async (ctl) => {
    order.push(ctl.run.id);
    ctls.set(ctl.run.id, ctl);
    const g = deferred();
    gates.set(ctl.run.id, g);
    await Promise.race([g.promise, aborted(ctl.signal)]);
  });
  return {
    ctls,
    order,
    started: (id: string) => gates.has(id),
    finish: (id: string) => gates.get(id)!.resolve(),
    fail: (id: string, err: unknown) => gates.get(id)!.reject(err),
  };
}

const newSession = (daemon: TestDaemonNoServer) => daemon.call(HUMAN, 'session.create', {});

function startAgentRun(daemon: TestDaemonNoServer, sessionId: string, extra: Partial<Run> = {}) {
  return daemon.ctx.service('runs').start({
    sessionId,
    kind: 'agent',
    createdBy: HUMAN,
    workspaceId: extra.workspaceId ?? null,
    budgetId: extra.budgetId ?? null,
  });
}

const status = (daemon: TestDaemonNoServer, id: string) => daemon.ctx.repos.runs.require(id).status;

function runEvents(daemon: TestDaemonNoServer, runId: string): string[] {
  return daemon.ctx.bus
    .list({ runId, limit: 1000 })
    .events.map((e: Event) =>
      e.type === 'run.status_changed' ? `${e.payload.from}->${e.payload.to}` : e.type,
    );
}

// ---------------------------------------------------------------------------

describe('run lifecycle', () => {
  it('created → queued → running → completed with events, activity and session.activeRunId', async () => {
    d = await createTestDaemon();
    const runs = d.ctx.service('runs');
    const ex = blockingExecutor(runs);
    const s = await newSession(d);
    const run = startAgentRun(d, s.id);
    expect(run).toMatchObject({ status: 'queued', attempt: 1, kind: 'agent' });
    expect(d.ctx.repos.sessions.require(s.id).activeRunId).toBe(run.id);
    await until(() => ex.started(run.id));
    expect(status(d, run.id)).toBe('running');

    const ctl = ex.ctls.get(run.id)!;
    expect(ctl.actor).toEqual(agentActor(s.id, run.id));
    ctl.setActivity('npm test を実行中');
    ctl.setActivity('npm test を実行中'); // no-op
    expect(d.ctx.repos.runs.require(run.id).activity).toBe('npm test を実行中');
    const deltas: number[] = [];
    const off = d.ctx.bus.subscribeDeltas({ runId: run.id }, (x) => deltas.push(x.index));
    const mid = d.ctx.ids.next('message');
    ctl.emitDelta(mid, 'a');
    ctl.emitDelta(mid, 'b');
    off();
    expect(deltas).toEqual([0, 1]);
    ctl.toolCalled({ toolCallId: 't1', name: 'bash', input: { cmd: 'ls' } });
    ctl.toolResult({ toolCallId: 't1', name: 'bash', output: 'ok' });
    ctl.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'done' }] });

    const ended = runs.waitForEnd(run.id);
    ex.finish(run.id);
    const final = await ended;
    expect(final).toMatchObject({ status: 'completed', activity: null, statusReason: null });
    expect(final.startedAt).not.toBeNull();
    expect(final.endedAt).not.toBeNull();
    expect(d.ctx.repos.sessions.require(s.id).activeRunId).toBeNull();
    expect(runEvents(d, run.id)).toEqual([
      'run.created',
      'created->queued',
      'queued->running',
      'run.updated',
      'tool.called',
      'tool.result',
      'message.created',
      'running->completed',
      'run.completed',
    ]);
    const msgs = await d.call(HUMAN, 'session.messages', { sessionId: s.id });
    expect(msgs.items[0]).toMatchObject({ runId: run.id, author: agentActor(s.id, run.id) });
    const toolResult = d.ctx.bus.list({ runId: run.id, types: ['tool.result'] }).events[0];
    expect(toolResult?.sessionId).toBe(s.id);
  });

  it('fails runs whose executor throws or is missing, and retries them as a new attempt', async () => {
    // No executor for "orchestrator" in this daemon (the orchestrator module registers it).
    d = await createTestDaemon({ modules: modules.filter((m) => m.name !== 'orchestrator') });
    const runs = d.ctx.service('runs');
    const s = await newSession(d);
    const orphan = runs.start({ sessionId: s.id, kind: 'orchestrator', createdBy: HUMAN });
    const failed = await runs.waitForEnd(orphan.id);
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'not_found' } });
    expect(failed.error?.message).toContain('orchestrator');

    let calls = 0;
    runs.registerExecutor('orchestrator', async () => {
      calls++;
      if (calls === 1) throw invalidParams('壊れた入力');
    });
    const retry1 = await d.call(HUMAN, 'run.retry', { runId: orphan.id });
    const r1 = await runs.waitForEnd(retry1.runId);
    expect(r1).toMatchObject({
      status: 'failed',
      attempt: 2,
      retryOfRunId: orphan.id,
      error: { code: 'invalid_params', message: '壊れた入力' },
    });
    expect(d.ctx.bus.list({ runId: r1.id, types: ['run.failed'] }).events).toHaveLength(1);
    const retry2 = await d.call(HUMAN, 'run.retry', { runId: r1.id });
    expect(await runs.waitForEnd(retry2.runId)).toMatchObject({ status: 'completed', attempt: 3 });
    await expect(d.call(HUMAN, 'run.retry', { runId: retry2.runId })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('allows one active run per session', async () => {
    d = await createTestDaemon();
    const ex = blockingExecutor(d.ctx.service('runs'));
    const s = await newSession(d);
    const run = startAgentRun(d, s.id);
    expect(() => startAgentRun(d!, s.id)).toThrow(/別の Run/);
    await until(() => ex.started(run.id));
    ex.finish(run.id);
    await d.ctx.service('runs').waitForEnd(run.id);
    expect(() => startAgentRun(d!, s.id)).not.toThrow();
  });
});

describe('concurrency queue', () => {
  it('runs at most maxConcurrentRuns (10) at once and starts the rest FIFO', async () => {
    d = await createTestDaemon();
    expect(d.ctx.settings.get().maxConcurrentRuns).toBe(10);
    const ex = blockingExecutor(d.ctx.service('runs'));
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(startAgentRun(d, (await newSession(d)).id).id);
    await until(() => ex.order.length === 10);
    await new Promise((r) => setTimeout(r, 20));
    expect(ex.order).toEqual(ids.slice(0, 10));
    expect(ids.map((id) => status(d!, id))).toEqual([
      ...Array<string>(10).fill('running'),
      'queued',
      'queued',
    ]);
    const list = await d.call(HUMAN, 'run.list', { status: ['queued'] });
    expect(list.items.map((r) => r.id).sort()).toEqual(ids.slice(10).sort());

    ex.finish(ids[3]!);
    await until(() => ex.order.length === 11);
    expect(ex.order[10]).toBe(ids[10]);
    expect(status(d, ids[11]!)).toBe('queued');

    // Raising the limit starts the waiting run without another run finishing.
    await d.call(HUMAN, 'settings.update', { maxConcurrentRuns: 11 });
    await until(() => ex.order.length === 12);
    expect(ex.order[11]).toBe(ids[11]);
  });

  it('cancels queued runs without running them', async () => {
    d = await createTestDaemon();
    await d.call(HUMAN, 'settings.update', { maxConcurrentRuns: 1 });
    const ex = blockingExecutor(d.ctx.service('runs'));
    const a = startAgentRun(d, (await newSession(d)).id);
    const b = startAgentRun(d, (await newSession(d)).id);
    await until(() => ex.started(a.id));
    const cancelled = await d.call(HUMAN, 'run.cancel', { runId: b.id, reason: '不要になった' });
    expect(cancelled).toMatchObject({ status: 'cancelled', statusReason: '不要になった' });
    ex.finish(a.id);
    await d.ctx.service('runs').waitForEnd(a.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(ex.order).toEqual([a.id]);
    await expect(d.call(HUMAN, 'run.cancel', { runId: b.id })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('aborts running runs on cancel and frees the slot once the executor unwinds', async () => {
    d = await createTestDaemon();
    await d.call(HUMAN, 'settings.update', { maxConcurrentRuns: 1 });
    const ex = blockingExecutor(d.ctx.service('runs'));
    const a = startAgentRun(d, (await newSession(d)).id);
    const b = startAgentRun(d, (await newSession(d)).id);
    await until(() => ex.started(a.id));
    const signal = ex.ctls.get(a.id)!.signal;
    await d.call(HUMAN, 'run.cancel', { runId: a.id });
    expect(signal.aborted).toBe(true);
    await until(() => ex.started(b.id));
    expect(runEvents(d, a.id).slice(-1)).toEqual(['running->cancelled']);
  });
});

describe('approvals', () => {
  it('request → awaiting_approval → respond → running, with events', async () => {
    d = await createTestDaemon();
    const ex = blockingExecutor(d.ctx.service('runs'));
    const s = await newSession(d);
    const run = startAgentRun(d, s.id);
    await until(() => ex.started(run.id));
    const ctl = ex.ctls.get(run.id)!;

    const decision = ctl.requestApproval({
      kind: 'tool_use',
      title: 'rm -rf build を実行',
      payload: { toolName: 'bash', input: { cmd: 'rm -rf build' } },
    });
    expect(status(d, run.id)).toBe('awaiting_approval');
    const pending = await d.call(HUMAN, 'approval.list', { status: ['pending'] });
    expect(pending.items).toHaveLength(1);
    const ap = pending.items[0]!;
    expect(ap).toMatchObject({ runId: run.id, sessionId: s.id, requestedBy: ctl.actor });

    // The requesting agent cannot approve itself.
    const grantSelf = d.ctx.repos.grants.insert({
      id: d.ctx.ids.next('grant'),
      subject: { kind: 'run', runId: run.id },
      parentGrantId: null,
      permissions: ['approval.*'],
      scope: {},
      limits: {},
      depth: 0,
      lifetime: 'run',
      expiresAt: null,
      revokedAt: null,
      reason: null,
      grantedBy: HUMAN,
      createdAt: d.ctx.clock.iso(),
    });
    expect(grantSelf.id).toBeTruthy();
    await expect(
      d.call(ctl.actor, 'approval.respond', { approvalId: ap.id, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const resolved = await d.call(HUMAN, 'approval.respond', {
      approvalId: ap.id,
      decision: 'reject',
      note: '危険',
    });
    expect(resolved).toMatchObject({
      status: 'rejected',
      resolvedBy: HUMAN,
      resolutionNote: '危険',
    });
    await expect(decision).resolves.toEqual({ decision: 'rejected', note: '危険' });
    expect(status(d, run.id)).toBe('running');
    await expect(
      d.call(HUMAN, 'approval.respond', { approvalId: ap.id, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'conflict' });

    ex.finish(run.id);
    await d.ctx.service('runs').waitForEnd(run.id);
    expect(runEvents(d, run.id)).toEqual([
      'run.created',
      'created->queued',
      'queued->running',
      'approval.requested',
      'running->awaiting_approval',
      'approval.resolved',
      'awaiting_approval->running',
      'running->completed',
      'run.completed',
      // The run-lifetime grant above ends with the run (policy module).
      'grant.revoked',
    ]);
    expect(d.ctx.repos.grants.require(grantSelf.id).revokedAt).not.toBeNull();
  });

  it('cancel during approval cancels the approval and rejects the wait', async () => {
    d = await createTestDaemon();
    const runs = d.ctx.service('runs');
    let waitError: unknown = null;
    let unwound = false;
    const asked = deferred();
    runs.registerExecutor('agent', async (ctl) => {
      try {
        const p = ctl.requestApproval({ kind: 'tool_use', title: 'deploy' });
        asked.resolve();
        await p;
      } catch (err) {
        waitError = err;
        throw err;
      } finally {
        unwound = true;
      }
    });
    const s = await newSession(d);
    const run = startAgentRun(d, s.id);
    await asked.promise;
    expect(status(d, run.id)).toBe('awaiting_approval');
    const [ap] = (await d.call(HUMAN, 'approval.list', { runId: run.id })).items;

    const cancelled = await d.call(HUMAN, 'run.cancel', { runId: run.id });
    expect(cancelled.status).toBe('cancelled');
    await until(() => unwound);
    expect((waitError as Error).name).toBe('AbortError');
    expect(d.ctx.repos.approvals.require(ap!.id).status).toBe('cancelled');
    expect(status(d, run.id)).toBe('cancelled');
    expect(runEvents(d, run.id).slice(-2)).toEqual([
      'awaiting_approval->cancelled',
      'approval.resolved',
    ]);
    expect(d.ctx.repos.sessions.require(s.id).activeRunId).toBeNull();
    await expect(
      d.call(HUMAN, 'approval.respond', { approvalId: ap!.id, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('interruption and recovery', () => {
  it('interrupts running and queued runs on shutdown; they can be retried after restart', async () => {
    d = await createTestDaemon();
    await d.call(HUMAN, 'settings.update', { maxConcurrentRuns: 1 });
    const ex = blockingExecutor(d.ctx.service('runs'));
    const a = startAgentRun(d, (await newSession(d)).id);
    const b = startAgentRun(d, (await newSession(d)).id);
    await until(() => ex.started(a.id));
    const signal = ex.ctls.get(a.id)!.signal;
    d = await restart();
    expect(signal.aborted).toBe(true);
    // Graceful shutdown already settled them, so restart recovery has nothing to do.
    expect(d.recovery.interruptedRuns).toEqual([]);
    for (const id of [a.id, b.id]) {
      expect(d.ctx.repos.runs.require(id)).toMatchObject({
        status: 'interrupted',
        statusReason: 'daemon_shutdown',
      });
    }
    d.ctx.service('runs').registerExecutor('agent', async () => {});
    const retry = await d.call(HUMAN, 'run.retry', { runId: a.id });
    expect(await d.ctx.service('runs').waitForEnd(retry.runId)).toMatchObject({
      status: 'completed',
      attempt: 2,
      retryOfRunId: a.id,
    });
  });

  it('retries runs left running by a crash (interrupted by restart recovery)', async () => {
    d = await createTestDaemon();
    const s = await newSession(d);
    const now = d.ctx.clock.iso();
    // Simulate a crash: a row that no RunManager knows about stays "running".
    const ghost = d.ctx.repos.runs.insert({
      id: d.ctx.ids.next('run'),
      sessionId: s.id,
      projectId: null,
      taskId: null,
      kind: 'agent',
      status: 'running',
      statusReason: null,
      model: null,
      runtime: null,
      workspaceId: null,
      parentRunId: null,
      retryOfRunId: null,
      attempt: 1,
      budgetId: null,
      triggerMessageId: null,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'unknown' },
      error: null,
      createdBy: HUMAN,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      endedAt: null,
    });
    d = await restart();
    expect(d.recovery.interruptedRuns).toEqual([ghost.id]);
    expect(d.ctx.repos.runs.require(ghost.id).statusReason).toBe('daemon_restart');
    d.ctx.service('runs').registerExecutor('agent', async () => {});
    const retry = await d.call(HUMAN, 'run.retry', { runId: ghost.id });
    expect((await d.ctx.service('runs').waitForEnd(retry.runId)).status).toBe('completed');
  });
});

describe('workspace locks', () => {
  it('keeps a run queued until its workspace lock is free while others start', async () => {
    const locks = new Map<string, string>();
    let notify: () => void = () => {};
    const fake: Pick<WorkspacesService, 'acquire' | 'isLocked' | 'get'> = {
      get: (id) => ({ id, status: 'ready' }) as Workspace,
      isLocked: (id) => locks.has(id),
      acquire: (id, runId): WorkspaceLock => {
        if (locks.has(id)) throw conflict('locked');
        locks.set(id, runId);
        return {
          workspaceId: id,
          runId,
          release: () => {
            locks.delete(id);
            notify();
          },
        };
      },
    };
    const fakeWorkspaces = defineModule({
      name: 'workspace',
      register(ctx) {
        ctx.provide('workspaces', fake as WorkspacesService);
        notify = () => (ctx.service('runs') as unknown as { pump(): void }).pump();
      },
    });
    d = await createTestDaemon({
      modules: [...modules.filter((m) => m.name !== 'workspace'), fakeWorkspaces],
    });
    const ex = blockingExecutor(d.ctx.service('runs'));
    const ws = d.ctx.ids.next('workspace');
    const a = startAgentRun(d, (await newSession(d)).id, { workspaceId: ws });
    const b = startAgentRun(d, (await newSession(d)).id, { workspaceId: ws });
    const c = startAgentRun(d, (await newSession(d)).id);
    await until(() => ex.started(a.id) && ex.started(c.id));
    expect(locks.get(ws)).toBe(a.id);
    expect(d.ctx.repos.runs.require(b.id)).toMatchObject({
      status: 'queued',
      activity: 'ワークスペースの解放を待っています',
    });
    ex.finish(a.id);
    await until(() => ex.started(b.id));
    expect(locks.get(ws)).toBe(b.id);
    expect(d.ctx.repos.runs.require(b.id).activity).toBeNull();
    ex.finish(b.id);
    await d.ctx.service('runs').waitForEnd(b.id);
    expect(locks.size).toBe(0);
  });

  it("locks the session's or task's workspace for agent runs that name none", async () => {
    d = await createTestDaemon();
    const ex = blockingExecutor(d.ctx.service('runs'));
    const project = await d.call(HUMAN, 'project.create', { name: 'P' });
    const ws = d.ctx.ids.next('workspace');
    const now = d.ctx.clock.iso();
    d.ctx.repos.workspaces.insert({
      id: ws,
      projectId: project.id,
      kind: 'worktree',
      status: 'ready',
      path: 'unused',
      branch: 'acc/test',
      baseRef: 'main',
      taskId: null,
      lockedByRunId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    const task = insertTestTask(d.ctx, { projectId: project.id, workspaceId: ws });
    const viaTask = d.ctx.service('runs').start({
      sessionId: (await newSession(d)).id,
      kind: 'agent',
      taskId: task.id,
      createdBy: HUMAN,
    });
    expect(viaTask.workspaceId).toBe(ws);
    const viaSession = startAgentRun(
      d,
      (await d.call(HUMAN, 'session.create', { projectId: project.id, workspaceId: ws })).id,
    );
    expect(viaSession.workspaceId).toBe(ws);
    await until(() => ex.started(viaTask.id));
    expect(d.ctx.service('workspaces').isLocked(ws)).toBe(true);
    expect(status(d, viaSession.id)).toBe('queued');
    // Chat runs never take a workspace lock.
    const chat = d.ctx.service('runs').start({
      sessionId: (await d.call(HUMAN, 'session.create', { workspaceId: ws })).id,
      kind: 'chat',
      createdBy: HUMAN,
    });
    expect(chat.workspaceId).toBeNull();
    d.ctx.service('runs').cancel(chat.id, HUMAN);
    ex.finish(viaTask.id);
    await until(() => ex.started(viaSession.id));
    ex.finish(viaSession.id);
    await d.ctx.service('runs').waitForEnd(viaSession.id);
    expect(d.ctx.service('workspaces').isLocked(ws)).toBe(false);
  });
});

describe('usage and budget', () => {
  it('merges usage with the weakest cost source', () => {
    const empty = { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'unknown' as const };
    const one = mergeUsage(
      empty,
      { inputTokens: 10, outputTokens: 2, costUsd: 0.1, costSource: 'reported' },
      true,
    );
    expect(one).toEqual({ inputTokens: 10, outputTokens: 2, costUsd: 0.1, costSource: 'reported' });
    const two = mergeUsage(one, { inputTokens: 1, costUsd: 0.05, costSource: 'estimated' }, false);
    expect(two).toMatchObject({ inputTokens: 11, costSource: 'estimated' });
    expect(two.costUsd).toBeCloseTo(0.15);
    expect(mergeUsage(two, { costSource: 'reported' }, false).costSource).toBe('estimated');
  });

  it('accumulates usage, records spend and stops the run when the budget is exhausted', async () => {
    // The real budget service (policy module): spend past the limit is recorded, not thrown.
    d = await createTestDaemon();
    const budget = d.ctx.service('budget').createRoot({
      subject: { kind: 'global', id: null },
      limitUsd: 1,
      actor: HUMAN,
    });
    const runs = d.ctx.service('runs');
    const ex = blockingExecutor(runs);
    const budgetId = budget.id;
    const run = startAgentRun(d, (await newSession(d)).id, { budgetId });
    await until(() => ex.started(run.id));
    const ctl = ex.ctls.get(run.id)!;
    ctl.reportUsage({ inputTokens: 100, outputTokens: 20, costUsd: 0.6, costSource: 'reported' });
    expect(d.ctx.repos.runs.require(run.id).usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.6,
      costSource: 'reported',
    });
    expect(d.ctx.service('budget').get(budgetId).spentUsd).toBeCloseTo(0.6);
    expect(ctl.signal.aborted).toBe(false);
    ctl.reportUsage({ inputTokens: 50, outputTokens: 10, costUsd: 0.6, costSource: 'reported' });
    expect(ctl.signal.aborted).toBe(true);
    const final = await runs.waitForEnd(run.id);
    expect(final).toMatchObject({
      status: 'failed',
      statusReason: 'budget_exhausted',
      error: { code: 'budget_exceeded' },
      usage: { inputTokens: 150, outputTokens: 30 },
    });
    expect(final.usage.costUsd).toBeCloseTo(1.2);
    expect(d.ctx.service('budget').get(budgetId).spentUsd).toBeCloseTo(1.2);
    const updates = d.ctx.bus.list({ runId: run.id, types: ['run.updated'] }).events;
    expect(updates.map((e) => (e.type === 'run.updated' ? e.payload.changes : []))).toEqual([
      ['usage'],
      ['usage'],
    ]);
  });
});

describe('methods', () => {
  it('run.get / run.list filters and approval.list', async () => {
    d = await createTestDaemon();
    const runs = d.ctx.service('runs');
    runs.registerExecutor('agent', async () => {});
    const s1 = await newSession(d);
    const s2 = await newSession(d);
    const r1 = startAgentRun(d, s1.id);
    await runs.waitForEnd(r1.id);
    const r2 = startAgentRun(d, s2.id);
    await runs.waitForEnd(r2.id);
    expect((await d.call(HUMAN, 'run.get', { runId: r1.id })).status).toBe('completed');
    expect((await d.call(HUMAN, 'run.list', {})).items.map((r) => r.id)).toEqual([r2.id, r1.id]);
    expect((await d.call(HUMAN, 'run.list', { sessionId: s1.id })).items.map((r) => r.id)).toEqual([
      r1.id,
    ]);
    const page = await d.call(HUMAN, 'run.list', { limit: 1 });
    expect(page.nextCursor).not.toBeNull();
    expect(
      (await d.call(HUMAN, 'run.list', { limit: 1, cursor: page.nextCursor! })).items[0]?.id,
    ).toBe(r1.id);
    expect((await d.call(HUMAN, 'approval.list', {})).items).toEqual([]);
    await expect(d.call(HUMAN, 'run.get', { runId: d.ctx.ids.next('run') })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('liveness', () => {
  it('a run waiting on others lends its slot, so the workers it waits for can start', async () => {
    d = await createTestDaemon();
    await d.call(HUMAN, 'settings.update', { maxConcurrentRuns: 1 });
    const ex = blockingExecutor(d.ctx.service('runs'));
    const waiter = startAgentRun(d, (await newSession(d)).id);
    await until(() => ex.started(waiter.id));
    d.ctx.repos.grants.insert({
      id: d.ctx.ids.next('grant'),
      subject: { kind: 'run', runId: waiter.id },
      parentGrantId: null,
      permissions: ['*'],
      scope: {},
      limits: {},
      depth: 0,
      lifetime: 'run',
      expiresAt: null,
      revokedAt: null,
      reason: null,
      grantedBy: HUMAN,
      createdAt: d.ctx.clock.iso(),
    });
    const project = await d.call(HUMAN, 'project.create', { name: 'p' });
    const task = await d.call(HUMAN, 'task.create', { projectId: project.id, title: 't' });
    const worker = startAgentRun(d, (await newSession(d)).id);
    expect(status(d, worker.id)).toBe('queued');

    const actor = agentActor(waiter.sessionId, waiter.id);
    const waiting = d.call(actor, 'task.wait', { taskIds: [task.id], timeoutMs: 60_000 });
    await until(() => ex.started(worker.id));
    expect(status(d, waiter.id)).toBe('running');
    // A third run still waits: the slot went to the worker, not to everyone.
    const third = startAgentRun(d, (await newSession(d)).id);
    await new Promise((r) => setTimeout(r, 50));
    expect(status(d, third.id)).toBe('queued');

    await d.call(HUMAN, 'task.update', { taskId: task.id, status: 'cancelled' });
    await waiting;
    ex.finish(worker.id);
    await d.ctx.service('runs').waitForEnd(worker.id);
    // The waiter has its slot back: the third run keeps waiting until the waiter ends.
    await new Promise((r) => setTimeout(r, 50));
    expect(status(d, third.id)).toBe('queued');
    ex.finish(waiter.id);
    await until(() => ex.started(third.id));
    ex.finish(third.id);
  });

  it('fails a queued run whose workspace was removed instead of waiting forever', async () => {
    const restore = isolateGitConfig();
    const repo = await createTempRepo();
    try {
      d = await createTestDaemon();
      await d.call(HUMAN, 'settings.update', { maxConcurrentRuns: 1 });
      const ex = blockingExecutor(d.ctx.service('runs'));
      const project = await d.call(HUMAN, 'project.create', {
        name: 'p',
        repoPath: repo.path,
        defaultBranch: 'main',
      });
      const ws = await d.call(HUMAN, 'workspace.create', { projectId: project.id });
      const busy = startAgentRun(d, (await newSession(d)).id);
      await until(() => ex.started(busy.id));
      const queued = startAgentRun(d, (await newSession(d)).id, { workspaceId: ws.id });
      expect(status(d, queued.id)).toBe('queued');

      await d.call(HUMAN, 'workspace.remove', { workspaceId: ws.id });
      ex.finish(busy.id);
      const ended = await d.ctx.service('runs').waitForEnd(queued.id);
      expect(ended).toMatchObject({ status: 'failed', statusReason: 'workspace_unavailable' });
    } finally {
      await d?.cleanup();
      d = null;
      await repo.cleanup();
      restore();
    }
  }, 60_000);

  it('holds the workspace lock from the moment a removal starts', async () => {
    const restore = isolateGitConfig();
    const repo = await createTempRepo();
    try {
      d = await createTestDaemon();
      const ex = blockingExecutor(d.ctx.service('runs'));
      const project = await d.call(HUMAN, 'project.create', {
        name: 'p',
        repoPath: repo.path,
        defaultBranch: 'main',
      });
      const ws = await d.call(HUMAN, 'workspace.create', { projectId: project.id });
      const svc = d.ctx.service('workspaceManager');
      const removing = svc.remove(ws.id, { force: false, actor: HUMAN });
      // Synchronously after the call: a run cannot take the workspace any more.
      expect(svc.isLocked(ws.id)).toBe(true);
      const run = startAgentRun(d, (await newSession(d)).id, { workspaceId: ws.id });
      await removing;
      const ended = await d.ctx.service('runs').waitForEnd(run.id);
      expect(ended.statusReason).toBe('workspace_unavailable');
      expect(ex.started(run.id)).toBe(false);
    } finally {
      await d?.cleanup();
      d = null;
      await repo.cleanup();
      restore();
    }
  }, 60_000);

  it('books the cost of a call that settles after its run was force-cleaned up', async () => {
    d = await createTestDaemon();
    const runs = d.ctx.service('runs');
    (runs as unknown as { cancelGraceMs: number }).cancelGraceMs = 20;
    const budget = d.ctx.service('budget').createRoot({
      subject: { kind: 'global', id: null },
      limitUsd: 1,
      actor: HUMAN,
    });
    const settled = deferred();
    let settle!: () => void;
    runs.registerExecutor('agent', async (ctl) => {
      const hold = ctl.reserveBudget(0.1);
      // A provider call that ignores the abort and returns late.
      await new Promise<void>((r) => (settle = r));
      hold.settle({ inputTokens: 5, outputTokens: 5, costUsd: 0.07, costSource: 'reported' });
      settled.resolve();
    });
    const run = startAgentRun(d, (await newSession(d)).id, { budgetId: budget.id });
    await until(() => status(d!, run.id) === 'running' && settle !== undefined);
    runs.cancel(run.id, HUMAN);
    // Grace over: slot and reservation are freed although the executor did not return.
    await until(() => d!.ctx.service('budget').get(budget.id).reservedUsd === 0, 3000);
    settle();
    await settled.promise;
    expect(d.ctx.service('budget').get(budget.id).spentUsd).toBeCloseTo(0.07);
    expect(d.ctx.repos.runs.require(run.id).usage.costUsd).toBeCloseTo(0.07);
  });
});
