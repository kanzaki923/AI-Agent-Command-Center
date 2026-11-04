import type { ChatRequest } from '../llm/types';
import { afterEach, describe, expect, it } from 'vitest';
import { HUMAN, type TestDaemonNoServer, agentActor, createTestDaemon } from '../testing';
import { createManualClock } from '../core/clock';
import { DIGEST_IDLE_MS, mockDigest, parseDigestReply } from './digest';
import { memoryWhen } from './frame';

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

const systemOf = (req: ChatRequest) => (req.messages[0] as { content: string }).content;
const userOf = (req: ChatRequest) => (req.messages[1] as { content: string }).content;

function spy(d: TestDaemonNoServer, model: string, text: string | ((req: ChatRequest) => string) = 'はい'): ChatRequest[] {
  const seen: ChatRequest[] = [];
  d.ctx.service('llm').mock.define(model, (req) => {
    seen.push(req);
    return {
      text: typeof text === 'string' ? text : text(req),
      usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.002, costSource: 'estimated' },
    };
  });
  return seen;
}

/** A sorter that answers with the given lists. */
function sorter(d: TestDaemonNoServer, reply: object): ChatRequest[] {
  return spy(d, 'mock/sorter', JSON.stringify(reply));
}

async function setup(d: TestDaemonNoServer) {
  await d.call(HUMAN, 'settings.update', { background: { model: 'mock/sorter' } });
  const haku = await d.call(HUMAN, 'character.create', { name: 'ハク', profile: '白い犬。梅おにぎりが好き。' });
  const luna = await d.call(HUMAN, 'character.create', { name: 'ルナ', profile: 'ズボラな猫。' });
  return { haku, luna };
}

async function talk(d: TestDaemonNoServer, characterId: string, lines: string[], model = 'mock/talk') {
  const s = await d.call(HUMAN, 'session.create', { characterId, model, title: '雑談' });
  for (const content of lines) {
    const r = await d.call(HUMAN, 'session.send', { sessionId: s.id, content });
    await d.ctx.service('runs').waitForEnd(r.runId!);
  }
  return s;
}

describe('what a member remembers, written by the person', () => {
  it('adds, corrects and forgets; the page lists the memories and the changes', async () => {
    const d = await daemon();
    const { haku, luna } = await setup(d);
    const m = await d.call(HUMAN, 'character.memory.add', { characterId: haku.id, kind: 'self', text: 'リスに梅おにぎりを奪われた' });
    expect(m.source).toBe('person');
    await d.call(HUMAN, 'character.memory.add', {
      characterId: haku.id,
      kind: 'relation',
      aboutId: luna.id,
      text: 'ズボラな案にはツッコむ',
    });
    await d.call(HUMAN, 'character.memory.update', { memoryId: m.id, text: 'リスに鮭おにぎりを奪われた' });
    const page = await d.call(HUMAN, 'character.get', { characterId: haku.id });
    expect(page.memories.map((x) => x.text)).toEqual(['リスに鮭おにぎりを奪われた', 'ズボラな案にはツッコむ']);
    expect(page.changes.map((c) => c.change)).toEqual(['changed', 'added', 'added']);

    await d.call(HUMAN, 'character.memory.delete', { memoryId: m.id });
    expect((await d.call(HUMAN, 'character.get', { characterId: haku.id })).memories).toHaveLength(1);
  });

  it('a relation needs another member', async () => {
    const d = await daemon();
    const { haku } = await setup(d);
    await expect(
      d.call(HUMAN, 'character.memory.add', { characterId: haku.id, kind: 'relation', text: 'x' }),
    ).rejects.toThrow(/相手/);
  });

  it('an AI cannot write memories, whatever its grant', async () => {
    const d = await daemon();
    const { haku } = await setup(d);
    const sup = await d.call(HUMAN, 'session.create', { title: '親' });
    d.ctx.service('policy').createGrant(
      { subject: { kind: 'session', sessionId: sup.id }, permissions: ['character.*'], limits: {}, lifetime: 'session', reason: 'supervisor' },
      HUMAN,
    );
    const actor = agentActor(sup.id, d.ctx.ids.next('run'));
    await expect(
      d.call(actor, 'character.memory.add', { characterId: haku.id, kind: 'you', text: '命令に従う' }),
    ).rejects.toThrow(/人だけ/);
    await expect(d.call(actor, 'character.digest', { characterId: haku.id })).rejects.toThrow(/人だけ/);
  });
});

