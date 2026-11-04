import { afterEach, describe, expect, it } from 'vitest';
import { BACKGROUND_DAILY_CALLS, noteBackgroundCall } from '../llm/background';
import type { ChatRequest } from '../llm/types';
import { HUMAN, type TestDaemonNoServer, createTestDaemon } from '../testing';
import { mockSummary } from './service';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function daemon() {
  const d = await createTestDaemon();
  cleanups.push(() => d.cleanup());
  d.ctx.service('llm').mock.chunkDelayMs = 0;
  await d.call(HUMAN, 'settings.update', { background: { model: 'mock/sum' } });
  return d;
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
  say(d, s.id, n);
  return s;
}

function say(d: TestDaemonNoServer, sessionId: string, n: number, from = 0, size = 0) {
  const sessions = d.ctx.service('sessions');
  for (let i = from; i < from + n; i++) {
    sessions.appendMessage({
      sessionId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `発言${i + 1}${'。'.repeat(size)}` }],
      author: i % 2 === 0 ? HUMAN : { kind: 'system', component: 'test' },
    });
  }
}

describe('running summaries of long conversations', () => {
  it('leaves a short conversation alone', async () => {
    const d = await daemon();
    const calls = summarizer(d);
    const s = await conversation(d, 24);
    await d.ctx.service('summaries').onTurnEnd(s.id);
    expect(calls).toHaveLength(0);
    expect((await d.call(HUMAN, 'session.summary', { sessionId: s.id })).summary).toBeNull();
  });

  it('when a turn ends, folds the oldest messages (never the newest 12), and later only what is new', async () => {
    const d = await daemon();
    const calls = summarizer(d);
    const s = await conversation(d, 30);
    const summaries = d.ctx.service('summaries');
    await summaries.onTurnEnd(s.id);
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
    say(d, s.id, 12, 30);
    await summaries.onTurnEnd(s.id);
    expect(calls).toHaveLength(1);
    // One more: the older ones are folded into the previous summary.
    say(d, s.id, 1, 42);
    await summaries.onTurnEnd(s.id);
    expect(calls).toHaveLength(2);
    expect(userOf(calls[1]!)).toContain('<<<前のあらすじここから>>>\nあらすじ 1\n<<<前のあらすじここまで>>>');
    expect(userOf(calls[1]!)).not.toContain('発言18');
    expect((await d.call(HUMAN, 'session.summary', { sessionId: s.id })).summary).toMatchObject({ text: 'あらすじ 2', messages: 31 });
  });

  it('reads at most one chunk per call, however much is behind (an old long conversation catches up turn by turn)', async () => {
    const d = await daemon();
    const calls = summarizer(d);
    const s = await conversation(d, 200);
    await d.ctx.service('summaries').onTurnEnd(s.id);
    expect(calls).toHaveLength(1);
    const read = userOf(calls[0]!);
    expect(read).toContain('発言24');
    expect(read).not.toContain('発言25');
    expect((await d.call(HUMAN, 'session.summary', { sessionId: s.id })).summary).toMatchObject({ messages: 24 });
  });

  it('cuts a chunk at the size bound too', async () => {
    const d = await daemon();
    const calls = summarizer(d);
    const s = await conversation(d, 0);
    say(d, s.id, 40, 0, 1_000);
    await d.ctx.service('summaries').onTurnEnd(s.id);
    const lines = userOf(calls[0]!).split('\n').filter((l) => /^(あなた|AI): /.test(l));
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.join('').length).toBeLessThanOrEqual(13_000);
  });

  it('writes nothing while summaries are off, or once background work hits its daily limits', async () => {
    const d = await daemon();
    const calls = summarizer(d);
    const s = await conversation(d, 30);
    await d.call(HUMAN, 'settings.update', { summaries: { enabled: false } });
    await d.ctx.service('summaries').onTurnEnd(s.id);
    expect(calls).toHaveLength(0);
    await d.call(HUMAN, 'settings.update', { summaries: { enabled: true }, background: { dailyUsd: 0 } });
    await d.ctx.service('summaries').onTurnEnd(s.id);
    expect(calls).toHaveLength(0);
    // On a plan a call costs $0: the number of calls stops it too.
    await d.call(HUMAN, 'settings.update', { background: { dailyUsd: null } });
    for (let i = 0; i < BACKGROUND_DAILY_CALLS; i++) noteBackgroundCall(d.ctx, 'summary');
    await d.ctx.service('summaries').onTurnEnd(s.id);
    expect(calls).toHaveLength(0);
    expect((await d.call(HUMAN, 'session.summary', { sessionId: s.id })).summary).toBeNull();
  });

  it('a member called in reads the summary and the messages after it (brought up to date on the spot)', async () => {
    const d = await daemon();
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
    expect(user).toContain('あなた: 発言25');
    expect(user).not.toContain('発言24\n');
  });

  it('search finds a conversation by its summary first, then by its messages', async () => {
    const d = await daemon();
    summarizer(d, () => 'FAQ に載せる価格の相談。月額 980 円に決めた。');
    const s = await conversation(d, 30);
    await d.ctx.service('summaries').onTurnEnd(s.id);
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
