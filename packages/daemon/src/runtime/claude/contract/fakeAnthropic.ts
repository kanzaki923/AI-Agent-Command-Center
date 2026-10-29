import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * A local stand-in for the Anthropic Messages API, for driving the REAL Claude Code CLI at
 * zero cost (contract tests and fixture recording; never used at runtime).
 *
 * - `POST /v1/messages`: SSE streaming exactly like the real API (message_start,
 *   content_block_start/delta/stop for text / thinking / tool_use with input_json_delta,
 *   message_delta with usage + stop_reason, message_stop), or a JSON Message when the
 *   request does not ask for `stream`.
 * - `POST /v1/messages/count_tokens`: a rough count.
 * - Anything else: 404 with an API-style JSON error.
 *
 * Replies are scripted: main-loop requests (those that carry tools) consume `turns` in order,
 * each a function of the incoming request (so a turn can look at the tool_result the CLI
 * sent back). Side requests (titles, summaries, ...) go to `aux`. Every request is logged
 * with auth headers redacted.
 */

export type FakeBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id?: string; name: string; input: Record<string, unknown> };

export interface FakeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface FakeReply {
  content: FakeBlock[];
  /** Default: "tool_use" when the content has a tool_use block, else "end_turn". */
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage?: FakeUsage;
  /** Delay between SSE events (ms). */
  chunkDelayMs?: number;
  /**
   * Keep the response open forever after this many text deltas (for interrupt tests). The
   * connection is only ended by the client or `close()`.
   */
  hangAfterDeltas?: number;
  /** Answer with an HTTP error instead of a message. */
  error?: { status: number; type: string; message: string };
}

/** What a scripted turn sees of the request. */
export interface FakeRequest {
  path: string;
  body: MessagesBody;
  /** tool_result blocks of the last user message (what the CLI sent back). */
  toolResults: { tool_use_id: string; content: unknown; is_error: boolean }[];
  /** Index of this main-loop request (0-based; -1 for aux and intercepted requests). */
  turn: number;
  /** Request headers, credentials redacted. */
  headers: Record<string, string>;
}

export type FakeTurn = (req: FakeRequest) => FakeReply;

export interface MessagesBody {
  model?: string;
  stream?: boolean;
  max_tokens?: number;
  system?: unknown;
  tools?: { name: string }[];
  messages?: { role: string; content: unknown }[];
  thinking?: unknown;
  [key: string]: unknown;
}

export interface LoggedRequest {
  at: string;
  method: string;
  path: string;
  /** Header values, with credentials replaced by "<redacted>". */
  headers: Record<string, string>;
  kind: 'main' | 'aux' | 'count_tokens' | 'other';
  summary: {
    model?: string;
    stream?: boolean;
    maxTokens?: number;
    tools?: string[];
    messages?: number;
    lastUser?: string;
    thinking?: unknown;
    bodyKeys?: string[];
  };
  status: number;
}

export interface FakeAnthropicOptions {
  turns?: FakeTurn[];
  /** Replies to requests without tools (titles, summaries). Default: a short text. */
  aux?: (req: FakeRequest) => FakeReply;
  /** When the scripted turns run out. Default: a plain "done" text. */
  fallback?: FakeTurn;
  /**
   * Characters per input_json_delta (default 12, like the real API's small chunks). The
   * fixture recorder sends tool inputs whole so paths in them can be sanitized.
   */
  jsonChunkSize?: number;
  /**
   * Looked at before the script: a reply here answers the request without consuming a turn
   * (e.g. the auto mode classifier's side requests, which carry tools of their own).
   */
  intercept?: (req: FakeRequest) => FakeReply | undefined;
  /** Keep every request body (probes only; bodies can be large). */
  keepBodies?: boolean;
}

const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'proxy-authorization', 'cookie']);

export class FakeAnthropicServer {
  readonly requests: LoggedRequest[] = [];
  /** Full bodies with their headers, when `keepBodies` is set. */
  readonly bodies: {
    kind: LoggedRequest['kind'] | 'intercepted';
    headers: Record<string, string>;
    body: MessagesBody;
  }[] = [];
  private readonly server: http.Server;
  private readonly sockets = new Set<Socket>();
  private turns: FakeTurn[];
  private mainCount = 0;
  private aux: (req: FakeRequest) => FakeReply;
  private fallback: FakeTurn;
  private port = 0;
  private readonly jsonChunkSize: number;
  private readonly intercept: FakeAnthropicOptions['intercept'];
  private readonly keepBodies: boolean;

