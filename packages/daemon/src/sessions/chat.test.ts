import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Delta, Event, Message } from '@acc/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { scripted } from '../llm/mock';
import { apiTools, runToolLoop, toChatMessages } from '../llm';
import {
  HUMAN,
  type TestDaemon,
  type TestDaemonNoServer,
  connectTestClient,
  createTestDaemon,
  startTestDaemon,
} from '../testing';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function until<T>(fn: () => T | undefined | false | null, timeoutMs = 3000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false && v !== null) return v;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function daemon(): Promise<TestDaemonNoServer> {
  const d = await createTestDaemon();
  cleanups.push(() => d.cleanup());
  d.ctx.service('llm').mock.chunkDelayMs = 0;
  return d;
}

const texts = (msgs: Message[]) =>
  msgs.map((m) => [
    m.role,
    m.content
      .map((p) =>
        p.type === 'text'
          ? p.text
          : p.type === 'tool_call'
            ? `call:${p.name}`
            : p.type === 'tool_result'
              ? `result:${p.isError ? 'error' : 'ok'}`
              : '',
      )
      .join('|'),
  ]);

function grantSession(d: TestDaemonNoServer, sessionId: string, permissions: string[]) {
  d.ctx.repos.grants.insert({
    id: d.ctx.ids.next('grant'),
    subject: { kind: 'session', sessionId },
    parentGrantId: null,
    permissions,
    scope: {},
    limits: {},
    depth: 0,
    lifetime: 'session',
    expiresAt: null,
    revokedAt: null,
    reason: null,
    grantedBy: HUMAN,
    createdAt: d.ctx.clock.iso(),
  });
}

describe('chat over the WebSocket client (mock provider)', () => {
  it('streams deltas, persists the reply and reports usage', async () => {
    const d: TestDaemon = await startTestDaemon();
    cleanups.push(() => d.cleanup());
    d.ctx.service('llm').mock.chunkDelayMs = 1;
    const client = await connectTestClient(d);
    cleanups.push(() => client.close());

    const session = await client.call('session.create', { title: 'chat', model: 'mock/echo' });
    const events: Event[] = [];
    const deltas: Delta[] = [];
    const sub = client.subscribe({
      sessionId: session.id,
      onEvent: (e) => events.push(e),
      onDelta: (x) => deltas.push(x),
    });
    await until(() => sub.lastSeq !== null);

    const sent = await client.call('session.send', {
      sessionId: session.id,
      content: 'こんにちは、世界',
    });
    const done = await until(() =>
      events.find((e) => e.type === 'run.completed' && e.runId === sent.runId),
    );
    if (done.type !== 'run.completed') throw new Error('unreachable');
    expect(done.payload.run).toMatchObject({
      kind: 'chat',
      model: 'mock/echo',
      triggerMessageId: sent.messageId,
      usage: { costSource: 'reported' },
    });
    expect(done.payload.run.usage.outputTokens).toBeGreaterThan(0);

    const { items } = await client.call('session.messages', { sessionId: session.id });
    expect(texts(items)).toEqual([
      ['user', 'こんにちは、世界'],
      ['assistant', 'エコー: こんにちは、世界'],
    ]);
    const reply = items[1]!;
    expect(reply).toMatchObject({ runId: sent.runId, model: 'mock/echo' });
    // Deltas were streamed under the persisted message id, in order.
    expect(deltas.length).toBeGreaterThan(1);
    expect(new Set(deltas.map((x) => x.messageId))).toEqual(new Set([reply.id]));
    expect(deltas.map((x) => x.index)).toEqual(deltas.map((_, i) => i));
    expect(deltas.map((x) => x.text).join('')).toBe('エコー: こんにちは、世界');

    const types = events.map((e) => e.type);
    expect(types).toContain('session.updated'); // activeRunId set / cleared
    expect(types.indexOf('message.created')).toBeLessThan(types.indexOf('run.completed'));
    expect((await client.call('session.get', { sessionId: session.id })).activeRunId).toBeNull();

    // The next turn sees the history.
    const again = await client.call('session.send', { sessionId: session.id, content: '2回目' });
    await until(() => events.find((e) => e.type === 'run.completed' && e.runId === again.runId));
    const after = await client.call('session.messages', { sessionId: session.id });
    expect(after.items.at(-1)?.content).toEqual([{ type: 'text', text: 'エコー: 2回目' }]);
  });
});

