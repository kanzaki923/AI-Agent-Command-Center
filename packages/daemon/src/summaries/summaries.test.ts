import { afterEach, describe, expect, it } from 'vitest';
import { createManualClock } from '../core/clock';
import type { ChatRequest } from '../llm/types';
import { HUMAN, type TestDaemonNoServer, createTestDaemon } from '../testing';
import { SUMMARY_IDLE_MS, mockSummary } from './service';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function daemon() {
  const clock = createManualClock(Date.UTC(2026, 10, 5, 1));
  const d = await createTestDaemon({ clock });
  cleanups.push(() => d.cleanup());
  d.ctx.service('llm').mock.chunkDelayMs = 0;
  await d.call(HUMAN, 'settings.update', { background: { model: 'mock/sum' } });
  return { d, clock };
}

const userOf = (req: ChatRequest) => (req.messages[1] as { content: string }).content;

function summarizer(d: TestDaemonNoServer, text: (n: number) => string = (n) => `あらすじ ${n}`): ChatRequest[] {
  const seen: ChatRequest[] = [];
  d.ctx.service('llm').mock.define('mock/sum', (req) => {
    seen.push(req);
    return { text: text(seen.length), usage: { inputTokens: 2000, outputTokens: 300, costUsd: 0.004, costSource: 'estimated' } };
  });
  return seen;
}

/** A conversation with `n` messages, alternating the person and the AI. */
async function conversation(d: TestDaemonNoServer, n: number, title = '価格の相談') {
  const s = await d.call(HUMAN, 'session.create', { title, model: 'mock/host' });
  await say(d, s.id, n);
  return s;
}

async function say(d: TestDaemonNoServer, sessionId: string, n: number, from = 0) {
  const sessions = d.ctx.service('sessions');
  for (let i = from; i < from + n; i++) {
    sessions.appendMessage({
      sessionId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `発言${i + 1}` }],
      author: i % 2 === 0 ? HUMAN : { kind: 'system', component: 'test' },
    });
  }
}

describe('running summaries of long conversations', () => {
  it('leaves a short conversation alone', async () => {
    const { d, clock } = await daemon();
    const calls = summarizer(d);
    const s = await conversation(d, 24);
    clock.advance(SUMMARY_IDLE_MS + 1);
    await d.ctx.service('summaries').sweep();
    expect(calls).toHaveLength(0);
    expect((await d.call(HUMAN, 'session.summary', { sessionId: s.id })).summary).toBeNull();
  });

  it('folds all but the newest 12 messages once the conversation is quiet, and keeps folding only what is new', async () => {
    const { d, clock } = await daemon();
    const calls = summarizer(d);
    const s = await conversation(d, 30);
    const summaries = d.ctx.service('summaries');
    expect(summaries.due(s.id)).toBe(false); // just talked
    clock.advance(SUMMARY_IDLE_MS + 1);
    expect(summaries.due(s.id)).toBe(true);
    await summaries.sweep();
    const first = (await d.call(HUMAN, 'session.summary', { sessionId: s.id })).summary!;
    expect(first).toMatchObject({ text: 'あらすじ 1', messages: 18 });
    const read = userOf(calls[0]!);
    expect(read).toContain('あなた: 発言1');
    expect(read).toContain('AI: 発言18');
    expect(read).not.toContain('発言19');
    // Booked as background work on the conversation.
    const row = d.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM usage_ledger WHERE component = 'summary' AND session_id = ?", [s.id]);
    expect(row?.n).toBe(1);

    // 12 more: 24 after the summary, still fine as they are.
    await say(d, s.id, 12, 30);
    clock.advance(SUMMARY_IDLE_MS + 1);
    expect(summaries.due(s.id)).toBe(false);
    // One more: the older ones are folded into the previous summary.
    await say(d, s.id, 1, 42);
    clock.advance(SUMMARY_IDLE_MS + 1);
    await summaries.sweep();
    expect(calls).toHaveLength(2);
    expect(userOf(calls[1]!)).toContain('<<<前のあらすじここから>>>\nあらすじ 1\n<<<前のあらすじここまで>>>');
    expect(userOf(calls[1]!)).not.toContain('発言18');
    expect((await d.call(HUMAN, 'session.summary', { sessionId: s.id })).summary).toMatchObject({ text: 'あらすじ 2', messages: 31 });
  });

  it('writes nothing while summaries are off or the background limit is reached', async () => {
    const { d, clock } = await daemon();
    const calls = summarizer(d);
    const s = await conversation(d, 30);
    clock.advance(SUMMARY_IDLE_MS + 1);
    await d.call(HUMAN, 'settings.update', { summaries: { enabled: false } });
    await d.ctx.service('summaries').sweep();
    expect(calls).toHaveLength(0);
    await d.call(HUMAN, 'settings.update', { summaries: { enabled: true }, background: { dailyUsd: 0 } });
    await d.ctx.service('summaries').sweep();
    expect(calls).toHaveLength(0);
    expect((await d.call(HUMAN, 'session.summary', { sessionId: s.id })).summary).toBeNull();
  });

  it('a member called in reads the summary and the messages after it (brought up to date on the spot)', async () => {
    const { d } = await daemon();
    summarizer(d, () => '価格は月額 980 円で決まった。');
    const seen: ChatRequest[] = [];
    d.ctx.service('llm').mock.define('mock/luna', (req) => {
      seen.push(req);
      return { text: 'いいと思う〜' };
    });
    const luna = await d.call(HUMAN, 'character.create', { name: 'ルナ', model: 'mock/luna' });
    const s = await conversation(d, 40);
    await d.call(HUMAN, 'character.aside', { sessionId: s.id, characterId: luna.id, text: '@ルナ どう？' });
    const user = userOf(seen[0]!);
    expect(user).toContain('<<<あらすじここから>>>\n価格は月額 980 円で決まった。\n<<<あらすじここまで>>>');
    expect(user).toContain('AI: 発言40');
    expect(user).toContain('あなた: 発言29');
    expect(user).not.toContain('発言28\n');
  });

  it('search finds a conversation by its summary first, then by its messages', async () => {
    const { d, clock } = await daemon();
    summarizer(d, () => 'FAQ に載せる価格の相談。月額 980 円に決めた。');
    const s = await conversation(d, 30);
    clock.advance(SUMMARY_IDLE_MS + 1);
    await d.ctx.service('summaries').sweep();
    const { items } = await d.call(HUMAN, 'session.search', { query: '980 円' });
    expect(items[0]).toMatchObject({ sessionId: s.id, source: 'summary', messageId: null });
    expect(items[0]!.snippet).toContain('980 円');
    const plain = await d.call(HUMAN, 'session.search', { query: '発言12' });
    expect(plain.items[0]).toMatchObject({ source: 'message' });
  });

  it('the offline summarizer keeps the previous summary and the first words of each message', () => {
    expect(
      mockSummary('<<<前のあらすじここから>>>\n前回まで\n<<<前のあらすじここまで>>>\n\nNew messages (oldest first):\nあなた: こんにちは'),
    ).toBe('前回まで\nあなた: こんにちは');
  });
});