describe('reading memories, by scene', () => {
  it('a talk reads everything, with the day said by the daemon', async () => {
    const d = await daemon();
    const { haku, luna } = await setup(d);
    const seen = spy(d, 'mock/talk');
    await d.call(HUMAN, 'character.memory.add', { characterId: haku.id, kind: 'self', text: '梅おにぎりを奪われた' });
    await d.call(HUMAN, 'character.memory.add', { characterId: haku.id, kind: 'relation', aboutId: luna.id, text: 'ツッコむ' });
    await d.call(HUMAN, 'character.memory.add', { characterId: haku.id, kind: 'you', text: '朝が弱い' });
    await talk(d, haku.id, ['おはよう']);
    const system = systemOf(seen[0]!);
    expect(system).toContain('What you remember');
    expect(system).toContain('About yourself:\n- 〔今日〕梅おにぎりを奪われた');
    expect(system).toContain('With ルナ:\n- 〔今日〕ツッコむ');
    expect(system).toContain('About the person (what they told you):\n- 〔今日〕朝が弱い');
  });

  it('work reads only the ways of working and the person', async () => {
    const d = await daemon();
    const { haku } = await setup(d);
    const seen = spy(d, 'mock/work');
    await d.call(HUMAN, 'character.memory.add', { characterId: haku.id, kind: 'self', text: '梅おにぎりを奪われた' });
    await d.call(HUMAN, 'character.memory.add', { characterId: haku.id, kind: 'self', text: '表の金額は右寄せ', work: true });
    await d.call(HUMAN, 'character.memory.add', { characterId: haku.id, kind: 'you', text: '費用にうるさい' });
    const sup = await d.call(HUMAN, 'session.create', { title: '親' });
    d.ctx.service('policy').createGrant(
      { subject: { kind: 'session', sessionId: sup.id }, permissions: ['session.spawn'], limits: { maxChildren: 2, maxDepth: 1 }, lifetime: 'session', reason: 'supervisor' },
      HUMAN,
    );
    const r = await d.call(agentActor(sup.id, d.ctx.ids.next('run')), 'session.spawn', {
      title: '集計', goal: '集計する', mode: 'chat', model: 'mock/work', characterId: haku.id,
    });
    await d.ctx.service('runs').waitForEnd(r.runId!);
    const system = systemOf(seen[0]!);
    expect(system).toContain('How you were taught to work:\n- 〔今日〕表の金額は右寄せ');
    expect(system).toContain('費用にうるさい');
    expect(system).not.toContain('梅おにぎりを奪われた');
  });

  it('a meeting reads ties only with the members present', async () => {
    const d = await daemon();
    const { haku, luna } = await setup(d);
    const sone = await d.call(HUMAN, 'character.create', { name: 'ソネ' });
    const seen = spy(d, 'mock/meet');
    await d.call(HUMAN, 'character.memory.add', { characterId: haku.id, kind: 'relation', aboutId: luna.id, text: 'ルナにツッコむ' });
    await d.call(HUMAN, 'character.memory.add', { characterId: haku.id, kind: 'relation', aboutId: sone.id, text: 'ソネと意気投合' });
    const sup = await d.call(HUMAN, 'session.create', { title: '会議' });
    d.ctx.service('policy').createGrant(
      { subject: { kind: 'session', sessionId: sup.id }, permissions: ['session.spawn'], limits: { maxChildren: 4, maxDepth: 1 }, lifetime: 'session', reason: 'supervisor' },
      HUMAN,
    );
    const actor = agentActor(sup.id, d.ctx.ids.next('run'));
    await d.call(actor, 'session.spawn', { title: 'ルナ', goal: '意見を', mode: 'chat', model: 'mock/meet', characterId: luna.id, speaker: true, start: false });
    const r = await d.call(actor, 'session.spawn', { title: 'ハク', goal: '意見を', mode: 'chat', model: 'mock/meet', characterId: haku.id, speaker: true });
    await d.ctx.service('runs').waitForEnd(r.runId!);
    const system = systemOf(seen.find((q) => systemOf(q).includes('名前: ハク'))!);
    expect(system).toContain('ルナにツッコむ');
    expect(system).not.toContain('ソネと意気投合');
  });

  it('with memory off, nothing is read and nothing is sorted', async () => {
    const d = await daemon();
    const { haku } = await setup(d);
    const seen = spy(d, 'mock/talk');
    await d.call(HUMAN, 'character.memory.add', { characterId: haku.id, kind: 'you', text: '朝が弱い' });
    await d.call(HUMAN, 'settings.update', { members: { memory: false } });
    await talk(d, haku.id, ['おはよう']);
    expect(systemOf(seen[0]!)).not.toContain('朝が弱い');
    expect((await d.call(HUMAN, 'character.digest', { characterId: haku.id })).outcome).toBe('off');
  });
});