describe('session.send', () => {
  it('falls back to the offline mock model and refuses a second send while busy', async () => {
    const d = await daemon();
    d.ctx.service('llm').mock.chunkDelayMs = 20;
    const s = await d.call(HUMAN, 'session.create', {});
    expect(s.model).toBeNull();
    const first = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: 'ゆっくり' });
    expect(d.ctx.repos.runs.require(first.runId).model).toBe('mock/echo');
    await expect(
      d.call(HUMAN, 'session.send', { sessionId: s.id, content: '割り込み' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // The refused message was rolled back.
    expect(d.ctx.repos.messages.count({ where: { session_id: s.id } })).toBe(1);
    await d.ctx.service('runs').waitForEnd(first.runId);
  });

  it('keeps the partial reply when cancelled mid-stream', async () => {
    const d = await daemon();
    d.ctx
      .service('llm')
      .mock.define(
        'mock/long',
        () => ({ text: 'あいうえおかきくけこさしすせそたちつてと'.repeat(5) }),
        { chunkDelayMs: 15, chunkSize: 2 },
      );
    const s = await d.call(HUMAN, 'session.create', { model: 'mock/long' });
    let deltas = 0;
    d.ctx.bus.subscribeDeltas({ sessionId: s.id }, () => deltas++);
    const { runId } = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: '長く' });
    await until(() => deltas >= 3);
    await d.call(HUMAN, 'run.cancel', { runId });
    await until(() => d.ctx.repos.messages.count({ where: { run_id: runId } }) === 1);
    const [partial] = d.ctx.repos.messages.find({ where: { run_id: runId } });
    const text = partial!.content[0]!.type === 'text' ? partial!.content[0]!.text : '';
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThan(100);
    expect(d.ctx.repos.runs.require(runId).status).toBe('cancelled');
    // The session is free again.
    d.ctx.service('llm').mock.define('mock/long', () => ({ text: 'ok' }), { chunkDelayMs: 0 });
    const next = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: '続けて' });
    expect((await d.ctx.service('runs').waitForEnd(next.runId)).status).toBe('completed');
  });

  it('fails with a clear message when LiteLLM is configured but no model is set', async () => {
    const d = await daemon();
    await d.call(HUMAN, 'settings.update', { litellm: { baseUrl: 'http://127.0.0.1:9' } });
    const s = await d.call(HUMAN, 'session.create', {});
    const { runId } = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: 'hi' });
    const run = await d.ctx.service('runs').waitForEnd(runId);
    expect(run).toMatchObject({ status: 'failed', error: { code: 'invalid_params' } });
    expect(run.error?.message).toContain('モデルが設定されていません');
  });

  it('starts agent runs for agent sessions (executor provided by the runtime module)', async () => {
    const d = await daemon();
    const s = await d.call(HUMAN, 'session.create', { kind: 'agent', runtime: 'mock' });
    let seen: string | null = null;
    d.ctx.service('runs').registerExecutor('agent', async (ctl) => {
      seen = ctl.run.triggerMessageId;
    });
    const sent = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: 'build it' });
    const run = await d.ctx.service('runs').waitForEnd(sent.runId);
    expect(run).toMatchObject({ kind: 'agent', runtime: 'mock', status: 'completed' });
    expect(seen).toBe(sent.messageId);
  });

  it('talks to LiteLLM over HTTP when configured (fake server)', async () => {
    const d = await daemon();
    const bodies: string[] = [];
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        bodies.push(body);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '本物' } }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'っぽい' } }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3, cost: 0.002 } })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => server.close(r)));
    const port = (server.address() as AddressInfo).port;
    await d.call(HUMAN, 'settings.update', {
      litellm: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-fake-0000000000' },
      defaultModel: 'gpt-fake',
    });
    const s = await d.call(HUMAN, 'session.create', { systemPrompt: '丁寧に' });
    const { runId } = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: '質問' });
    const run = await d.ctx.service('runs').waitForEnd(runId);
    expect(run).toMatchObject({
      status: 'completed',
      model: 'gpt-fake',
      usage: { inputTokens: 9, outputTokens: 3, costUsd: 0.002, costSource: 'reported' },
    });
    const sent = JSON.parse(bodies[0]!) as { messages: unknown[]; tools?: unknown };
    expect(sent.messages).toEqual([
      { role: 'system', content: '丁寧に' },
      { role: 'user', content: '質問' },
    ]);
    expect(sent.tools).toBeUndefined(); // no grants -> plain chat
    const msgs = await d.call(HUMAN, 'session.messages', { sessionId: s.id });
    expect(texts(msgs.items).at(-1)).toEqual(['assistant', '本物っぽい']);
  });
});

