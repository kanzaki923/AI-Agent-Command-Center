/**
 * Providers beside LiteLLM (snapshot 20261030_providers): the Anthropic Messages API, the
 * OpenAI Responses API by key and by ChatGPT plan, "Sign in with ChatGPT" against a fake
 * authorization server, the gateway's routing by prefix, and the settings behind them.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChatGptCredentials } from '@acc/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../core/log';
import { HUMAN, type TestDaemonNoServer, createTestDaemon } from '../testing';
import { AnthropicProvider, toMessagesBody } from './anthropic';
import { ChatGptAuth } from './chatgptAuth';
import { LlmGateway, providerOf } from './gateway';
import { APP_NOTE_LABEL } from './messages';
import { OpenAiResponsesProvider, toResponsesBody } from './openaiResponses';
import { type ChatRequest, LlmError, type LlmStreamEvent } from './types';

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void | Promise<void>;

interface Fake {
  url: string;
  requests: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[];
  handler: Handler;
  close(): Promise<void>;
}

const fakes: Fake[] = [];
let daemon: TestDaemonNoServer | null = null;
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
  await daemon?.cleanup();
  daemon = null;
});

async function fake(handler: Handler): Promise<Fake> {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => {
      f.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      void Promise.resolve(f.handler(req, body, res)).catch(() => res.destroy());
    });
  });
  const f: Fake = {
    url: '',
    requests: [],
    handler,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fakes.push(f);
  return f;
}

/** Write SSE events (`event:` + `data:`), then end. */
function sse(res: ServerResponse, events: { event?: string; data: unknown }[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) {
    if (e.event) res.write(`event: ${e.event}\n`);
    res.write(`data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`);
  }
  res.end();
}

async function collect(stream: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

const signal = () => new AbortController().signal;

const REQUEST: ChatRequest = {
  model: 'anthropic/claude-sonnet-4-6',
  messages: [
    { role: 'system', content: 'You are the assistant.' },
    { role: 'user', content: '止めて' },
    {
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'toolu_1', name: 'session__stop', arguments: '{"sessionId":"ses_1"}' }],
    },
    { role: 'tool', toolCallId: 'toolu_1', content: '{"ok":true}' },
    { role: 'user', content: 'ありがとう' },
    // What changes per run comes last (supervisor / assistant status).
    { role: 'system', content: 'Status: 1 tree' },
  ],
  tools: [
    { name: 'session__stop', description: 'Stop', parameters: { type: 'object', properties: {} } },
    { name: 'home__get', description: 'Home', parameters: { type: 'object', properties: {} } },
  ],
  temperature: 0.2,
};

