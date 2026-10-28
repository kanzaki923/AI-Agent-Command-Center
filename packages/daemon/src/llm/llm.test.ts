import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Message } from '@acc/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../core/log';
import { HUMAN, type TestDaemonNoServer, createTestDaemon } from '../testing';
import { LlmGateway } from './gateway';
import { toChatMessages } from './messages';
import { MockProvider, mockCallInfo, scripted } from './mock';
import { OpenAiCompatibleProvider, OpenAiStreamAccumulator } from './openai';
import { SseParser } from './sse';
import { apiTools, methodForToolName, toolNameForMethod } from './tools';
import { type ChatRequest, LlmError, type LlmStreamEvent } from './types';

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible server (local HTTP, no real network)
// ---------------------------------------------------------------------------

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void | Promise<void>;

interface FakeServer {
  url: string;
  requests: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[];
  handler: Handler;
  close(): Promise<void>;
}

const servers: FakeServer[] = [];
let daemon: TestDaemonNoServer | null = null;
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  await daemon?.cleanup();
  daemon = null;
});

async function fakeServer(handler: Handler): Promise<FakeServer> {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => {
      fake.requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      });
      void Promise.resolve(fake.handler(req, body, res)).catch(() => res.destroy());
    });
  });
  let closed: Promise<void> | null = null;
  const fake: FakeServer = {
    url: '',
    requests: [],
    handler,
    close: () =>
      (closed ??= new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      })),
  };
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  servers.push(fake);
  return fake;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Write raw bytes in pieces (splitting lines, JSON and multi-byte characters). */
async function writeSplit(res: ServerResponse, text: string, pieces: number[]): Promise<void> {
  const bytes = Buffer.from(text, 'utf8');
  let at = 0;
  for (const n of pieces) {
    if (at >= bytes.length) break;
    res.write(bytes.subarray(at, at + n));
    at += n;
    await wait(2);
  }
  if (at < bytes.length) res.write(bytes.subarray(at));
}

const sse = (obj: unknown) => `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`;

async function collect(it: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const textOf = (events: LlmStreamEvent[]) =>
  events.map((e) => (e.type === 'text' ? e.text : '')).join('');

function provider(url: string | null, apiKey: string | null = 'sk-test-secret-key-123456') {
  return new OpenAiCompatibleProvider({
    connection: () => ({ baseUrl: url, apiKey }),
    pricing: (m) => (m === 'priced' ? { inputPerMTok: 1, outputPerMTok: 2 } : null),
  });
}

const req = (patch: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'gpt-test',
  messages: [{ role: 'user', content: 'こんにちは' }],
  ...patch,
});

// ---------------------------------------------------------------------------

describe('SseParser', () => {
  const stream =
    ': keep-alive\r\n' +
    'data: {"a":1}\r\n\r\n' +
    'event: custom\ndata: line1\ndata: line2\n\n' +
    'data:no-space\r\rdata: 日本語🎉\n\n' +
    'data: [DONE]';

  it('parses LF / CRLF / CR, comments, multi-line data and an unterminated last event', () => {
    const p = new SseParser();
    const out = [...p.push(stream), ...p.flush()];
    expect(out).toEqual([
      { event: 'message', data: '{"a":1}' },
      { event: 'custom', data: 'line1\nline2' },
      { event: 'message', data: 'no-space' },
      { event: 'message', data: '日本語🎉' },
      { event: 'message', data: '[DONE]' },
    ]);
  });

  it('gives the same result for every split position (incl. inside CRLF)', () => {
    const p0 = new SseParser();
    const expected = [...p0.push(stream), ...p0.flush()];
    for (let i = 1; i < stream.length; i++) {
      const p = new SseParser();
      const out = [...p.push(stream.slice(0, i)), ...p.push(stream.slice(i)), ...p.flush()];
      expect(out, `split at ${i}`).toEqual(expected);
    }
  });
});