describe('tool loop', () => {
  it('lets a chat with grants call the Control API as tools (multi-turn, scripted mock)', async () => {
    const d = await daemon();
    d.ctx.service('llm').mock.define(
      'mock/ops',
      scripted([
        {
          text: 'セッションを確認します',
          toolCalls: [
            { id: 'c1', name: 'session__list', input: { limit: 5 } },
            { id: 'c2', name: 'settings__update', input: { defaultModel: 'x' } },
            { id: 'c3', name: 'session__get', input: { sessionId: 'nope' } },
          ],
        },
        (_req, info) => ({
          text: `${info.toolResults.length} 件の結果: ${info.toolResults
            .map((t) => (t.content.includes('"error"') ? 'NG' : 'OK'))
            .join(',')}`,
        }),
      ]),
    );
    const s = await d.call(HUMAN, 'session.create', { model: 'mock/ops' });
    grantSession(d, s.id, ['session.list', 'session.get']);
    const { runId } = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: '一覧' });
    const run = await d.ctx.service('runs').waitForEnd(runId);
    expect(run.status).toBe('completed');

    const msgs = (await d.call(HUMAN, 'session.messages', { sessionId: s.id })).items;
    expect(texts(msgs)).toEqual([
      ['user', '一覧'],
      [
        'assistant',
        'セッションを確認します|call:session.list|call:settings.update|call:session.get',
      ],
      ['tool', 'result:ok'],
      ['tool', 'result:error'], // not granted -> not offered -> unknown tool
      ['tool', 'result:error'], // invalid params from the dispatcher
      ['assistant', '3 件の結果: OK,NG,NG'],
    ]);
    const toolEvents = d.ctx.bus
      .list({ runId, types: ['tool.*'] })
      .events.map((e) =>
        e.type === 'tool.result' ? `${e.payload.name}:${e.payload.isError}` : e.type,
      );
    expect(toolEvents).toEqual([
      'tool.called',
      'session.list:false',
      'tool.called',
      'settings.update:true',
      'tool.called',
      'session.get:true',
    ]);
    // History round-trips back into valid model messages.
    const replay = toChatMessages(msgs);
    expect(replay.filter((m) => m.role === 'tool')).toHaveLength(3);
    expect(replay[1]).toMatchObject({
      role: 'assistant',
      toolCalls: [
        { name: 'session__list' },
        { name: 'settings__update' },
        { name: 'session__get' },
      ],
    });
    expect(d.ctx.settings.get().defaultModel).toBeNull();
  });

  it('asks for approval before risky tools and honours maxTurns (orchestrator-style use)', async () => {
    const d = await daemon();
    const looping = { text: '', toolCalls: [{ name: 'session__update', input: {} }] };
    d.ctx.service('llm').mock.define('mock/loop', () => looping);
    const s = await d.call(HUMAN, 'session.create', { title: 'before' });
    const runs = d.ctx.service('runs');
    let result: Awaited<ReturnType<typeof runToolLoop>> | null = null;
    runs.registerExecutor('orchestrator', async (ctl) => {
      looping.toolCalls[0]!.input = { sessionId: s.id, title: 'after' };
      result = await runToolLoop({
        ctx: d.ctx,
        ctl,
        model: 'mock/loop',
        messages: [{ role: 'user', content: 'rename' }],
        tools: apiTools(d.ctx, HUMAN, { include: ['session.*'] }),
        maxTurns: 2,
        approvalFor: ({ tool }) =>
          tool.method === 'session.update'
            ? { kind: 'tool_use', title: `${tool.method} を実行`, payload: { toolName: tool.name } }
            : null,
      });
    });
    const run = runs.start({ sessionId: s.id, kind: 'orchestrator', createdBy: HUMAN });
    for (const decision of ['reject', 'approve'] as const) {
      const ap = await until(() =>
        d.ctx.repos.approvals.findOne({ where: { run_id: run.id, status: 'pending' } }),
      );
      expect(d.ctx.repos.runs.require(run.id).status).toBe('awaiting_approval');
      await d.call(HUMAN, 'approval.respond', { approvalId: ap.id, decision });
    }
    expect((await runs.waitForEnd(run.id)).status).toBe('completed');
    expect(result).toMatchObject({ stopReason: 'max_turns', turns: 2 });
    // Rejected first, approved second.
    expect(d.ctx.repos.sessions.require(s.id).title).toBe('after');
    const outcomes = d.ctx.bus
      .list({ runId: run.id, types: ['tool.result'] })
      .events.map((e) => (e.type === 'tool.result' ? e.payload.isError : null));
    expect(outcomes).toEqual([true, false]);
  });
});