describe('Anthropic Messages API', () => {
  it('builds the body: cached system block, merged turns, tool_use / tool_result, cached last tool, cached history', () => {
    const body = toMessagesBody(REQUEST);
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(8192);
    expect(body.temperature).toBe(0.2);
    expect(body.system).toEqual([
      { type: 'text', text: 'You are the assistant.', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '止めて' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'session__stop', input: { sessionId: 'ses_1' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' },
          // The history ends here: the next run reads it back from the cache.
          { type: 'text', text: 'ありがとう', cache_control: { type: 'ephemeral' } },
          // The status follows the history, labelled as the app's (it travels as a user
          // turn); the last block is marked for the next call.
          {
            type: 'text',
            text: `${APP_NOTE_LABEL}\nStatus: 1 tree`,
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ]);
    // Four marks at most (last tool, system, the end of the history, the last block).
    expect(JSON.stringify(body).split('cache_control').length - 1).toBeLessThanOrEqual(4);
    const tools = body.tools as Record<string, unknown>[];
    expect(tools[0]).toEqual({
      name: 'session__stop',
      description: 'Stop',
      input_schema: { type: 'object', properties: {} },
    });
    expect(tools[1]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('the next call of a tool loop keeps the end of the history marked and marks its new last block', () => {
    const body = toMessagesBody({
      ...REQUEST,
      messages: [
        ...REQUEST.messages,
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'toolu_2', name: 'home__get', arguments: '{}' }],
        },
        { role: 'tool', toolCallId: 'toolu_2', content: '{"trees":[]}' },
      ],
    });
    const messages = body.messages as { role: string; content: Record<string, unknown>[] }[];
    const marked = messages.flatMap((m) => m.content.filter((b) => b.cache_control));
    expect(marked.map((b) => b.text ?? b.type)).toEqual(['ありがとう', 'tool_result']);
    expect(messages.at(-1)!.content.at(-1)).toMatchObject({ tool_use_id: 'toolu_2' });
    expect(JSON.stringify(body).split('cache_control').length - 1).toBeLessThanOrEqual(4);
  });

  it('streams text, thinking, a tool call and usage with cache tokens priced in', async () => {
    const f = await fake((req, _body, res) => {
      expect(req.url).toBe('/v1/messages');
      expect(req.headers['x-api-key']).toBe('sk-ant-test');
      expect(req.headers['anthropic-version']).toBe('2023-06-01');
      sse(res, [
        {
          event: 'message_start',
          data: {
            type: 'message_start',
            message: {
              usage: {
                input_tokens: 100,
                cache_read_input_tokens: 5000,
                cache_creation_input_tokens: 1000,
                output_tokens: 1,
              },
            },
          },
        },
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '' },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: '考える' },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'signature_delta', signature: 'sig' },
          },
        },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'text', text: '' },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: '止め' },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: 'ます' },
          },
        },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 2,
            content_block: { type: 'tool_use', id: 'toolu_9', name: 'session__stop', input: {} },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 2,
            delta: { type: 'input_json_delta', partial_json: '{"session' },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 2,
            delta: { type: 'input_json_delta', partial_json: 'Id":"ses_1"}' },
          },
        },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
        {
          event: 'message_delta',
          data: {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 40 },
          },
        },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]);
    });
    const provider = new AnthropicProvider({
      connection: () => ({ apiKey: 'sk-ant-test', baseUrl: f.url }),
      pricing: () => ({
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
      }),
    });
    const events = await collect(provider.stream(REQUEST, signal()));
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('止めます');
    expect(events.find((e) => e.type === 'reasoning')).toEqual({
      type: 'reasoning',
      text: '考える',
    });
    expect(events.find((e) => e.type === 'thinking_blocks')).toEqual({
      type: 'thinking_blocks',
      blocks: [{ type: 'thinking', thinking: '考える', signature: 'sig' }],
    });
    expect(events.find((e) => e.type === 'tool_call')).toEqual({
      type: 'tool_call',
      toolCall: { id: 'toolu_9', name: 'session__stop', arguments: '{"sessionId":"ses_1"}' },
    });
    const usage = (events.find((e) => e.type === 'usage') as { usage: Record<string, unknown> })
      .usage;
    // 100 fresh + 5000 cached + 1000 written in; 40 out.
    expect(usage).toMatchObject({
      inputTokens: 6100,
      outputTokens: 40,
      cacheReadTokens: 5000,
      cacheWriteTokens: 1000,
      costSource: 'estimated',
    });
    const expected = (100 * 3 + 40 * 15 + 5000 * 0.3 + 1000 * 3.75) / 1_000_000;
    expect(usage.costUsd).toBeCloseTo(expected, 9);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' });
  });

  it('explains auth and unknown-model answers without the key, and refuses without one', async () => {
    const f = await fake((_req, _body, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'invalid x-api-key sk-ant-secret1234567',
          },
        }),
      );
    });
    const provider = new AnthropicProvider({
      connection: () => ({ apiKey: 'sk-ant-test', baseUrl: f.url }),
    });
    const err = await collect(provider.stream(REQUEST, signal())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe('llm_http_error');
    expect((err as LlmError).message).toContain('Anthropic の API キー');
    expect((err as LlmError).message).not.toContain('secret1234567');

    f.handler = (_req, _body, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'not_found_error', message: 'model: claude-x' },
        }),
      );
    };
    const missing = await collect(provider.stream(REQUEST, signal())).catch((e: unknown) => e);
    expect((missing as LlmError).code).toBe('llm_model_not_found');

    const none = new AnthropicProvider({ connection: () => ({ apiKey: null, baseUrl: null }) });
    const unconfigured = await collect(none.stream(REQUEST, signal())).catch((e: unknown) => e);
    expect((unconfigured as LlmError).code).toBe('llm_not_configured');
  });
});

