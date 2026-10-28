import { timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  HEALTH_PATH,
  PROTOCOL_VERSION,
  type RpcResponse,
  RpcRequest,
  type ServerMessage,
  WS_PATH,
} from '@acc/protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import type { DaemonContext } from '../core/context';
import type { Logger } from '../core/log';
import type { Connection } from './connection';
import { type Dispatcher, toRpcError } from './dispatcher';

export interface ServerOptions {
  host: string;
  port: number;
  token: string;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

const MAX_PAYLOAD = 16 * 1024 * 1024;

function tokenMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Web origins that may open the Control API: the desktop shell and local dev servers. A
 * request without `Origin` is not from a web page (CLI, tests). Defense in depth behind the
 * token: a page elsewhere that somehow learned it still cannot connect.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  if (origin === 'tauri://localhost') return true;
  return /^https?:\/\/(?:tauri\.localhost|localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin);
}

/**
 * HTTP + WebSocket server.
 * - `GET /health` (no auth): liveness for launchers.
 * - `GET /ws?token=...&client=...`: JSON-RPC over WebSocket. Every connection acts as a
 *   `human` actor (the token proves it is the local user).
 */
export async function startServer(
  ctx: DaemonContext,
  dispatcher: Dispatcher,
  opts: ServerOptions,
): Promise<RunningServer> {
  const log = ctx.log.child('server');
  const connections = new Map<WebSocket, ConnectionImpl>();

  const http: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === HEALTH_PATH) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(
        JSON.stringify({
          ok: true,
          service: 'acc-daemon',
          pid: process.pid,
          version: ctx.version,
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  const refuse = (socket: Duplex, status: string) => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
      socket.destroy(),
    );
  };

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== WS_PATH) {
      refuse(socket, '404 Not Found');
      return;
    }
    if (!tokenMatches(url.searchParams.get('token'), opts.token)) {
      refuse(socket, '401 Unauthorized');
      return;
    }
    if (!isAllowedOrigin(req.headers.origin)) {
      refuse(socket, '403 Forbidden');
      return;
    }
    const client = url.searchParams.get('client') ?? undefined;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = new ConnectionImpl(ctx.ids.next('connection'), ws, client, log);
      connections.set(ws, conn);
      log.debug('client connected', { id: conn.id, client });
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const text = Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]).toString('utf8');
        void handleMessage(conn, text);
      });
      ws.on('close', () => {
        connections.delete(ws);
        conn.dispose();
        log.debug('client disconnected', { id: conn.id });
      });
      ws.on('error', (err) => log.warn('socket error', { id: conn.id, err }));
    });
  });

  async function handleMessage(conn: ConnectionImpl, text: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      conn.send({ id: null, error: { code: 'invalid_params', message: 'Invalid JSON' } });
      return;
    }
    const req = RpcRequest.safeParse(raw);
    if (!req.success) {
      const id = (raw as { id?: unknown } | null)?.id;
      conn.send({
        id: typeof id === 'number' || typeof id === 'string' ? id : null,
        error: { code: 'invalid_params', message: 'Invalid request envelope' },
      });
      return;
    }
    const { id, method, params } = req.data;
    let response: RpcResponse;
    try {
      const result = await dispatcher.dispatch({
        actor: conn.actor,
        method,
        params,
        connection: conn,
        signal: conn.signal,
      });
      response = { id, result };
    } catch (err) {
      response = { id, error: toRpcError(err, log) };
    }
    conn.send(response);
  }

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.host, () => {
      http.off('error', reject);
      resolve();
    });
  });
  const port = (http.address() as AddressInfo).port;
  log.info('listening', { host: opts.host, port });

  return {
    port,
    async close() {
      for (const [ws, conn] of connections) {
        conn.dispose();
        ws.close(1001, 'daemon shutting down');
      }
      wss.close();
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    },
  };
}

class ConnectionImpl implements Connection {
  readonly actor;
  readonly subscriptions = new Map<string, () => void>();
  private readonly abort = new AbortController();
  private disposed = false;

  constructor(
    readonly id: string,
    private readonly ws: WebSocket,
    client: string | undefined,
    private readonly log: Logger,
  ) {
    this.actor = client ? { kind: 'human' as const, client } : { kind: 'human' as const };
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get closed(): boolean {
    return this.disposed || this.ws.readyState !== this.ws.OPEN;
  }

  send(msg: ServerMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      this.log.warn('send failed', { id: this.id, err });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
  }
}
