import {
  type ClientErrorCode,
  type Delta,
  type ErrorCode,
  type Event,
  type EventFilter,
  type MethodName,
  type ParamsInput,
  type Result,
  type ServerMessage,
  api,
  isFailure,
  isPush,
} from '@acc/protocol';
import { type BackoffOptions, backoffDelay } from './backoff';

/**
 * - `connecting`: first connection attempt in progress
 * - `open`: connected; calls are sent immediately
 * - `reconnecting`: connection lost (or failed), retrying with backoff
 * - `closed`: `close()` was called (or reconnect is disabled and the socket closed)
 */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Minimal standard WebSocket surface (browser WebSocket, Node 22 global WebSocket, `ws`). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (ev: never) => void,
  ): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

export interface ConnectionInfo {
  /** ws://127.0.0.1:47821/ws */
  url: string;
  token: string;
}

export interface ClientOptions {
  url?: string;
  token?: string;
  /**
   * Resolve url/token before every (re)connect — e.g. re-read daemon.json, since a
   * restarted daemon has a new token. Takes precedence over url/token.
   */
  connectionInfo?: () => ConnectionInfo | Promise<ConnectionInfo>;
  /** Shown in the daemon's human actor, e.g. "desktop", "cli". */
  clientName?: string;
  /** Default: `new globalThis.WebSocket(url)`. */
  webSocket?: WebSocketFactory;
  /** false disables reconnecting. */
  reconnect?: false | BackoffOptions;
  /** Per-call timeout (default 30s). Long-poll methods add their own `timeoutMs`. */
  callTimeoutMs?: number;
  /** Handshake timeout per connection attempt (default 10s). */
  connectTimeoutMs?: number;
}

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class AccClientError extends Error {
  constructor(
    readonly code: ErrorCode | ClientErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AccClientError';
  }
}

export interface SubscribeOptions extends EventFilter {
  /**
   * Start after this seq (replays history first). Omit to start from "now". After a
   * reconnect the client always resumes from the last delivered seq, so no event is lost
   * or duplicated.
   */
  since?: number;
  /** Receive streaming deltas (default: true when onDelta is given). */
  deltas?: boolean;
  onEvent?: (event: Event) => void;
  onDelta?: (delta: Delta) => void;
  /** Subscribe/catch-up failures (the client keeps retrying on reconnect). */
  onError?: (err: unknown) => void;
}

export interface Subscription {
  /** Seq of the last delivered event (or the head at subscribe time). */
  readonly lastSeq: number | null;
  unsubscribe(): void;
}

type CallArgs<M extends MethodName> =
  Record<string, never> extends ParamsInput<M>
    ? [params?: ParamsInput<M>, opts?: CallOptions]
    : [params: ParamsInput<M>, opts?: CallOptions];

export interface AccClient {
  readonly state: ConnectionState;
  onStateChange(listener: (state: ConnectionState) => void): () => void;
  /** Resolves once connected (immediately if open). Rejects if the client is closed. */
  ready(): Promise<void>;
  /** Typed Control API call. Calls made while disconnected wait for the connection. */
  call<M extends MethodName>(method: M, ...args: CallArgs<M>): Promise<Result<M>>;
  subscribe(opts: SubscribeOptions): Subscription;
  close(): void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
  sent: boolean;
  frame: string;
  timeoutMs: number;
  cleanup: () => void;
}

interface Sub {
  opts: SubscribeOptions;
  lastSeq: number | null;
  serverId: string | null;
  catchingUp: boolean;
  buffer: Event[];
  active: boolean;
  /** Incremented per activation, so stale async activations are ignored. */
  generation: number;
}

const OPEN = 1;
const MAX_ORPHAN_PUSHES = 1000;

export function createClient(options: ClientOptions): AccClient {
  return new Client(options);
}

class Client implements AccClient {
  private ws: WebSocketLike | null = null;
  private _state: ConnectionState = 'connecting';
  private readonly stateListeners = new Set<(s: ConnectionState) => void>();
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly subs = new Set<Sub>();
  private readonly byServerId = new Map<string, Sub>();
  /** Pushes that arrived before their events.subscribe response. */
  private orphans: { subscriptionId: string; msg: ServerMessage }[] = [];
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly callTimeoutMs: number;

  constructor(private readonly options: ClientOptions) {
    this.callTimeoutMs = options.callTimeoutMs ?? 30_000;
    void this.connect();
  }

  get state(): ConnectionState {
    return this._state;
  }

  private isClosed(): boolean {
    return this._state === 'closed';
  }

  private setState(s: ConnectionState): void {
    if (this._state === s) return;
    this._state = s;
    for (const l of this.stateListeners) {
      try {
        l(s);
      } catch {
        // listener errors must not break the client
      }
    }
  }

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  ready(): Promise<void> {
    if (this._state === 'open') return Promise.resolve();
    if (this._state === 'closed')
      return Promise.reject(new AccClientError('closed', 'Client is closed'));
    return new Promise((resolve, reject) => {
      const off = this.onStateChange((s) => {
        if (s === 'open') {
          off();
          resolve();
        } else if (s === 'closed') {
          off();
          reject(new AccClientError('closed', 'Client is closed'));
        }
      });
    });
  }