describe('OpenAI Responses API', () => {
  const req: ChatRequest = { ...REQUEST, model: 'openai/gpt-5-mini' };

  it('builds the body: instructions, input items with function calls and outputs, no temperature on a plan', () => {
    const key = toResponsesBody(req, 'key');
    expect(key.model).toBe('gpt-5-mini');
    expect(key).toMatchObject({ stream: true, store: false, temperature: 0.2 });
    // Only the leading system message is the instructions; the status stays at the end.
    expect(key.instructions).toBe('You are the assistant.');
    expect(key.input).toEqual([
      { role: 'user', content: '止めて' },
      {
        type: 'function_call',
        call_id: 'toolu_1',
        name: 'session__stop',
        arguments: '{"sessionId":"ses_1"}',
      },
      { type: 'function_call_output', call_id: 'toolu_1', output: '{"ok":true}' },
      { role: 'user', content: 'ありがとう' },
      { role: 'developer', content: 'Status: 1 tree' },
    ]);
    expect((key.tools as unknown[])[0]).toEqual({
      type: 'function',
      name: 'session__stop',
      description: 'Stop',
      parameters: { type: 'object', properties: {} },
      strict: false,
    });
    const plan = toResponsesBody(req, 'chatgpt');
    expect(plan.temperature).toBeUndefined();
    expect(plan.max_output_tokens).toBeUndefined();
    expect(plan.store).toBe(false);
  });

  const EVENTS = [
    { data: { type: 'response.created', response: { id: 'resp_1' } } },
    {
      data: {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', summary: [] },
      },
    },
    { data: { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: '考え' } },
    {
      data: {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc', summary: [] },
      },
    },
    {
      data: {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'message', id: 'msg_1', role: 'assistant' },
      },
    },
    { data: { type: 'response.output_text.delta', item_id: 'msg_1', delta: '止め' } },
    { data: { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'ます' } },
    {
      data: {
        type: 'response.output_item.added',
        output_index: 2,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'session__stop',
          arguments: '',
        },
      },
    },
    {
      data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"session' },
    },
    {
      data: {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: 'Id":"ses_1"}',
      },
    },
    {
      data: {
        type: 'response.function_call_arguments.done',
        item_id: 'fc_1',
        arguments: '{"sessionId":"ses_1"}',
      },
    },
    {
      data: {
        type: 'response.output_item.done',
        output_index: 2,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'session__stop',
          arguments: '{"sessionId":"ses_1"}',
        },
      },
    },
    {
      data: {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: {
            input_tokens: 1000,
            output_tokens: 50,
            input_tokens_details: { cached_tokens: 800 },
          },
        },
      },
    },
  ];

  it('streams with an API key: reasoning, text, a function call, usage priced with the cache', async () => {
    const f = await fake((req, _body, res) => {
      expect(req.url).toBe('/responses');
      expect(req.headers.authorization).toBe('Bearer sk-openai-test');
      sse(res, EVENTS);
    });
    const provider = new OpenAiResponsesProvider({
      connection: () => ({ apiKey: 'sk-openai-test', baseUrl: f.url }),
      pricing: () => ({
        inputPerMTok: 0.25,
        outputPerMTok: 2,
        cacheReadPerMTok: 0.025,
        cacheWritePerMTok: 0.25,
      }),
    });
    const events = await collect(provider.stream(req, signal()));
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('止めます');
    expect(events.find((e) => e.type === 'reasoning')).toEqual({ type: 'reasoning', text: '考え' });
    expect(events.find((e) => e.type === 'thinking_blocks')).toEqual({
      type: 'thinking_blocks',
      blocks: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc', summary: [] }],
    });
    expect(events.find((e) => e.type === 'tool_call')).toEqual({
      type: 'tool_call',
      toolCall: { id: 'call_1', name: 'session__stop', arguments: '{"sessionId":"ses_1"}' },
    });
    const usage = (events.find((e) => e.type === 'usage') as { usage: Record<string, unknown> })
      .usage;
    expect(usage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 800,
      costSource: 'estimated',
    });
    expect(usage.costUsd).toBeCloseTo((200 * 0.25 + 50 * 2 + 800 * 0.025) / 1_000_000, 9);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' });
    // The reasoning item goes back whole on the next turn.
    const next = toResponsesBody(
      {
        ...req,
        messages: [
          ...req.messages,
          {
            role: 'assistant',
            content: '止めます',
            thinkingBlocks: [
              { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc', summary: [] },
            ],
          },
        ],
      },
      'key',
    ) as { input: unknown[] };
    expect(next.input.at(-2)).toEqual({
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'enc',
      summary: [],
    });
    expect((toResponsesBody(req, 'key') as { include: unknown }).include).toEqual([
      'reasoning.encrypted_content',
    ]);
  });

  it('with a ChatGPT plan: the token is the bearer, the call costs nothing, a used-up plan is a quota error (no retry)', async () => {
    let calls = 0;
    const f = await fake((req, _body, res) => {
      calls++;
      expect(req.headers.authorization).toBe('Bearer plan-token');
      if (calls === 1) {
        sse(res, EVENTS);
        return;
      }
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'subscription_sharing_usage_limit_exceeded',
            message: 'limit',
            type: 'usage_limit',
          },
        }),
      );
    });
    const provider = new OpenAiResponsesProvider({
      connection: () => ({ apiKey: 'sk-ignored', baseUrl: f.url }),
      chatgptToken: () => Promise.resolve('plan-token'),
      retry: { sleep: () => Promise.resolve() },
    });
    const events = await collect(provider.stream(req, signal()));
    expect((events.find((e) => e.type === 'usage') as { usage: unknown }).usage).toEqual({
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 800,
      costUsd: 0,
      costSource: 'reported',
    });
    const err = await collect(provider.stream(req, signal())).catch((e: unknown) => e);
    expect((err as LlmError).code).toBe('llm_quota_exceeded');
    expect((err as LlmError).message).toContain('ChatGPT の利用枠');
    expect(calls).toBe(2);
  });
});

