import type { Event } from '@acc/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { backoffDelay } from './backoff';
import { AccClientError, type AccClient, type WebSocketLike, createClient } from './client';

// ---------------------------------------------------------------------------
// In-memory fake of the daemon side of the socket.
// ---------------------------------------------------------------------------

type Listener = (ev: never) => void;
type Frame = { id: number; method: string; params: Record<string, unknown> };

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: Frame[] = [];
  private listeners = new Map<string, Listener[]>();
  constructor(
    readonly url: string,
    private readonly server: FakeServer,
  ) {}
  addEventListener(type: string, l: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  emit(type: string, ev: unknown = {}) {
    for (const l of this.listeners.get(type) ?? []) l(ev as never);
  }
  send(data: string) {
    const frame = JSON.parse(data) as Frame;
    this.sent.push(frame);
    this.server.onFrame(this, frame);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit('close'));
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  push(msg: unknown) {
    this.emit('message', { data: JSON.stringify(msg) });
  }
  reply(id: number, result: unknown) {
    this.push({ id, result });
  }
}

class FakeServer {
  sockets: FakeSocket[] = [];
  log: Event[] = [];
  autoOpen = true;
  /** Return undefined to not answer (simulates a slow call). */
  handler: (s: FakeSocket, f: Frame) => unknown = (s, f) => this.defaultHandler(s, f);
  private subCounter = 0;

  factory = (url: string) => {
    const s = new FakeSocket(url, this);
    this.sockets.push(s);
    if (this.autoOpen) setTimeout(() => s.open(), 0);
    return s;
  };

  get current(): FakeSocket {
    return this.sockets[this.sockets.length - 1]!;
  }

  onFrame(s: FakeSocket, f: Frame) {
    const result = this.handler(s, f);
    if (result !== undefined) queueMicrotask(() => s.reply(f.id, result));
  }

  defaultHandler(_s: FakeSocket, f: Frame): unknown {
    switch (f.method) {
      case 'system.health':
        return { ok: true, version: 'x', protocolVersion: 1, uptimeMs: 0 };
      case 'events.subscribe':
        return { subscriptionId: `sub_${++this.subCounter}`, lastSeq: this.log.length };
      case 'events.list': {
        const since = (f.params.since as number) ?? 0;
        const limit = (f.params.limit as number) ?? 200;
        const events = this.log.filter((e) => e.seq > since).slice(0, limit);
        const last = events[events.length - 1];
        return {
          events,
          lastSeq: last ? last.seq : since,
          hasMore: this.log.filter((e) => e.seq > since).length > limit,
        };
      }
      case 'events.unsubscribe':
        return { ok: true };
      default:
        return undefined;
    }
  }

  addEvent(): Event {
    const seq = this.log.length + 1;
    const e = {
      seq,
      id: `evt_${String(seq).padStart(26, '0')}`,
      ts: new Date(seq).toISOString(),
      actor: { kind: 'system' },
      projectId: null,
      sessionId: null,
      runId: null,
      taskId: null,
      type: 'settings.updated',
      payload: { changes: [String(seq)] },
    } as Event;
    this.log.push(e);
    return e;
  }

  /** Persist an event and push it live to every subscription on the current socket. */
  emitLive(subscriptionId: string): Event {
    const e = this.addEvent();
    this.current.push({ type: 'event', subscriptionId, event: e });
    return e;
  }
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await tick();
  }
}

let clients: AccClient[] = [];
afterEach(() => {
  for (const c of clients) c.close();
  clients = [];
});

function make(server: FakeServer, opts: Parameters<typeof createClient>[0] = {}): AccClient {
  const c = createClient({
    url: 'ws://127.0.0.1:1/ws',
    token: 'tok',
    clientName: 'unit',
    webSocket: server.factory,
    reconnect: { initialDelayMs: 1, maxDelayMs: 5, jitter: 0 },
    ...opts,
  });
  clients.push(c);
  return c;
}

// ---------------------------------------------------------------------------

describe('backoffDelay', () => {
  it('grows exponentially, caps at max and stays within jitter bounds', () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 10].map((a) => backoffDelay(a, { jitter: 0 }, mid))).toEqual([
      250, 500, 1000, 2000, 5000,
    ]);
    for (let i = 0; i < 100; i++) {
      const d = backoffDelay(2, { initialDelayMs: 100, jitter: 0.5 });
      expect(d).toBeGreaterThanOrEqual(200);
      expect(d).toBeLessThanOrEqual(600);
    }
  });
});