  constructor(opts: FakeAnthropicOptions = {}) {
    this.jsonChunkSize = opts.jsonChunkSize ?? 12;
    this.intercept = opts.intercept;
    this.keepBodies = opts.keepBodies ?? false;
    this.turns = [...(opts.turns ?? [])];
    this.aux = opts.aux ?? (() => ({ content: [{ type: 'text', text: 'Fake title' }] }));
    this.fallback = opts.fallback ?? (() => ({ content: [{ type: 'text', text: 'done' }] }));
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
  }

  /** Replace the remaining script (between runs of one test). */
  script(turns: FakeTurn[]): void {
    this.turns = [...turns];
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Main-loop requests answered so far. */
  get mainRequests(): LoggedRequest[] {
    return this.requests.filter((r) => r.kind === 'main');
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
    return this.url;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const raw = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let body: MessagesBody;
    try {
      body = raw ? (JSON.parse(raw) as MessagesBody) : {};
    } catch {
      body = {};
    }
    const entry: LoggedRequest = {
      at: new Date().toISOString(),
      method: req.method ?? 'GET',
      path: url.pathname + url.search,
      headers: redactHeaders(req.headers),
      kind: 'other',
      summary: summarize(body),
      status: 200,
    };
    this.requests.push(entry);

    if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
      entry.kind = 'count_tokens';
      sendJson(res, 200, { input_tokens: Math.max(1, Math.round(raw.length / 4)) });
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
      entry.status = 404;
      sendJson(res, 404, apiError('not_found_error', `Not found: ${url.pathname}`));
      return;
    }

    const isMain = Array.isArray(body.tools) && body.tools.length > 0;
    entry.kind = isMain ? 'main' : 'aux';
    const probe: FakeRequest = {
      path: entry.path,
      body,
      toolResults: lastToolResults(body),
      turn: -1,
      headers: entry.headers,
    };
    const intercepted = this.intercept?.(probe);
    if (this.keepBodies) {
      this.bodies.push({
        kind: intercepted ? 'intercepted' : entry.kind,
        headers: entry.headers,
        body,
      });
    }
    const view: FakeRequest = { ...probe, turn: isMain && !intercepted ? this.mainCount : -1 };
    let reply: FakeReply;
    if (intercepted) {
      entry.kind = 'aux';
      reply = intercepted;
    } else if (isMain) {
      const next = this.turns.shift() ?? this.fallback;
      this.mainCount += 1;
      reply = next(view);
    } else {
      reply = this.aux(view);
    }

    if (reply.error) {
      entry.status = reply.error.status;
      sendJson(res, reply.error.status, apiError(reply.error.type, reply.error.message));
      return;
    }
    const message = buildMessage(body.model ?? 'claude-fake', reply);
    if (body.stream) {
      await streamMessage(res, message, reply, this.jsonChunkSize);
    } else {
      sendJson(res, 200, message);
    }
  }
}

// ---- message building -----------------------------------------------------------------

interface ApiMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Record<string, unknown>[];
  stop_reason: string;
  stop_sequence: null;
  usage: Required<FakeUsage> & { service_tier: string };
}

function buildMessage(model: string, reply: FakeReply): ApiMessage {
  const hasTool = reply.content.some((b) => b.type === 'tool_use');
  const content = reply.content.map((b): Record<string, unknown> => {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text };
      case 'thinking':
        return { type: 'thinking', thinking: b.thinking, signature: fakeSignature() };
      case 'tool_use':
        return { type: 'tool_use', id: b.id ?? fakeId('toolu'), name: b.name, input: b.input };
    }
  });
  const text = JSON.stringify(reply.content);
  return {
    id: fakeId('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: reply.stopReason ?? (hasTool ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: reply.usage?.input_tokens ?? 100,
      output_tokens: reply.usage?.output_tokens ?? Math.max(1, Math.round(text.length / 4)),
      cache_read_input_tokens: reply.usage?.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: reply.usage?.cache_creation_input_tokens ?? 0,
      service_tier: 'standard',
    },
  };
}