/** A fake auth.openai.com: OpenID configuration, JWKS, the token endpoint, revocation. */
async function fakeAuth() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const state = {
    refreshes: 0,
    revoked: [] as string[],
    refreshError: null as string | null,
    tokenRequests: [] as URLSearchParams[],
  };
  const idToken = (claims: Record<string, unknown>) => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = `${enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${enc(claims)}`;
    return `${head}.${sign('sha256', Buffer.from(head), privateKey).toString('base64url')}`;
  };
  const f = await fake((req, body, res) => {
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    if (req.url === '/.well-known/openid-configuration') {
      return json(200, { jwks_uri: `${f.url}/jwks`, revocation_endpoint: `${f.url}/revoke` });
    }
    if (req.url === '/jwks')
      return json(200, { keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] });
    if (req.url === '/revoke') {
      state.revoked.push(new URLSearchParams(body).get('token') ?? '');
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.url === '/api/accounts/oauth/token') {
      const form = new URLSearchParams(body);
      state.tokenRequests.push(form);
      if (form.get('grant_type') === 'refresh_token') {
        if (state.refreshError) return json(400, { error: state.refreshError });
        state.refreshes++;
        return json(200, {
          access_token: `access-${state.refreshes}`,
          refresh_token: `refresh-${state.refreshes}`,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        });
      }
      const nonce = form.get('nonce');
      return json(200, {
        access_token: 'access-0',
        refresh_token: 'refresh-0',
        id_token: idToken({
          iss: f.url,
          aud: form.get('client_id'),
          sub: 'user_1',
          email: 'me@example.com',
          nonce: nonce ?? (f as unknown as { nonce: string }).nonce,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      });
    }
    json(404, {});
  });
  return { f, state };
}