  // ---------------------------------------------------------------- connection

  private async resolveInfo(): Promise<ConnectionInfo> {
    if (this.options.connectionInfo) return this.options.connectionInfo();
    if (!this.options.url || !this.options.token) {
      throw new Error('createClient: url and token (or connectionInfo) are required');
    }
    return { url: this.options.url, token: this.options.token };
  }

  private async connect(): Promise<void> {
    if (this._state === 'closed') return;
    let info: ConnectionInfo;
    try {
      info = await this.resolveInfo();
    } catch {
      this.scheduleReconnect();
      return;
    }
    // close() may have been called while resolving connection info.
    if (this.isClosed()) return;
    const url = new URL(info.url);
    url.searchParams.set('token', info.token);
    if (this.options.clientName) url.searchParams.set('client', this.options.clientName);

    let ws: WebSocketLike;
    try {
      ws = this.options.webSocket
        ? this.options.webSocket(url.toString())
        : (new globalThis.WebSocket(url.toString()) as unknown as WebSocketLike);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let opened = false;
    const fail = () => {
      if (this.ws !== ws) return;
      clearTimeout(connectTimer);
      this.ws = null;
      try {
        ws.close();
      } catch {
        // already closing
      }
      this.onDisconnected();
    };
    // Never wait forever on a handshake that neither opens nor fails.
    const connectTimer = setTimeout(() => {
      if (!opened) fail();
    }, this.options.connectTimeoutMs ?? 10_000);

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      opened = true;
      clearTimeout(connectTimer);
      this.attempt = 0;
      this.setState('open');
      this.flushQueue();
      for (const sub of this.subs) void this.activate(sub);
    });
    ws.addEventListener('message', (ev: { data: unknown }) => {
      if (this.ws !== ws) return;
      if (typeof ev.data === 'string') this.onMessage(ev.data);
    });
    ws.addEventListener('close', fail);
    ws.addEventListener('error', () => {
      // Usually a close event follows, but Node's WebSocket (undici) only fires `error` when
      // the handshake is refused (e.g. 401), staying in CONNECTING. Treat that as a failure.
      if (!opened) fail();
    });
  }

  private onDisconnected(): void {
    for (const [id, p] of this.pending) {
      if (!p.sent) continue;
      this.pending.delete(id);
      p.cleanup();
      p.reject(new AccClientError('connection_lost', 'Connection lost before a response arrived'));
    }
    this.byServerId.clear();
    this.orphans = [];
    for (const sub of this.subs) {
      sub.serverId = null;
      sub.catchingUp = false;
      sub.buffer = [];
      sub.generation++;
    }
    if (this._state === 'closed') return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this._state === 'closed') return;
    if (this.options.reconnect === false) {
      this.close();
      return;
    }
    this.setState('reconnecting');
    const delay = backoffDelay(this.attempt++, this.options.reconnect ?? {});
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  close(): void {
    if (this._state === 'closed') return;
    this.setState('closed');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'client closed');
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.cleanup();
      p.reject(new AccClientError('closed', 'Client closed'));
    }
    this.subs.clear();
    this.byServerId.clear();
  }

  // ---------------------------------------------------------------- calls

  call<M extends MethodName>(method: M, ...args: CallArgs<M>): Promise<Result<M>> {
    const [params, opts] = args as [ParamsInput<M> | undefined, CallOptions | undefined];
    return this.request(method, params ?? {}, opts) as Promise<Result<M>>;
  }

  private request(method: string, params: unknown, opts: CallOptions = {}): Promise<unknown> {
    if (this._state === 'closed') {
      return Promise.reject(new AccClientError('closed', 'Client is closed'));
    }
    const id = this.nextId++;
    let timeoutMs = opts.timeoutMs ?? this.callTimeoutMs;
    const spec = (api as Record<string, { longPoll: boolean } | undefined>)[method];
    if (spec?.longPoll && opts.timeoutMs === undefined) {
      const t = (params as { timeoutMs?: unknown } | null)?.timeoutMs;
      timeoutMs += typeof t === 'number' ? t : 60_000;
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        entry.cleanup();
        reject(new AccClientError('closed', 'Call aborted'));
      };
      const entry: Pending = {
        resolve,
        reject,
        timer: null,
        sent: false,
        frame: JSON.stringify({ id, method, params }),
        timeoutMs,
        cleanup: () => {
          if (entry.timer) clearTimeout(entry.timer);
          opts.signal?.removeEventListener('abort', onAbort);
        },
      };
      if (opts.signal?.aborted) {
        reject(new AccClientError('closed', 'Call aborted'));
        return;
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      // The timeout covers queueing too, so a call never hangs forever while offline.
      entry.timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        entry.cleanup();
        reject(new AccClientError('timeout', `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, entry);
      if (this._state === 'open') this.send(entry);
    });
  }

  private send(p: Pending): void {
    if (!this.ws || this.ws.readyState !== OPEN) return;
    p.sent = true;
    this.ws.send(p.frame);
  }

  private flushQueue(): void {
    for (const p of this.pending.values()) if (!p.sent) this.send(p);
  }

  private onMessage(text: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    if (isPush(msg)) {
      this.onPush(msg.subscriptionId, msg);
      return;
    }
    const res = msg;
    if (typeof res.id !== 'number') return;
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    p.cleanup();
    if (isFailure(res))
      p.reject(new AccClientError(res.error.code, res.error.message, res.error.data));
    else p.resolve(res.result);
  }

  // ---------------------------------------------------------------- subscriptions

  subscribe(opts: SubscribeOptions): Subscription {
    const sub: Sub = {
      opts,
      lastSeq: opts.since ?? null,
      serverId: null,
      catchingUp: false,
      buffer: [],
      active: true,
      generation: 0,
    };
    this.subs.add(sub);
    if (this._state === 'open') void this.activate(sub);
    return {
      get lastSeq() {
        return sub.lastSeq;
      },
      unsubscribe: () => {
        if (!sub.active) return;
        sub.active = false;
        this.subs.delete(sub);
        if (sub.serverId) {
          this.byServerId.delete(sub.serverId);
          if (this._state === 'open') {
            this.request('events.unsubscribe', { subscriptionId: sub.serverId }).catch(() => {});
          }
        }
      },
    };
  }

  private filterOf(sub: Sub): EventFilter {
    const { projectId, sessionId, runId, taskId, types } = sub.opts;
    const f: EventFilter = {};
    if (projectId) f.projectId = projectId;
    if (sessionId) f.sessionId = sessionId;
    if (runId) f.runId = runId;
    if (taskId) f.taskId = taskId;
    if (types) f.types = types;
    return f;
  }

  private async activate(sub: Sub): Promise<void> {
    const gen = ++sub.generation;
    const stale = () => !sub.active || sub.generation !== gen;
    const filter = this.filterOf(sub);
    sub.catchingUp = sub.lastSeq !== null;
    sub.buffer = [];
    try {
      const res = (await this.request('events.subscribe', {
        ...filter,
        deltas: sub.opts.deltas ?? !!sub.opts.onDelta,
      })) as { subscriptionId: string; lastSeq: number };
      if (stale()) {
        if (sub.active === false && this._state === 'open') {
          this.request('events.unsubscribe', { subscriptionId: res.subscriptionId }).catch(
            () => {},
          );
        }
        return;
      }
      sub.serverId = res.subscriptionId;
      this.byServerId.set(res.subscriptionId, sub);
      if (sub.lastSeq === null) sub.lastSeq = res.lastSeq;
      this.drainOrphans(res.subscriptionId);

      if (sub.catchingUp) {
        let since = sub.lastSeq;
        for (;;) {
          const page = (await this.request('events.list', { ...filter, since, limit: 1000 })) as {
            events: Event[];
            lastSeq: number;
            hasMore: boolean;
          };
          if (stale()) return;
          for (const e of page.events) this.deliver(sub, e);
          since = page.lastSeq;
          if (!page.hasMore) break;
        }
        sub.catchingUp = false;
        const buffered = sub.buffer.sort((a, b) => a.seq - b.seq);
        sub.buffer = [];
        for (const e of buffered) this.deliver(sub, e);
      }
    } catch (err) {
      if (stale()) return;
      sub.catchingUp = false;
      sub.opts.onError?.(err);
    }
  }

  private drainOrphans(subscriptionId: string): void {
    const mine = this.orphans.filter((o) => o.subscriptionId === subscriptionId);
    if (mine.length === 0) return;
    this.orphans = this.orphans.filter((o) => o.subscriptionId !== subscriptionId);
    for (const o of mine) this.onPush(subscriptionId, o.msg);
  }

  private onPush(subscriptionId: string, msg: ServerMessage): void {
    const sub = this.byServerId.get(subscriptionId);
    if (!sub) {
      if (this.orphans.length < MAX_ORPHAN_PUSHES) this.orphans.push({ subscriptionId, msg });
      return;
    }
    if (!('type' in msg)) return;
    if (msg.type === 'delta') {
      try {
        sub.opts.onDelta?.(msg.delta);
      } catch (err) {
        sub.opts.onError?.(err);
      }
      return;
    }
    if (msg.type === 'event') {
      if (sub.catchingUp) sub.buffer.push(msg.event);
      else this.deliver(sub, msg.event);
    }
  }

  private deliver(sub: Sub, e: Event): void {
    if (sub.lastSeq !== null && e.seq <= sub.lastSeq) return;
    sub.lastSeq = e.seq;
    try {
      sub.opts.onEvent?.(e);
    } catch (err) {
      sub.opts.onError?.(err);
    }
  }
}