async function streamMessage(
  res: http.ServerResponse,
  message: ApiMessage,
  reply: FakeReply,
  jsonChunkSize: number,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'request-id': fakeId('req'),
  });
  const delay = reply.chunkDelayMs ?? 0;
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  const send = async (event: string, data: unknown) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (delay > 0) await sleep(delay);
  };

  const { content: _content, ...head } = message;
  await send('message_start', {
    type: 'message_start',
    message: {
      ...head,
      content: [],
      stop_reason: null,
      usage: { ...message.usage, output_tokens: 1 },
    },
  });
  await send('ping', { type: 'ping' });

  let deltas = 0;
  for (const [index, block] of message.content.entries()) {
    if (block.type === 'text') {
      await send('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      for (const piece of chunks(String(block.text), 8)) {
        await send('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: piece },
        });
        deltas += 1;
        if (reply.hangAfterDeltas !== undefined && deltas >= reply.hangAfterDeltas) {
          // Leave the stream open; the client (interrupt) or close() ends it.
          await new Promise<void>((r) => res.on('close', () => r()));
          return;
        }
      }
    } else if (block.type === 'thinking') {
      await send('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      });
      for (const piece of chunks(String(block.thinking), 16)) {
        await send('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'thinking_delta', thinking: piece },
        });
      }
      await send('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: block.signature },
      });
    } else if (block.type === 'tool_use') {
      await send('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      for (const piece of chunks(JSON.stringify(block.input), jsonChunkSize)) {
        await send('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: piece },
        });
      }
    }
    await send('content_block_stop', { type: 'content_block_stop', index });
  }
  await send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: {
      input_tokens: message.usage.input_tokens,
      cache_creation_input_tokens: message.usage.cache_creation_input_tokens,
      cache_read_input_tokens: message.usage.cache_read_input_tokens,
      output_tokens: message.usage.output_tokens,
    },
  });
  await send('message_stop', { type: 'message_stop' });
  if (!closed) res.end();
}

// ---- helpers --------------------------------------------------------------------------

function chunks(s: string, size: number): string[] {
  if (!s) return [''];
  const out: string[] = [];
  const chars = [...s];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

function fakeId(prefix: string): string {
  return `${prefix}_fake${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

function fakeSignature(): string {
  return Buffer.from(`fake-signature-${randomUUID()}`).toString('base64');
}

function apiError(type: string, message: string) {
  return { type: 'error', error: { type, message }, request_id: fakeId('req') };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'request-id': fakeId('req'),
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function redactHeaders(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k] = SECRET_HEADERS.has(k.toLowerCase())
      ? '<redacted>'
      : Array.isArray(v)
        ? v.join(', ')
        : v;
  }
  return out;
}

function summarize(body: MessagesBody): LoggedRequest['summary'] {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages.at(-1);
  return {
    ...(body.model !== undefined ? { model: body.model } : {}),
    ...(body.stream !== undefined ? { stream: body.stream } : {}),
    ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
    ...(Array.isArray(body.tools) ? { tools: body.tools.map((t) => t.name) } : {}),
    messages: messages.length,
    ...(last ? { lastUser: describeContent(last.content) } : {}),
    ...(body.thinking !== undefined ? { thinking: body.thinking } : {}),
    bodyKeys: Object.keys(body).sort(),
  };
}

function describeContent(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 120);
  if (!Array.isArray(content)) return '';
  return content
    .map((b: { type?: string; text?: string; content?: unknown }) => {
      if (b.type === 'text') return `text:${String(b.text).slice(0, 80)}`;
      if (b.type === 'tool_result') return `tool_result:${JSON.stringify(b.content).slice(0, 120)}`;
      return String(b.type);
    })
    .join(' | ');
}

function lastToolResults(body: MessagesBody): FakeRequest['toolResults'] {
  const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined;
  if (!last || last.role !== 'user' || !Array.isArray(last.content)) return [];
  return (last.content as Record<string, unknown>[])
    .filter((b) => b.type === 'tool_result')
    .map((b) => ({
      tool_use_id: String(b.tool_use_id),
      content: b.content,
      is_error: b.is_error === true,
    }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- egress guard -----------------------------------------------------------------------

/**
 * An HTTP(S) proxy that refuses everything and records where the client tried to go. Handed
 * to the CLI as HTTPS_PROXY / HTTP_PROXY (with NO_PROXY for 127.0.0.1) so any attempt to
 * reach a real host is both blocked and visible.
 */
export class BlockingProxy {
  readonly attempts: { method: string; target: string }[] = [];
  private readonly server: http.Server;
  private readonly sockets = new Set<Socket>();
  private port = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      this.attempts.push({ method: req.method ?? 'GET', target: req.url ?? '' });
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('blocked by test proxy');
    });
    this.server.on('connect', (req: http.IncomingMessage, socket: Socket) => {
      this.attempts.push({ method: 'CONNECT', target: req.url ?? '' });
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
    return this.url;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