describe('OpenAiStreamAccumulator', () => {
  it('joins tool-call argument fragments per index and resolves usage and cost', () => {
    const acc = new OpenAiStreamAccumulator('gpt', null);
    const chunks = [
      { choices: [{ index: 0, delta: { role: 'assistant', content: '考え' } }] },
      { choices: [{ index: 0, delta: { content: '中' } }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 1, id: 'call_b', function: { name: 'task__get', arguments: '' } },
                { index: 0, id: 'call_a', function: { name: 'session__', arguments: '{"li' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { name: 'list', arguments: 'mit": 5}' } },
                { index: 1, function: { arguments: '{"taskId":"x"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.0012 } },
    ];
    const events = chunks.flatMap((c) => acc.handle(JSON.stringify(c)));
    expect(acc.handle('[DONE]')).toEqual([]);
    expect(acc.done).toBe(true);
    const tail = acc.finish();
    expect(events).toEqual([
      { type: 'text', text: '考え' },
      { type: 'text', text: '中' },
    ]);
    expect(tail).toEqual([
      {
        type: 'tool_call',
        toolCall: { id: 'call_a', name: 'session__list', arguments: '{"limit": 5}' },
      },
      {
        type: 'tool_call',
        toolCall: { id: 'call_b', name: 'task__get', arguments: '{"taskId":"x"}' },
      },
      {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.0012, costSource: 'reported' },
      },
      { type: 'finish', reason: 'tool_calls' },
    ]);
  });

  it('cost: header when the stream has none, estimate with pricing, else unknown', () => {
    const usage = (acc: OpenAiStreamAccumulator) => {
      acc.handle(
        JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500 } }),
      );
      return acc.finish().find((e) => e.type === 'usage');
    };
    expect(usage(new OpenAiStreamAccumulator('gpt', 0.5))).toMatchObject({
      usage: { costUsd: 0.5, costSource: 'reported' },
    });
    // A zero header on a streamed response is sent before the cost is known: ignore it.
    expect(usage(new OpenAiStreamAccumulator('gpt', 0))).toMatchObject({
      usage: { costUsd: 0, costSource: 'unknown' },
    });
    const pricing = () => ({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(usage(new OpenAiStreamAccumulator('gpt', null, pricing))).toMatchObject({
      usage: { costUsd: 0.007, costSource: 'estimated' },
    });
  });

  it('surfaces stream errors and garbage as LlmError', () => {
    const acc = new OpenAiStreamAccumulator('gpt', null);
    expect(() => acc.handle('{"error":{"message":"rate limited"}}')).toThrow(/rate limited/);
    expect(() => acc.handle('not json')).toThrow(LlmError);
  });
});

describe('OpenAiCompatibleProvider (fake LiteLLM over HTTP)', () => {
  it('streams text split across chunks (mid-line, mid-UTF-8), tool calls, usage and header cost', async () => {
    const body =
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'こんにちは、' } }] }) +
      sse({ choices: [{ index: 0, delta: { content: '世界🌏' } }] }) +
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'session__get', arguments: '{"sess' },
                },
              ],
            },
          },
        ],
      }) +
      sse({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: 'ionId":"ses_1"}' } }] },
          },
        ],
      }) +
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
      sse({ id: 'x', choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } }) +
      sse('[DONE]');
    const server = await fakeServer(async (_req, _body, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-litellm-response-cost': '0.00042',
      });
      await writeSplit(res, body, [3, 7, 1, 20, 2, 5, 31, 1, 1, 64, 9]);
      res.end();
    });

    const events = await collect(
      provider(server.url).stream(
        req({
          tools: [{ name: 'session__get', description: 'd', parameters: { type: 'object' } }],
        }),
        new AbortController().signal,
      ),
    );
    expect(textOf(events)).toBe('こんにちは、世界🌏');
    expect(events.filter((e) => e.type === 'tool_call')).toEqual([
      {
        type: 'tool_call',
        toolCall: { id: 'call_1', name: 'session__get', arguments: '{"sessionId":"ses_1"}' },
      },
    ]);
    expect(events.at(-2)).toEqual({
      type: 'usage',
      usage: { inputTokens: 12, outputTokens: 7, costUsd: 0.00042, costSource: 'reported' },
    });
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' });

    const sent = server.requests[0]!;
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.headers.authorization).toBe('Bearer sk-test-secret-key-123456');
    const json = JSON.parse(sent.body) as Record<string, unknown>;
    expect(json).toMatchObject({
      model: 'gpt-test',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'こんにちは' }],
      tools: [{ type: 'function', function: { name: 'session__get', description: 'd' } }],
    });
  });

  it('maps HTTP errors to LlmError without leaking the key', async () => {
    const server = await fakeServer((_req, _body, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid key sk-test-secret-key-123456' } }));
    });
    const err = (await collect(
      provider(server.url).stream(req(), new AbortController().signal),
    ).catch((e: unknown) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe('llm_http_error');
    expect(err.status).toBe(401);
    expect(err.message).toContain('HTTP 401');
    expect(err.message).not.toContain('secret-key');
  });

  it('reports unreachable / unconfigured gateways in Japanese', async () => {
    const server = await fakeServer((_req, _body, res) => {
      res.end();
    });
    const url = server.url;
    await server.close();
    await expect(
      collect(provider(url).stream(req(), new AbortController().signal)),
    ).rejects.toMatchObject({
      code: 'llm_unreachable',
    });
    await expect(
      collect(provider(null).stream(req(), new AbortController().signal)),
    ).rejects.toMatchObject({
      code: 'llm_not_configured',
      message: expect.stringContaining('LiteLLM') as unknown,
    });
  });

  it('aborts mid-stream with an AbortError', async () => {
    const server = await fakeServer(async (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse({ choices: [{ index: 0, delta: { content: 'a' } }] }));
      await wait(5000);
      res.end();
    });
    const ac = new AbortController();
    const got: LlmStreamEvent[] = [];
    const p = (async () => {
      for await (const e of provider(server.url).stream(req(), ac.signal)) {
        got.push(e);
        ac.abort();
      }
    })();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(got).toEqual([{ type: 'text', text: 'a' }]);
  });
});

