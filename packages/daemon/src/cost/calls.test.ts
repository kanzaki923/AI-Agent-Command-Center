import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../llm/types';
import { HUMAN, type TestDaemonNoServer, agentActor, createTestDaemon } from '../testing';
import { CALL_LOG_DAYS, promptShape } from './calls';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function daemon(): Promise<TestDaemonNoServer> {
  const d = await createTestDaemon();
  cleanups.push(() => d.cleanup());
  d.ctx.service('llm').mock.chunkDelayMs = 0;
  return d;
}

const sys = (content: string): ChatMessage => ({ role: 'system', content });
const user = (content: string): ChatMessage => ({ role: 'user', content });
const said = (content: string): ChatMessage => ({ role: 'assistant', content });

describe('the shape of a prompt', () => {
  it('ends the cacheable part at the first system message after the history', () => {
    const shape = promptShape([sys('role'), user('a'), said('b'), sys('status')], []);
    expect(shape.prefixMessages).toBe(3);
    expect(shape.chain).toHaveLength(5);
    // Without a later system message, everything stays for the next call.
    expect(promptShape([sys('role'), user('a')], []).prefixMessages).toBe(2);
    // The chain covers the tools too.
    const other = promptShape([sys('role'), user('a'), said('b'), sys('status')], [
      { name: 't', description: 'd', parameters: {} },
    ]);
    expect(other.chain[3]).not.toBe(shape.chain[3]);
    expect(other.systemHash).toBe(shape.systemHash);
  });
});

