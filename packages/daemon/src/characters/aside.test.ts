import type { ChatRequest } from '../llm/types';
import { afterEach, describe, expect, it } from 'vitest';
import { HUMAN, type TestDaemonNoServer, agentActor, createTestDaemon } from '../testing';

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

const contentOf = (req: ChatRequest, i: number) => (req.messages[i] as { content: string }).content;

function spy(d: TestDaemonNoServer, model: string, reply: { text?: string; error?: string } = { text: 'はい' }): ChatRequest[] {
  const seen: ChatRequest[] = [];
  d.ctx.service('llm').mock.define(model, (req) => {
    seen.push(req);
    return { ...reply, usage: { inputTokens: 500, outputTokens: 60, costUsd: 0.003, costSource: 'estimated' } };
  });
  return seen;
}

async function chat(d: TestDaemonNoServer) {
  const s = await d.call(HUMAN, 'session.create', { title: 'API の命名', model: 'mock/host' });
  const r = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: '注文の取り消し、cancel と void どっち？' });
  await d.ctx.service('runs').waitForEnd(r.runId!);
  return s;
}

describe('a remark from a member (@name)', () => {
  it('reads the latest messages, answers once in its voice, and the conversation itself does not answer', async () => {
    const d = await daemon();
    spy(d, 'mock/host', { text: '外から見た意味なら cancel がおすすめです。' });
    const luna = await d.call(HUMAN, 'character.create', { name: 'ルナ', profile: 'ズボラな猫。語尾は〜。', model: 'mock/luna' });
    await d.call(HUMAN, 'character.memory.add', { characterId: luna.id, kind: 'you', text: '費用にうるさい' });
    const seen = spy(d, 'mock/luna', { text: 'cancel に一票〜。返金まで含むなら名前に出したほうがいいよ。' });
    const s = await chat(d);
    const runsBefore = d.ctx.repos.runs.count({ where: { session_id: s.id } });

    const { ask, reply } = await d.call(HUMAN, 'character.aside', {
      sessionId: s.id,
      characterId: luna.id,
      text: '@ルナ どう思う？',
    });
    expect(ask.meta).toEqual({ kind: 'aside', characterId: luna.id, reply: false });
    expect(reply.meta).toEqual({ kind: 'aside', characterId: luna.id, reply: true });
    expect(reply.content).toEqual([{ type: 'text', text: 'cancel に一票〜。返金まで含むなら名前に出したほうがいいよ。' }]);
    expect(d.ctx.repos.runs.count({ where: { session_id: s.id } })).toBe(runsBefore);

    const system = contentOf(seen[0]!, 0);
    expect(system).toContain('名前: ルナ\nズボラな猫。語尾は〜。');
    expect(system).toContain('費用にうるさい');
    const user = contentOf(seen[0]!, 1);
    expect(user).toContain('<<<会話ここから>>>\nあなた: 注文の取り消し、cancel と void どっち？\nAI: 外から見た意味なら cancel がおすすめです。\n<<<会話ここまで>>>');
    expect(user.endsWith('@ルナ どう思う？')).toBe(true);
  });

  it("the conversation's own model hears the remark as the member's on its next turn", async () => {
    const d = await daemon();
    const host = spy(d, 'mock/host');
    const luna = await d.call(HUMAN, 'character.create', { name: 'ルナ', model: 'mock/luna' });
    spy(d, 'mock/luna', { text: 'cancel に一票〜' });
    const s = await chat(d);
    await d.call(HUMAN, 'character.aside', { sessionId: s.id, characterId: luna.id, text: '@ルナ どう？' });
    const r = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: 'じゃあ cancel で' });
    await d.ctx.service('runs').waitForEnd(r.runId!);
    const messages = host.at(-1)!.messages.map((m) => (m as { content: string }).content);
    expect(messages).toContain('@ルナ どう？');
    expect(messages).toContain('[メンバー「ルナ」から] cancel に一票〜');
  });

  it('costs the conversation and the member', async () => {
    const d = await daemon();
    spy(d, 'mock/host');
    const luna = await d.call(HUMAN, 'character.create', { name: 'ルナ', model: 'mock/luna' });
    spy(d, 'mock/luna');
    const s = await chat(d);
    const before = d.ctx.repos.sessions.require(s.id).cost.ownUsd;
    await d.call(HUMAN, 'character.aside', { sessionId: s.id, characterId: luna.id, text: '@ルナ どう？' });
    expect(d.ctx.repos.sessions.require(s.id).cost.ownUsd).toBeCloseTo(before + 0.003);
    expect((await d.call(HUMAN, 'character.get', { characterId: luna.id })).monthUsd).toBeCloseTo(0.003);
  });

  it('a failed call leaves nothing in the conversation', async () => {
    const d = await daemon();
    spy(d, 'mock/host');
    const luna = await d.call(HUMAN, 'character.create', { name: 'ルナ', model: 'mock/luna' });
    spy(d, 'mock/luna', { error: 'overloaded' });
    const s = await chat(d);
    const count = d.ctx.repos.messages.count({ where: { session_id: s.id } });
    await expect(d.call(HUMAN, 'character.aside', { sessionId: s.id, characterId: luna.id, text: '@ルナ' })).rejects.toThrow();
    expect(d.ctx.repos.messages.count({ where: { session_id: s.id } })).toBe(count);
  });

  it('only the person calls a member in', async () => {
    const d = await daemon();
    spy(d, 'mock/host');
    const luna = await d.call(HUMAN, 'character.create', { name: 'ルナ', model: 'mock/luna' });
    const s = await chat(d);
    d.ctx.service('policy').createGrant(
      { subject: { kind: 'session', sessionId: s.id }, permissions: ['character.*'], limits: {}, lifetime: 'session', reason: 'supervisor' },
      HUMAN,
    );
    await expect(
      d.call(agentActor(s.id, d.ctx.ids.next('run')), 'character.aside', { sessionId: s.id, characterId: luna.id, text: '@ルナ' }),
    ).rejects.toThrow(/人だけ/);
  });

  it("the remark and the ask are material for the member's memories", async () => {
    const d = await daemon();
    spy(d, 'mock/host');
    await d.call(HUMAN, 'settings.update', { members: { memoryModel: 'mock/sorter' } });
    const sorter = spy(d, 'mock/sorter', { text: '{"self":[{"text":"cancel 派"}]}' });
    const luna = await d.call(HUMAN, 'character.create', { name: 'ルナ', model: 'mock/luna' });
    spy(d, 'mock/luna', { text: 'わたしは cancel 派だよ〜' });
    const s = await chat(d);
    await d.call(HUMAN, 'character.aside', { sessionId: s.id, characterId: luna.id, text: '@ルナ どっち派？' });
    expect((await d.call(HUMAN, 'character.digest', { characterId: luna.id })).outcome).toBe('done');
    const user = contentOf(sorter[0]!, 1);
    expect(user).toContain('[person] @ルナ どっち派？');
    expect(user).toContain('[self] わたしは cancel 派だよ〜');
    expect(user).not.toContain('cancel と void どっち');
  });
});