describe('Sign in with ChatGPT', () => {
  const memStore = () => {
    let creds: ChatGptCredentials | null = null;
    return {
      get: () => creds,
      set: (c: ChatGptCredentials | null) => {
        creds = c;
      },
      hostId: () => 'urn:uuid:11111111-1111-4111-8111-111111111111',
    };
  };

  it('registers on the loopback, exchanges the code, keeps the issued client id, refreshes and revokes', async () => {
    const { f, state } = await fakeAuth();
    let now = Date.now();
    const opened: string[] = [];
    const changes: number[] = [];
    const store = memStore();
    const auth = new ChatGptAuth({
      store,
      log: silentLogger,
      authBase: f.url,
      now: () => now,
      openBrowser: (u) => opened.push(u),
      onChange: () => changes.push(1),
    });
    expect(auth.status()).toEqual({ state: 'signed_out', email: null, error: null });
    const { url } = await auth.signIn({ open: true });
    expect(opened).toEqual([url]);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`${f.url}/api/accounts/authorize`);
    expect(u.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(u.searchParams.get('agent_name_hint')).toBe('AI Agent Command Center');
    expect(u.searchParams.get('ext_agent_host_id')).toBe(store.hostId());
    expect(u.searchParams.get('scope')).toBe(
      'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    );
    expect(u.searchParams.get('resource')).toBe('https://api.openai.com/v1');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    const redirect = u.searchParams.get('redirect_uri')!;
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(auth.status().state).toBe('waiting');
    // The fake issues the ID token with the nonce of the request: hand it over.
    (f as unknown as { nonce: string }).nonce = u.searchParams.get('nonce')!;

    // A wrong state is refused and changes nothing.
    const bad = await fetch(`${redirect}?code=x&state=wrong&client_id=oaiapp_1`);
    expect(bad.status).toBe(400);
    expect(auth.status().state).toBe('waiting');

    // The browser comes back with the code and the issued client id.
    const ok = await fetch(
      `${redirect}?code=abc&state=${u.searchParams.get('state')}&client_id=oaiapp_1`,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('サインインしました');
    expect(auth.status()).toEqual({ state: 'signed_in', email: 'me@example.com', error: null });
    expect(store.get()).toMatchObject({
      clientId: 'oaiapp_1',
      refreshToken: 'refresh-0',
      accessToken: 'access-0',
      email: 'me@example.com',
      sub: 'user_1',
    });
    const exchange = state.tokenRequests[0]!;
    expect(Object.fromEntries(exchange)).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'oaiapp_1',
      code: 'abc',
      redirect_uri: redirect,
      resource: 'https://api.openai.com/v1',
    });
    expect(exchange.get('code_verifier')).toBeTruthy();
    expect(changes).toHaveLength(1);

    // Fresh: the token as stored. Near expiry: one refresh, the rotated refresh token kept.
    expect(await auth.accessToken()).toBe('access-0');
    now += 3600_000;
    const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
    expect([a, b]).toEqual(['access-1', 'access-1']);
    expect(state.refreshes).toBe(1);
    expect(store.get()).toMatchObject({ refreshToken: 'refresh-1', clientId: 'oaiapp_1' });
    expect(Object.fromEntries(state.tokenRequests.at(-1)!)).toEqual({
      grant_type: 'refresh_token',
      client_id: 'oaiapp_1',
      refresh_token: 'refresh-0',
      resource: 'https://api.openai.com/v1',
    });

    // A second sign-in reuses the issued client id instead of registering again.
    const again = new URL((await auth.signIn()).url);
    expect(again.searchParams.get('client_id')).toBe('oaiapp_1');
    expect(again.searchParams.get('agent_name_hint')).toBeNull();
    expect(again.searchParams.get('login_hint')).toBe('me@example.com');

    await auth.signOut();
    expect(auth.status().state).toBe('signed_out');
    expect(store.get()).toBeNull();
    expect(state.revoked).toEqual(['refresh-1']);
  });

  it('a refresh the server refuses for good signs the account out with a reason', async () => {
    const { f, state } = await fakeAuth();
    const store = memStore();
    store.set({
      clientId: 'oaiapp_1',
      refreshToken: 'old',
      accessToken: 'stale',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      email: 'me@example.com',
      sub: 'u',
    });
    state.refreshError = 'refresh_token_expired';
    const auth = new ChatGptAuth({ store, log: silentLogger, authBase: f.url });
    expect(await auth.accessToken()).toBeNull();
    expect(store.get()).toBeNull();
    expect(auth.status()).toMatchObject({
      state: 'error',
      error: expect.stringContaining('サインインし直して'),
    });
  });
});