describe('MockProvider', () => {
  it('echoes deterministically in chunks with realistic timing', async () => {
    const mock = new MockProvider();
    mock.chunkDelayMs = 10;
    const started = Date.now();
    const events = await collect(
      mock.stream(req({ model: 'mock/echo' }), new AbortController().signal),
    );
    expect(textOf(events)).toBe('エコー: こんにちは');
    expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    expect(events.at(-2)).toMatchObject({
      type: 'usage',
      usage: { costSource: 'reported', costUsd: 0 },
    });

    const fast = await collect(
      mock.stream(req({ model: 'mock/fast' }), new AbortController().signal),
    );
    expect(textOf(fast)).toBe('エコー: こんにちは');
    await expect(
      collect(mock.stream(req({ model: 'mock/nope' }), new AbortController().signal)),
    ).rejects.toMatchObject({ code: 'llm_model_not_found' });
  });

  it('runs scripted multi-turn tool conversations keyed by the turn within a user message', async () => {
    const mock = new MockProvider();
    mock.chunkDelayMs = 0;
    mock.define(
      'mock/script',
      scripted([
        {
          text: 'まず一覧を見ます',
          toolCalls: [{ id: 'c1', name: 'session__list', input: { limit: 1 } }],
        },
        (_r, info) => ({ text: `結果: ${info.toolResults.map((t) => t.content).join(',')}` }),
      ]),
    );
    const turn0 = await collect(
      mock.stream(req({ model: 'mock/script' }), new AbortController().signal),
    );
    expect(textOf(turn0)).toBe('まず一覧を見ます');
    expect(turn0.find((e) => e.type === 'tool_call')).toEqual({
      type: 'tool_call',
      toolCall: { id: 'c1', name: 'session__list', arguments: '{"limit":1}' },
    });
    const followUp: ChatRequest = req({
      model: 'mock/script',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'まず一覧を見ます',
          toolCalls: [{ id: 'c1', name: 'session__list', arguments: '{}' }],
        },
        { role: 'tool', toolCallId: 'c1', content: '{"items":[]}' },
      ],
    });
    expect(mockCallInfo(followUp)).toMatchObject({ turn: 1, lastUserText: 'go' });
    expect(textOf(await collect(mock.stream(followUp, new AbortController().signal)))).toBe(
      '結果: {"items":[]}',
    );
    // Past the script: empty answer (ends a tool loop).
    const done = await collect(
      mock.stream(
        { ...followUp, messages: [...followUp.messages, { role: 'assistant', content: 'x' }] },
        new AbortController().signal,
      ),
    );
    expect(textOf(done)).toBe('');
  });

  it('stops promptly on abort', async () => {
    const mock = new MockProvider();
    mock.chunkDelayMs = 50;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    await expect(
      collect(mock.stream(req({ model: 'mock/echo' }), ac.signal)),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('LlmGateway.listModels', () => {
  it('merges LiteLLM /models with mocks, caches, refreshes and tolerates failure', async () => {
    let fail = false;
    const server = await fakeServer((_req, _body, res) => {
      if (fail) {
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-a' }, { id: 'claude-b' }] }));
    });
    let baseUrl: string | null = server.url;
    let now = 0;
    const gw = new LlmGateway({
      connection: () => ({ baseUrl, apiKey: null }),
      defaultModel: () => 'configured-x',
      log: silentLogger,
      now: () => now,
      modelsTtlMs: 1000,
    });
    const first = await gw.listModels();
    expect(first.source).toBe('litellm');
    expect(first.models.map((m) => m.id)).toEqual([
      'configured-x',
      'gpt-a',
      'claude-b',
      'mock/echo',
      'mock/fast',
    ]);
    fail = true;
    await gw.listModels(); // cached
    expect(server.requests).toHaveLength(1);
    now = 2000;
    const failed = await gw.listModels();
    expect(failed.source).toBe('config');
    expect(failed.models.map((m) => m.id)).toEqual(['configured-x', 'mock/echo', 'mock/fast']);
    fail = false;
    expect((await gw.listModels(true)).source).toBe('litellm');
    baseUrl = null;
    expect((await gw.listModels()).source).toBe('mock');
  });

  it('is exposed as models.list', async () => {
    daemon = await createTestDaemon();
    const res = await daemon.call(HUMAN, 'models.list', {});
    expect(res.source).toBe('mock');
    expect(res.models.map((m) => m.id)).toContain('mock/echo');
  });
});

describe('history conversion', () => {
  const base = {
    sessionId: 'ses_00000000000000000000000000',
    runId: null,
    author: HUMAN,
    model: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const msg = (id: number, patch: Pick<Message, 'role' | 'content'>): Message => ({
    ...base,
    id: `msg_${String(id).padStart(26, '0')}`,
    ...patch,
  });

  it('maps method names to tool names and repairs interrupted tool calls', () => {
    const out = toChatMessages(
      [
        msg(1, { role: 'user', content: [{ type: 'text', text: 'hi' }] }),
        msg(2, {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'hmm' },
            { type: 'text', text: 'checking' },
            { type: 'tool_call', toolCallId: 'a', name: 'session.list', input: { limit: 1 } },
            { type: 'tool_call', toolCallId: 'b', name: 'task.get', input: '{bad' },
          ],
        }),
        msg(3, {
          role: 'tool',
          content: [
            { type: 'tool_result', toolCallId: 'a', output: { items: [] }, isError: false },
          ],
        }),
        // b never got a result (run interrupted); an orphan result follows later
        msg(4, { role: 'user', content: [{ type: 'text', text: 'again' }] }),
        msg(5, {
          role: 'tool',
          content: [{ type: 'tool_result', toolCallId: 'zzz', output: 1, isError: false }],
        }),
      ],
      { systemPrompt: 'be nice' },
    );
    expect(out).toEqual([
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'checking',
        toolCalls: [
          { id: 'a', name: 'session__list', arguments: '{"limit":1}' },
          { id: 'b', name: 'task__get', arguments: '{bad' },
        ],
      },
      { role: 'tool', toolCallId: 'a', content: '{"items":[]}' },
      { role: 'tool', toolCallId: 'b', content: expect.stringContaining('no_result') as unknown },
      { role: 'user', content: 'again' },
    ]);
  });
});

describe('API tools', () => {
  it('maps names both ways and only offers methods the actor is granted', async () => {
    expect(toolNameForMethod('task.spawnWorker')).toBe('task__spawnWorker');
    expect(methodForToolName('task__spawnWorker')).toBe('task.spawnWorker');

    daemon = await createTestDaemon();
    const { ctx } = daemon;
    const session = await daemon.call(HUMAN, 'session.create', {});
    const actor = { kind: 'agent' as const, sessionId: session.id, runId: ctx.ids.next('run') };
    expect(apiTools(ctx, actor)).toEqual([]);
    // Humans get every implemented tool-enabled method, never `tool: false` ones.
    const all = apiTools(ctx, HUMAN).map((t) => t.name);
    expect(all).toContain('session__list');
    expect(all).not.toContain('settings__update');
    expect(all).not.toContain('events__subscribe');

    ctx.repos.grants.insert({
      id: ctx.ids.next('grant'),
      subject: { kind: 'session', sessionId: session.id },
      parentGrantId: null,
      permissions: ['session.list', 'session.get', 'settings.*'],
      scope: {},
      limits: {},
      depth: 0,
      lifetime: 'session',
      expiresAt: null,
      revokedAt: null,
      reason: null,
      grantedBy: HUMAN,
      createdAt: ctx.clock.iso(),
    });
    const tools = apiTools(ctx, actor);
    expect(tools.map((t) => t.name).sort()).toEqual(['session__get', 'session__list']);
    const list = tools.find((t) => t.name === 'session__list')!;
    expect(list.method).toBe('session.list');
    expect(list.parameters).toMatchObject({ type: 'object' });
    expect(list.parameters).not.toHaveProperty('$schema');
    const res = (await list.execute({}, { signal: new AbortController().signal })) as {
      items: unknown[];
    };
    expect(res.items).toHaveLength(1);
  });
});