describe('client', () => {
  it('puts token and client name in the URL', async () => {
    const server = new FakeServer();
    const c = make(server);
    await c.ready();
    const url = new URL(server.current.url);
    expect(url.searchParams.get('token')).toBe('tok');
    expect(url.searchParams.get('client')).toBe('unit');
  });

  it('queues calls until connected, then sends them', async () => {
    const server = new FakeServer();
    server.autoOpen = false;
    const c = make(server);
    const p = c.call('system.health');
    await tick();
    expect(server.current.sent).toHaveLength(0);
    server.current.open();
    await expect(p).resolves.toMatchObject({ ok: true });
  });

  it('maps error responses to AccClientError with the daemon code', async () => {
    const server = new FakeServer();
    server.handler = (_s, f) => {
      queueMicrotask(() =>
        server.current.push({ id: f.id, error: { code: 'forbidden', message: 'nope' } }),
      );
      return undefined;
    };
    const c = make(server);
    const err = (await c.call('system.health').catch((e: unknown) => e)) as AccClientError;
    expect(err).toBeInstanceOf(AccClientError);
    expect(err.code).toBe('forbidden');
  });

  it('times out unanswered calls; long-poll methods get their timeout added', async () => {
    const server = new FakeServer();
    server.handler = () => undefined;
    const c = make(server, { callTimeoutMs: 20 });
    const err = (await c.call('system.health').catch((e: unknown) => e)) as AccClientError;
    expect(err.code).toBe('timeout');

    const started = Date.now();
    const err2 = (await c
      .call('task.wait', { taskIds: ['tsk_00000000000000000000000000'], timeoutMs: 60 })
      .catch((e: unknown) => e)) as AccClientError;
    expect(err2.code).toBe('timeout');
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });

  it('rejects in-flight calls on disconnect, reconnects, and keeps working', async () => {
    const server = new FakeServer();
    const states: string[] = [];
    const c = make(server);
    c.onStateChange((s) => states.push(s));
    await c.ready();
    server.handler = () => undefined;
    const inflight = c.call('system.health').catch((e: unknown) => e);
    await tick();
    server.current.close();
    expect(((await inflight) as AccClientError).code).toBe('connection_lost');

    server.handler = (s, f) => server.defaultHandler(s, f);
    await until(() => c.state === 'open' && server.sockets.length === 2);
    await expect(c.call('system.health')).resolves.toMatchObject({ ok: true });
    expect(states).toEqual(['open', 'reconnecting', 'open']);
  });

  it('close() rejects pending calls and stops reconnecting', async () => {
    const server = new FakeServer();
    server.handler = () => undefined;
    const c = make(server);
    await c.ready();
    const p = c.call('system.health').catch((e: unknown) => e);
    await tick();
    c.close();
    expect(((await p) as AccClientError).code).toBe('closed');
    expect(c.state).toBe('closed');
    await tick(20);
    expect(server.sockets).toHaveLength(1);
    await expect(c.call('system.health')).rejects.toMatchObject({ code: 'closed' });
  });

  it('delivers pushes that arrive before the subscribe response', async () => {
    const server = new FakeServer();
    const c = make(server);
    await c.ready();
    const got: number[] = [];
    server.handler = (s, f) => {
      if (f.method === 'events.subscribe') {
        // Push an event first, then answer.
        const e = server.addEvent();
        s.push({ type: 'event', subscriptionId: 'sub_early', event: e });
        queueMicrotask(() => s.reply(f.id, { subscriptionId: 'sub_early', lastSeq: 0 }));
        return undefined;
      }
      return server.defaultHandler(s, f);
    };
    c.subscribe({ onEvent: (e) => got.push(e.seq) });
    await until(() => got.length === 1);
    expect(got).toEqual([1]);
  });

  it('resubscribes after reconnect and catches up from the last seq without duplicates', async () => {
    const server = new FakeServer();
    const c = make(server);
    await c.ready();
    server.addEvent(); // seq 1, before subscribing: must not be delivered

    const got: number[] = [];
    const sub = c.subscribe({ types: ['settings.*'], onEvent: (e) => got.push(e.seq) });
    await until(() => sub.lastSeq === 1);
    server.emitLive('sub_1'); // seq 2
    await until(() => got.length === 1);

    // Never pushed live (as if they happened while offline): only the catch-up after the
    // reconnect can deliver them. Added before close() so a fast reconnect cannot race them.
    server.addEvent(); // 3
    server.addEvent(); // 4
    const states: string[] = [];
    c.onStateChange((s) => states.push(s));
    server.current.close();
    await until(() => states.includes('reconnecting'));
    await until(() => got.length === 3);
    // A live duplicate of an already delivered event is ignored; new ones flow.
    server.current.push({ type: 'event', subscriptionId: 'sub_2', event: server.log[3] });
    server.emitLive('sub_2'); // 5
    await until(() => got.length === 4);
    expect(got).toEqual([2, 3, 4, 5]);

    const resub = server.current.sent.find((f) => f.method === 'events.subscribe');
    expect(resub?.params).toMatchObject({ types: ['settings.*'], deltas: false });
    const list = server.current.sent.find((f) => f.method === 'events.list');
    expect(list?.params).toMatchObject({ since: 2, types: ['settings.*'] });
  });

  it('replays from `since` and pages through history', async () => {
    const server = new FakeServer();
    for (let i = 0; i < 2500; i++) server.addEvent();
    const c = make(server);
    await c.ready();
    const got: number[] = [];
    c.subscribe({ since: 10, onEvent: (e) => got.push(e.seq) });
    await until(() => got.length === 2490);
    expect(got[0]).toBe(11);
    expect(got.at(-1)).toBe(2500);
  });

  it('unsubscribe tells the daemon and stops delivery', async () => {
    const server = new FakeServer();
    const c = make(server);
    await c.ready();
    const got: number[] = [];
    const sub = c.subscribe({ onEvent: (e) => got.push(e.seq) });
    await until(() => sub.lastSeq !== null);
    sub.unsubscribe();
    await until(() => server.current.sent.some((f) => f.method === 'events.unsubscribe'));
    server.emitLive('sub_1');
    await tick();
    expect(got).toEqual([]);
  });

  it('re-resolves connection info on every reconnect', async () => {
    const server = new FakeServer();
    let port = 1;
    const c = make(server, {
      url: undefined,
      token: undefined,
      connectionInfo: () => ({ url: `ws://127.0.0.1:${port}/ws`, token: `t${port}` }),
    });
    await c.ready();
    port = 2;
    server.current.close();
    await until(() => server.sockets.length === 2 && c.state === 'open');
    expect(new URL(server.current.url).port).toBe('2');
    expect(new URL(server.current.url).searchParams.get('token')).toBe('t2');
  });
});
