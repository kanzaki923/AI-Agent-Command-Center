import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccClientError, createClient } from '@acc/client';
import { daemonConnectionInfo } from '@acc/client/node';
import type { Delta, Event, Run } from '@acc/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { defineMethod } from './api/registry';
import { defineModule } from './module';
import { modules } from './modules';
import { HUMAN, type TestDaemon, connectTestClient, startTestDaemon } from './testing';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups.length = 0;
});

async function start(opts: Parameters<typeof startTestDaemon>[0] = {}): Promise<TestDaemon> {
  const d = await startTestDaemon(opts);
  cleanups.push(() => d.cleanup());
  return d;
}

function until<T>(fn: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = fn();
      if (v !== undefined && v !== false) return resolve(v);
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('server', () => {
  it('serves /health without auth and writes daemon.json', async () => {
    const d = await start();
    const res = await fetch(`${d.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      service: 'acc-daemon',
      pid: process.pid,
      version: d.ctx.version,
    });
    const info = JSON.parse(readFileSync(join(d.home, 'daemon.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(info).toMatchObject({ port: d.port, token: d.token, pid: process.pid });
  });

  it('removes daemon.json on close', async () => {
    const d = await startTestDaemon();
    await d.close();
    expect(existsSync(join(d.home, 'daemon.json'))).toBe(false);
    d.removeHome();
  });

  it('rejects WebSocket connections with a wrong token', async () => {
    const d = await start();
    const client = createClient({ url: d.wsUrl, token: 'wrong', reconnect: false });
    await expect(client.ready()).rejects.toBeInstanceOf(AccClientError);
    expect(client.state).toBe('closed');
  });

  it('round-trips typed calls and errors over WebSocket', async () => {
    const d = await start();
    const client = await connectTestClient(d);
    cleanups.push(() => client.close());

    const health = await client.call('system.health');
    expect(health.ok).toBe(true);
    const project = await client.call('project.create', { name: 'WS' });
    const session = await client.call('session.create', { projectId: project.id, title: 'chat' });
    expect(session.projectId).toBe(project.id);
    expect(session.createdBy).toEqual({ kind: 'human', client: 'test' });

    const err = await client.call('session.get', { sessionId: 'bad' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccClientError);
    expect((err as AccClientError).code).toBe('invalid_params');
    const nf = await client
      .call('session.get', { sessionId: d.ctx.ids.next('session') })
      .catch((e: unknown) => e);
    expect((nf as AccClientError).code).toBe('not_found');
  });

  it('pushes filtered events and deltas to subscribers', async () => {
    const d = await start();
    const client = await connectTestClient(d);
    cleanups.push(() => client.close());
    const a = await client.call('session.create', { title: 'a' });
    const b = await client.call('session.create', { title: 'b' });

    // Modules subscribe to the bus too; only this subscription's listener must go away.
    const busListeners = () => (d.ctx.bus as unknown as { listeners: Set<unknown> }).listeners.size;
    const baseListeners = busListeners();
    const events: Event[] = [];
    const deltas: Delta[] = [];
    const sub = client.subscribe({
      sessionId: a.id,
      onEvent: (e) => events.push(e),
      onDelta: (x) => deltas.push(x),
    });
    await until(() => sub.lastSeq !== null || undefined);

    await client.call('session.update', { sessionId: b.id, title: 'b2' });
    await client.call('session.update', { sessionId: a.id, title: 'a2' });
    const runId = d.ctx.ids.next('run');
    const messageId = d.ctx.ids.next('message');
    d.ctx.bus.publishDelta({ runId, sessionId: a.id, messageId, text: 'Hel', index: 0 });
    d.ctx.bus.publishDelta({ runId, sessionId: b.id, messageId, text: 'x', index: 0 });

    await until(() => (events.length >= 1 && deltas.length >= 1) || undefined);
    expect(events.map((e) => [e.type, e.sessionId])).toEqual([['session.updated', a.id]]);
    expect(deltas.map((x) => x.text)).toEqual(['Hel']);

    sub.unsubscribe();
    await until(() => busListeners() === baseListeners || undefined);
  });

  it('replays history with `since` before streaming live events', async () => {
    const d = await start();
    const client = await connectTestClient(d);
    cleanups.push(() => client.close());
    for (let i = 0; i < 3; i++) await client.call('session.create', { title: `s${i}` });

    const seqs: number[] = [];
    client.subscribe({ since: 0, types: ['session.created'], onEvent: (e) => seqs.push(e.seq) });
    await until(() => seqs.length === 3 || undefined);
    await client.call('session.create', { title: 'live' });
    await until(() => seqs.length === 4 || undefined);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
  });

  it('aborts long polls when the client disconnects and rejects in-flight calls', async () => {
    let aborted = false;
    let entered = false;
    // A fake long-poll implementation of task.wait that blocks until the call is aborted.
    const slow = defineModule({
      name: 'slow',
      register(ctx) {
        ctx.methods.register(
          defineMethod('task.wait', {
            handler: (_p, call) =>
              new Promise((resolve) => {
                entered = true;
                call.signal.addEventListener('abort', () => {
                  aborted = true;
                  resolve({ reached: [], tasks: [], timedOut: true });
                });
              }),
          }),
        );
      },
    });
    const d = await start({
      modules: [...modules.filter((m) => m.name !== 'orchestrator'), slow],
    });
    const client = await connectTestClient(d, { reconnect: false });
    const taskId = d.ctx.ids.next('task');
    const pending = client
      .call('task.wait', { taskIds: [taskId], timeoutMs: 600_000 })
      .catch((e: unknown) => e);
    await until(() => entered || undefined);

    // Kill the connection from the server side (as if the daemon died).
    await d.close();
    const err = (await pending) as AccClientError;
    expect(err).toBeInstanceOf(AccClientError);
    expect(err.code).toBe('connection_lost');
    expect(aborted).toBe(true);
    expect(client.state).toBe('closed');
  });

  it('queues calls made while connecting', async () => {
    const d = await start();
    const client = createClient({ url: d.wsUrl, token: d.token });
    cleanups.push(() => client.close());
    expect(client.state).toBe('connecting');
    await expect(client.call('system.health')).resolves.toMatchObject({ ok: true });
  });

  it('reconnects after a daemon restart and resumes events without gaps or duplicates', async () => {
    const first = await startTestDaemon();
    const home = first.home;
    cleanups.push(() => first.removeHome());

    const client = createClient({
      connectionInfo: daemonConnectionInfo(home),
      clientName: 'test',
      reconnect: { initialDelayMs: 20, maxDelayMs: 100 },
    });
    cleanups.push(() => client.close());
    await client.ready();

    const seen: number[] = [];
    const sub = client.subscribe({ types: ['session.*'], onEvent: (e) => seen.push(e.seq) });
    await until(() => sub.lastSeq !== null || undefined);
    await client.call('session.create', { title: 'before' });
    await until(() => seen.length === 1 || undefined);

    const states: string[] = [];
    client.onStateChange((s) => states.push(s));
    await first.close();
    await until(() => client.state === 'reconnecting' || undefined);

    // Events produced while the client is offline (by a new daemon process on the same home).
    const second = await startTestDaemon({ home });
    cleanups.push(() => second.close());
    await second.call(HUMAN, 'session.create', { title: 'while offline 1' });
    await second.call(HUMAN, 'session.create', { title: 'while offline 2' });

    await client.ready();
    await until(() => seen.length === 3 || undefined);
    await client.call('session.create', { title: 'after' });
    await until(() => seen.length === 4 || undefined);

    expect(seen).toEqual([1, 2, 3, 4]);
    expect(states).toContain('reconnecting');
    expect(states.at(-1)).toBe('open');
  });
});

describe('restart recovery', () => {
  it('marks running/queued/awaiting_approval runs as interrupted with events', async () => {
    const first = await startTestDaemon();
    const home = first.home;
    cleanups.push(() => first.removeHome());
    const { ctx } = first;
    const session = await first.call(HUMAN, 'session.create', {});
    const now = ctx.clock.iso();
    const mkRun = (status: Run['status']): Run =>
      ctx.repos.runs.insert({
        id: ctx.ids.next('run'),
        sessionId: session.id,
        projectId: null,
        taskId: null,
        kind: 'chat',
        status,
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
    const running = mkRun('running');
    const queued = mkRun('queued');
    const waiting = mkRun('awaiting_approval');
    const done = mkRun('completed');
    ctx.repos.sessions.update(session.id, (s) => ({ ...s, activeRunId: running.id }));
    const approval = ctx.repos.approvals.insert({
      id: ctx.ids.next('approval'),
      kind: 'tool_use',
      status: 'pending',
      title: 'rm -rf?',
      detail: null,
      payload: { tool: 'bash' },
      projectId: null,
      sessionId: session.id,
      runId: waiting.id,
      taskId: null,
      integrationId: null,
      requestedBy: { kind: 'agent', sessionId: session.id, runId: waiting.id },
      resolvedBy: null,
      resolutionNote: null,
      createdAt: now,
      resolvedAt: null,
    });
    await first.close();

    const second = await startTestDaemon({ home });
    cleanups.push(() => second.close());
    expect(second.recovery.interruptedRuns.sort()).toEqual(
      [running.id, queued.id, waiting.id].sort(),
    );
    for (const r of [running, queued, waiting]) {
      expect(second.ctx.repos.runs.require(r.id)).toMatchObject({
        status: 'interrupted',
        statusReason: 'daemon_restart',
      });
    }
    expect(second.ctx.repos.runs.require(done.id).status).toBe('completed');
    expect(second.ctx.repos.approvals.require(approval.id).status).toBe('cancelled');
    expect(second.ctx.repos.sessions.require(session.id).activeRunId).toBeNull();

    const ev = second.ctx.bus.list({ types: ['run.status_changed'] }).events;
    expect(ev).toHaveLength(3);
    for (const e of ev) {
      expect(e.actor).toEqual({ kind: 'system', component: 'recovery' });
      expect(e.sessionId).toBe(session.id);
      if (e.type === 'run.status_changed') expect(e.payload.to).toBe('interrupted');
    }
    expect(second.ctx.bus.list({ types: ['approval.resolved'] }).events).toHaveLength(1);

    // A second restart has nothing left to recover.
    await second.close();
    const third = await startTestDaemon({ home });
    cleanups.push(() => third.close());
    expect(third.recovery.interruptedRuns).toEqual([]);
  });
});