describe('the LLM call log', () => {
  it('logs every call of a chat with its tokens, and whether it continued the last one', async () => {
    const d = await daemon();
    d.ctx.service('llm').mock.define('mock/cached', () => ({
      text: 'はい',
      usage: { inputTokens: 1000, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 5 },
    }));
    const s = await d.call(HUMAN, 'session.create', { title: 'c', model: 'mock/cached' });
    for (const content of ['やあ', '続けて']) {
      const sent = await d.call(HUMAN, 'session.send', { sessionId: s.id, content });
      await d.ctx.service('runs').waitForEnd(sent.runId!);
    }
    const { calls } = await d.call(HUMAN, 'usage.calls', { sessionId: s.id });
    expect(calls).toHaveLength(2);
    const [second, first] = calls;
    expect(first).toMatchObject({
      role: 'chat',
      turn: 0,
      model: 'mock/cached',
      provider: 'mock',
      status: 'ok',
      inputTokens: 1000,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
      outputTokens: 5,
      prefixContinues: null,
      gapMs: null,
    });
    // The second call starts with all of the first: a cache can serve it.
    expect(second).toMatchObject({ prefixContinues: true, status: 'ok' });
    expect(second!.gapMs).toBeGreaterThanOrEqual(0);
    expect(second!.messages).toBeGreaterThan(first!.messages);
  });

  it('marks a call whose front changed (a cache miss of our making)', async () => {
    const d = await daemon();
    const s = await d.call(HUMAN, 'session.create', { title: 'c' });
    const log = d.ctx.service('callLog');
    const call = (messages: ChatMessage[]) =>
      log.record({
        runId: null,
        sessionId: s.id,
        role: 'supervisor',
        turn: 0,
        model: 'mock/x',
        provider: 'mock',
        status: 'ok',
        startedAt: d.ctx.clock.now(),
        endedAt: d.ctx.clock.now(),
        usage: null,
        messages,
        tools: [],
      });
    call([sys('A'), user('1'), sys('tree 1')]);
    // The role changed in front: nothing before it can be read back.
    call([sys('B'), user('1'), said('ok'), user('2'), sys('tree 2')]);
    // Same front, more history and a new status after it.
    call([sys('B'), user('1'), said('ok'), user('2'), said('ok'), user('3'), sys('tree 3')]);
    const { calls } = await d.call(HUMAN, 'usage.calls', { sessionId: s.id });
    expect(calls.map((c) => c.prefixContinues)).toEqual([true, false, null]);
    expect(calls[0]!.prefixMessages).toBe(6);
  });

  it('logs a failed call with its error code', async () => {
    const d = await daemon();
    d.ctx.service('llm').mock.define('mock/broken', () => ({ error: '落ちました' }));
    const s = await d.call(HUMAN, 'session.create', { title: 'c', model: 'mock/broken' });
    const sent = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: 'やあ' });
    await d.ctx.service('runs').waitForEnd(sent.runId!);
    const { calls } = await d.call(HUMAN, 'usage.calls', { runId: sent.runId! });
    expect(calls).toEqual([
      expect.objectContaining({ status: 'error', errorCode: 'llm_stream_error', inputTokens: 0 }),
    ]);
  });

  it('sums use per model from the ledger and the calls; only people see it', async () => {
    const d = await daemon();
    d.ctx.service('llm').mock.define('mock/cached', () => ({
      text: 'はい',
      usage: { inputTokens: 1000, cacheReadTokens: 600, outputTokens: 10, costUsd: 0.01 },
    }));
    const s = await d.call(HUMAN, 'session.create', { title: 'c', model: 'mock/cached' });
    const sent = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: 'やあ' });
    await d.ctx.service('runs').waitForEnd(sent.runId!);
    const stats = await d.call(HUMAN, 'usage.stats', { range: 'today' });
    expect(stats.rows.find((r) => r.model === 'mock/cached')).toMatchObject({
      inputTokens: 1000,
      outputTokens: 10,
      calls: 1,
      failedCalls: 0,
      prefixBreaks: 0,
      cache: { inputTokens: 1000, readTokens: 600, writeTokens: 0 },
    });
    // Use the log never saw (before it began, or an agent's own calls) has no cache figure.
    d.ctx.service('ledger').record({
      sessionId: s.id,
      runId: null,
      model: 'claude-sonnet-5',
      component: 'agent',
      costUsd: 0.5,
      inputTokens: 4000,
      source: 'estimated',
    });
    const again = await d.call(HUMAN, 'usage.stats', { range: 'today' });
    expect(again.rows.find((r) => r.model === 'claude-sonnet-5')).toMatchObject({
      calls: 0,
      cache: null,
    });
    // The days of the range, every one of them, with the day's tokens and spend.
    expect(again.days).toEqual([
      {
        day: expect.stringMatching(/^\d{4}-\d\d-\d\d$/),
        usd: 0.51,
        inputTokens: 5000,
        outputTokens: 10,
        // Per model, most spend first.
        models: [
          { model: 'claude-sonnet-5', usd: 0.5 },
          { model: 'mock/cached', usd: 0.01 },
        ],
      },
    ]);
    const week = await d.call(HUMAN, 'usage.stats', { range: '7d' });
    expect(week.days).toHaveLength(7);
    expect(week.days.slice(0, 6).every((x) => x.inputTokens === 0 && x.usd === 0)).toBe(true);
    expect(week.days[6]).toEqual(again.days[0]);
    const agent = agentActor(s.id, sent.runId!);
    await expect(d.call(agent, 'usage.stats', {})).rejects.toMatchObject({ code: 'forbidden' });
    await expect(d.call(agent, 'usage.calls', {})).rejects.toMatchObject({ code: 'forbidden' });
  });

  it(`forgets calls older than ${CALL_LOG_DAYS} days`, async () => {
    const d = await daemon();
    const log = d.ctx.service('callLog');
    const base = {
      runId: null,
      sessionId: null,
      role: 'chat' as const,
      turn: 0,
      model: 'mock/x',
      provider: 'mock',
      status: 'ok' as const,
      usage: null,
      messages: [user('a')],
      tools: [],
    };
    const old = d.ctx.clock.now() - (CALL_LOG_DAYS + 1) * 86_400_000;
    log.record({ ...base, startedAt: old, endedAt: old });
    log.record({ ...base, startedAt: d.ctx.clock.now(), endedAt: d.ctx.clock.now() });
    expect(log.prune()).toBe(1);
    expect(log.list({ limit: 10 })).toHaveLength(1);
  });
});