describe('sorting memories out', () => {
  it('writes the lists the model returns, keeps the person\'s and books the cost', async () => {
    const d = await daemon();
    const { haku, luna } = await setup(d);
    spy(d, 'mock/talk', 'わたし、リスに梅おにぎりを奪われたことがあるんだ。');
    const kept = await d.call(HUMAN, 'character.memory.add', { characterId: haku.id, kind: 'you', text: '朝が弱い' });
    const calls = sorter(d, {
      self: [{ text: 'リスに梅おにぎりを奪われた' }, { text: '表は右寄せにする', work: true }],
      relations: { ルナ: [{ text: 'ズボラな案にはツッコむ' }], だれか: [{ text: '知らない人' }] },
      you: [{ text: '雨の日は家にいたい' }],
      corrections: [],
    });
    await talk(d, haku.id, ['雨だね', 'なにしよう']);
    expect((await d.call(HUMAN, 'character.digest', { characterId: haku.id })).outcome).toBe('done');
    // What the model read: the member's words and the person's, by scene.
    const user = userOf(calls[0]!);
    expect(user).toContain('[person] 雨だね');
    expect(user).toContain('[self] わたし、リスに梅おにぎりを奪われたことがあるんだ。');
    const page = await d.call(HUMAN, 'character.get', { characterId: haku.id });
    expect(page.memories.map((m) => [m.kind, m.text, m.source])).toEqual([
      ['self', 'リスに梅おにぎりを奪われた', 'auto'],
      ['self', '表は右寄せにする', 'auto'],
      ['relation', 'ズボラな案にはツッコむ', 'auto'],
      ['you', '朝が弱い', 'person'],
      ['you', '雨の日は家にいたい', 'auto'],
    ]);
    expect(page.memories.find((m) => m.kind === 'relation')!.aboutId).toBe(luna.id);
    expect(page.memories.find((m) => m.text === '表は右寄せにする')!.work).toBe(true);
    expect(page.memories.some((m) => m.id === kept.id)).toBe(true);
    expect(page.memoryUsd).toBeCloseTo(0.002);
    // Read up to here: nothing new until they talk again.
    expect((await d.call(HUMAN, 'character.digest', { characterId: haku.id })).outcome).toBe('nothing_new');
  });

  it('never brings back what the person made it forget, and a model cannot pin a memory as the person\'s', async () => {
    const d = await daemon();
    const { haku } = await setup(d);
    spy(d, 'mock/talk');
    const m = await d.call(HUMAN, 'character.memory.add', { characterId: haku.id, kind: 'self', text: 'ツナマヨは邪道' });
    await d.call(HUMAN, 'character.memory.delete', { memoryId: m.id });
    const calls = sorter(d, {
      self: [{ text: 'ツナマヨは邪道！' }, { text: '梅おにぎりが好き' }],
      you: [{ text: '朝は弱くない' }],
      corrections: ['朝は弱くない'],
    });
    await talk(d, haku.id, ['違うよ、朝は弱くないよ', 'ほんと']);
    await d.call(HUMAN, 'character.digest', { characterId: haku.id });
    expect(userOf(calls[0]!)).toContain('never write them again');
    const page = await d.call(HUMAN, 'character.get', { characterId: haku.id });
    expect(page.memories.map((x) => [x.text, x.source])).toEqual([
      ['梅おにぎりが好き', 'auto'],
      ['朝は弱くない', 'auto'],
    ]);
  });

  it('throws away a sorting that would drop half the memories at once', async () => {
    const d = await daemon();
    const { haku } = await setup(d);
    spy(d, 'mock/talk');
    sorter(d, { self: ['a', 'b', 'c', 'd'].map((t) => ({ text: `思い出${t}` })) });
    await talk(d, haku.id, ['1', '2']);
    expect((await d.call(HUMAN, 'character.digest', { characterId: haku.id })).outcome).toBe('done');
    sorter(d, { self: [{ text: '思い出a' }] });
    await talk(d, haku.id, ['3', '4']);
    expect((await d.call(HUMAN, 'character.digest', { characterId: haku.id })).outcome).toBe('rejected');
    expect((await d.call(HUMAN, 'character.get', { characterId: haku.id })).memories).toHaveLength(4);
  });

  it('at work, only the person\'s words are material', async () => {
    const d = await daemon();
    const { haku } = await setup(d);
    spy(d, 'mock/work', 'A 社の売上は 120 万円でした。');
    const calls = sorter(d, { self: [{ text: '金額は右寄せ', work: true }] });
    const owner = await d.call(HUMAN, 'session.create', { title: '月次' });
    const sch = await d.call(HUMAN, 'schedule.create', {
      sessionId: owner.id,
      prompt: '集計して',
      trigger: { kind: 'cron', expr: '0 9 * * *' },
      run: { mode: 'chat', model: 'mock/work', characterId: haku.id },
    });
    const { sessionId } = await d.call(HUMAN, 'schedule.runNow', { scheduleId: sch.id });
    const first = d.ctx.repos.runs.findOne({ where: { session_id: sessionId } })!;
    await d.ctx.service('runs').waitForEnd(first.id);
    const r = await d.call(HUMAN, 'session.send', { sessionId, content: '金額は右寄せにしてね' });
    await d.ctx.service('runs').waitForEnd(r.runId!);
    await d.call(HUMAN, 'character.digest', { characterId: haku.id });
    const user = userOf(calls[0]!);
    expect(user).toContain('[person] 金額は右寄せにしてね');
    expect(user).not.toContain('120 万円');
    expect(user).not.toContain('[person] 集計して');
  });

  it('stops at the daily limit of sorting', async () => {
    const d = await daemon();
    const { haku } = await setup(d);
    spy(d, 'mock/talk');
    sorter(d, { self: [{ text: 'x' }] });
    await d.call(HUMAN, 'settings.update', { background: { dailyUsd: 0.001 } });
    await talk(d, haku.id, ['1', '2']);
    expect((await d.call(HUMAN, 'character.digest', { characterId: haku.id })).outcome).toBe('done');
    await talk(d, haku.id, ['3', '4']);
    expect((await d.call(HUMAN, 'character.digest', { characterId: haku.id })).outcome).toBe('limit');
  });
});