describe('session.search', () => {
  async function seed(d: TestDaemonNoServer) {
    const p = await d.call(HUMAN, 'project.create', { name: 'P' });
    const a = await d.call(HUMAN, 'session.create', { title: '旅行', projectId: p.id });
    const b = await d.call(HUMAN, 'session.create', { title: 'コード' });
    const add = (sessionId: string, text: string) =>
      d.ctx.service('sessions').appendMessage({
        sessionId,
        role: 'user',
        content: [{ type: 'text', text }],
        author: HUMAN,
      });
    const m1 = add(a.id, '東京タワーに行きたい。展望台からの景色が楽しみです');
    const m2 = add(b.id, 'Refactor the TokyoParser class');
    const m3 = add(a.id, '京都と東京、どちらが良い？');
    d.ctx.service('sessions').appendMessage({
      sessionId: b.id,
      role: 'tool',
      content: [{ type: 'tool_result', toolCallId: 'x', output: { text: '東京' }, isError: false }],
      author: HUMAN,
    });
    return { p, a, b, m1, m2, m3 };
  }

  it('finds Japanese substrings (trigram and short terms), newest first, with snippets', async () => {
    const d = await daemon();
    const { p, a, m1, m2, m3 } = await seed(d);
    const search = async (query: string, projectId?: string) =>
      (await d.call(HUMAN, 'session.search', { query, ...(projectId ? { projectId } : {}) })).items;

    expect((await search('東京タワー')).map((h) => h.messageId)).toEqual([m1.id]);
    // 2-char term: LIKE fallback; tool results are not indexed.
    expect((await search('東京')).map((h) => h.messageId)).toEqual([m3.id, m1.id]);
    expect((await search('展望台 景色')).map((h) => h.messageId)).toEqual([m1.id]);
    expect((await search('東京 京都')).map((h) => h.messageId)).toEqual([m3.id]);
    expect((await search('tokyoparser')).map((h) => h.messageId)).toEqual([m2.id]); // case-insensitive
    expect(await search('存在しない言葉')).toEqual([]);
    expect(await search('"; DROP TABLE messages; --')).toEqual([]);
    expect(await search('100%')).toEqual([]);
    expect((await search('東京', p.id)).every((h) => h.sessionId === a.id)).toBe(true);

    const [hit] = await search('景色');
    expect(hit).toMatchObject({ sessionId: a.id, sessionTitle: '旅行', messageId: m1.id });
    expect(hit!.snippet).toContain('景色');
  });

  it('indexes messages that existed before the index (migration backfill)', async () => {
    const { sessionsModule } = await import('./index');
    const { modules } = await import('../modules');
    const withoutFts = modules.map((m) => (m === sessionsModule ? { ...m, migrations: [] } : m));
    const first = await createTestDaemon({ modules: withoutFts });
    const s = await first.call(HUMAN, 'session.create', {});
    first.ctx.service('sessions').appendMessage({
      sessionId: s.id,
      role: 'assistant',
      content: [{ type: 'text', text: '移行前のメッセージ' }],
      author: HUMAN,
    });
    await first.close();
    cleanups.push(() => first.removeHome());
    const second = await createTestDaemon({ home: first.home });
    cleanups.push(() => second.close());
    const res = await second.call(HUMAN, 'session.search', { query: '移行前' });
    expect(res.items).toHaveLength(1);
  });
});