describe('gateway routing and settings', () => {
  it('routes by prefix and lists every configured provider', async () => {
    expect(providerOf('mock/echo')).toBe('mock');
    expect(providerOf('anthropic/claude-sonnet-4-6')).toBe('anthropic');
    expect(providerOf('openai/gpt-5')).toBe('openai');
    expect(providerOf('team-sonnet')).toBe('litellm');

    const anthropic = await fake((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ data: [{ id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' }] }),
      );
    });
    const openai = await fake((req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // The plan token's list has slugs and a visibility; hidden ones stay out.
      expect(req.headers.authorization).toBe('Bearer plan-token');
      res.end(
        JSON.stringify({
          models: [
            { slug: 'gpt-5', display_name: 'GPT-5', visibility: 'list' },
            { slug: 'gpt-x', visibility: 'hidden' },
          ],
        }),
      );
    });
    const gateway = new LlmGateway({
      connection: () => ({ baseUrl: null, apiKey: null }),
      anthropic: () => ({ apiKey: 'sk-ant', baseUrl: anthropic.url }),
      openai: () => ({ apiKey: null, baseUrl: openai.url }),
      chatgptToken: () => Promise.resolve('plan-token'),
      log: silentLogger,
    });
    const list = await gateway.listModels();
    expect(list.source).toBe('providers');
    expect(list.models.map((m) => [m.id, m.provider])).toEqual([
      ['anthropic/claude-sonnet-4-6', 'anthropic'],
      ['openai/gpt-5', 'chatgpt'],
      ['mock/echo', 'mock'],
      ['mock/fast', 'mock'],
    ]);
    expect(gateway.provider('anthropic/x').id).toBe('anthropic');
    expect(gateway.provider('openai/x').id).toBe('openai');
    expect(gateway.provider('x').id).toBe('litellm');
  });

  it('keeps provider keys in the daemon, masks them in the view, and counts them as configured', async () => {
    daemon = await createTestDaemon();
    const d = daemon;
    const before = await d.call(HUMAN, 'settings.get', {});
    expect(before.providers).toEqual({
      anthropic: { baseUrl: null, hasApiKey: false, apiKeyMasked: null },
      openai: { baseUrl: null, hasApiKey: false, apiKeyMasked: null, chatgpt: null },
    });
    const after = await d.call(HUMAN, 'settings.update', {
      // Dead local ports: nothing answers, nothing leaves the machine.
      providers: {
        anthropic: { apiKey: 'sk-ant-api03-abcdefghijkl', baseUrl: 'http://127.0.0.1:9' },
        openai: { apiKey: 'sk-proj-abcdefghijkl9999', baseUrl: 'http://127.0.0.1:9/v1' },
      },
    });
    expect(after.providers).toEqual({
      anthropic: { baseUrl: 'http://127.0.0.1:9', hasApiKey: true, apiKeyMasked: 'sk-…ijkl' },
      openai: {
        baseUrl: 'http://127.0.0.1:9/v1',
        hasApiKey: true,
        apiKeyMasked: 'sk-…9999',
        chatgpt: null,
      },
    });
    expect(JSON.stringify(after)).not.toContain('abcdefghijkl');
    const list = await d.call(HUMAN, 'models.list', {});
    // Nothing answers, so only the mocks are listed; but something is configured.
    expect(list.source).toBe('config');
    expect(list.models.every((m) => m.id.startsWith('mock/'))).toBe(true);
    expect(await d.call(HUMAN, 'chatgpt.status', {})).toEqual({
      state: 'signed_out',
      email: null,
      error: null,
    });
    const chat = await d.call(HUMAN, 'session.create', { kind: 'chat', title: 'x' });
    // A configured provider means no offline fallback: the chat has no model until one is named.
    const { resolveChatModel } = await import('../sessions/chat');
    expect(resolveChatModel(d.ctx, chat)).toBeNull();
  });
});