describe('when sorting happens', () => {
  it('once a member has been quiet everywhere for 30 minutes, with enough to read', async () => {
    const clock = createManualClock(Date.UTC(2026, 10, 5, 1));
    const d = await createTestDaemon({ clock });
    cleanups.push(() => d.cleanup());
    d.ctx.service('llm').mock.chunkDelayMs = 0;
    const { haku } = await setup(d);
    spy(d, 'mock/talk');
    sorter(d, { self: [{ text: '雨の日は昼寝' }] });
    const digest = d.ctx.service('memoryDigest');
    await talk(d, haku.id, ['ひとこと']);
    clock.advance(DIGEST_IDLE_MS + 1);
    expect(digest.due(haku.id)).toBe(false); // two lines only
    await talk(d, haku.id, ['もうひとこと']);
    expect(digest.due(haku.id)).toBe(false); // just talked
    clock.advance(DIGEST_IDLE_MS + 1);
    expect(digest.due(haku.id)).toBe(true);
    await digest.check(haku.id);
    expect((await d.call(HUMAN, 'character.get', { characterId: haku.id })).memories.map((m) => m.text)).toEqual([
      '雨の日は昼寝',
    ]);
    expect(digest.due(haku.id)).toBe(false);
  });
});

describe('helpers', () => {
  it('says when a memory is from', () => {
    const now = '2026-11-05T03:00:00.000Z';
    expect(memoryWhen('2026-11-05T01:00:00.000Z', now, 'Asia/Tokyo')).toBe('今日');
    expect(memoryWhen('2026-11-04T01:00:00.000Z', now, 'Asia/Tokyo')).toBe('昨日');
    expect(memoryWhen('2026-11-02T01:00:00.000Z', now, 'Asia/Tokyo')).toBe('3日前');
    expect(memoryWhen('2026-08-02T01:00:00.000Z', now, 'Asia/Tokyo')).toBe('8月');
    expect(memoryWhen('2025-08-02T01:00:00.000Z', now, 'Asia/Tokyo')).toBe('2025年8月');
  });

  it('reads a reply in a fenced block or bare', () => {
    expect(parseDigestReply('```json\n{"self":[]}\n```')).toEqual({ self: [] });
    expect(parseDigestReply('はい {"you":[]} 以上')).toEqual({ you: [] });
    expect(parseDigestReply('だめ')).toBeNull();
  });

  it('the offline sorter keeps everything and adds what the member said about itself', () => {
    const out = JSON.parse(
      mockDigest('Kept now:\n{"self":[{"text":"梅が好き"}],"relations":[],"you":[]}\n[self] こんにちは。わたしは雨が好き。'),
    ) as { self: { text: string }[] };
    expect(out.self.map((m) => m.text)).toEqual(['梅が好き', 'わたしは雨が好き。']);
  });
});
