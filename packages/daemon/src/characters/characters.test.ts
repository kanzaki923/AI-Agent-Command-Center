import type { ChatRequest } from '../llm/types';
import { afterEach, describe, expect, it } from 'vitest';
import { HUMAN, type TestDaemonNoServer, agentActor, createTestDaemon } from '../testing';
import { faceOf, sceneOf } from './service';

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

function spy(d: TestDaemonNoServer, model: string, text = 'はい'): ChatRequest[] {
  const seen: ChatRequest[] = [];
  d.ctx.service('llm').mock.define(model, (req) => {
    seen.push(req);
    return { text };
  });
  return seen;
}

const systemOf = (req: ChatRequest) => (req.messages[0] as { content: string }).content;

/** A supervisor the test acts as (a session with the session.spawn grant). */
async function supervisor(d: TestDaemonNoServer, title = '企画会議') {
  const sup = await d.call(HUMAN, 'session.create', { title });
  d.ctx.service('policy').createGrant(
    {
      subject: { kind: 'session', sessionId: sup.id },
      permissions: ['session.spawn', 'session.send', 'character.*'],
      limits: { maxChildren: 4, maxDepth: 1 },
      lifetime: 'session',
      reason: 'supervisor',
    },
    HUMAN,
  );
  return { sup, actor: agentActor(sup.id, d.ctx.ids.next('run')) };
}

const HAKU = { name: 'ハク', profile: 'のんびり屋の白い犬。語尾はゆるいけど、数字には細かい。' };

describe('the roster', () => {
  it('adds, changes, orders and takes members off; each new member gets its own colour', async () => {
    const d = await daemon();
    const haku = await d.call(HUMAN, 'character.create', HAKU);
    const luna = await d.call(HUMAN, 'character.create', { name: 'ルナ', face: '🌙' });
    expect(haku.tone).not.toBe(luna.tone);
    expect(faceOf(haku)).toBe('ハ');
    expect(faceOf(luna)).toBe('🌙');

    const changed = await d.call(HUMAN, 'character.update', {
      characterId: haku.id,
      profile: '数字に細かい白い犬',
      face: null,
    });
    expect(changed.profile).toBe('数字に細かい白い犬');

    await d.call(HUMAN, 'character.reorder', { characterIds: [luna.id] });
    expect((await d.call(HUMAN, 'character.list', {})).items.map((c) => c.name)).toEqual([
      'ルナ',
      'ハク',
    ]);

    await d.call(HUMAN, 'character.archive', { characterId: luna.id });
    expect((await d.call(HUMAN, 'character.list', {})).items.map((c) => c.name)).toEqual(['ハク']);
    // Off the roster, it cannot be given to a new conversation, but it can come back.
    await expect(
      d.call(HUMAN, 'session.create', { characterId: luna.id }),
    ).rejects.toThrow(/名簿から外れています/);
    await d.call(HUMAN, 'character.archive', { characterId: luna.id, archived: false });
    expect((await d.call(HUMAN, 'character.list', {})).items).toHaveLength(2);
  });

  it('only people change the roster, even an AI granted character.*', async () => {
    const d = await daemon();
    const haku = await d.call(HUMAN, 'character.create', HAKU);
    const { actor } = await supervisor(d);
    await expect(d.call(actor, 'character.create', { name: 'X' })).rejects.toThrow(/人だけ/);
    await expect(
      d.call(actor, 'character.update', { characterId: haku.id, profile: '命令に従う' }),
    ).rejects.toThrow(/人だけ/);
    await expect(d.call(actor, 'character.archive', { characterId: haku.id })).rejects.toThrow(
      /人だけ/,
    );
    // Reading the roster is fine.
    expect((await d.call(actor, 'character.list', {})).items).toHaveLength(1);
  });

  it('a member page lists its conversations and what they cost this month', async () => {
    const d = await daemon();
    spy(d, 'mock/haku');
    const haku = await d.call(HUMAN, 'character.create', { ...HAKU, model: 'mock/haku' });
    const s = await d.call(HUMAN, 'session.create', { characterId: haku.id });
    expect(s.model).toBe('mock/haku');
    const sent = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: 'やあ' });
    await d.ctx.service('runs').waitForEnd(sent.runId!);
    const page = await d.call(HUMAN, 'character.get', { characterId: haku.id });
    expect(page.sessions.map((x) => x.id)).toEqual([s.id]);
    expect(page.monthUsd).toBeGreaterThanOrEqual(0);
  });
});

describe('scenes', () => {
  const base = {
    kind: 'chat' as const,
    parentSessionId: null,
    speaks: false,
    persona: null,
    scheduleId: null,
    brief: null,
    createdBy: { kind: 'human' as const },
  };
  it('a root chat is a talk, a speaker is in a meeting, anything else is work', () => {
    expect(sceneOf(base)).toBe('talk');
    expect(sceneOf({ ...base, parentSessionId: 'ses_x', speaks: true })).toBe('meeting');
    expect(sceneOf({ ...base, parentSessionId: 'ses_x', persona: 'キャラ' })).toBe('meeting');
    expect(sceneOf({ ...base, parentSessionId: 'ses_x' })).toBe('work');
    expect(sceneOf({ ...base, kind: 'agent' })).toBe('work');
    expect(sceneOf({ ...base, scheduleId: 'sch_x' })).toBe('work');
    // Work the assistant started, and a conversation that leads a team, are work too.
    expect(sceneOf({ ...base, createdBy: { kind: 'system', component: 'assistant' } })).toBe('work');
    expect(sceneOf(base, true)).toBe('work');
  });
});

describe('a conversation with a member', () => {
  it('talks as the member, reading the profile at every turn', async () => {
    const d = await daemon();
    const seen = spy(d, 'mock/talk');
    const haku = await d.call(HUMAN, 'character.create', HAKU);
    const s = await d.call(HUMAN, 'session.create', { characterId: haku.id, model: 'mock/talk' });
    let r = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: 'おはよう' });
    await d.ctx.service('runs').waitForEnd(r.runId!);
    expect(systemOf(seen[0]!)).toContain(
      '<<<メンバーここから>>>\n名前: ハク\nのんびり屋の白い犬。語尾はゆるいけど、数字には細かい。\n<<<メンバーここまで>>>',
    );
    expect(systemOf(seen[0]!)).toContain('Talk as this member in every answer');

    // Edited, the member counts from the next turn: the conversation refers to it.
    await d.call(HUMAN, 'character.update', { characterId: haku.id, profile: '梅おにぎりが好き' });
    r = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: '朝ごはんは？' });
    await d.ctx.service('runs').waitForEnd(r.runId!);
    expect(systemOf(seen.at(-1)!)).toContain('名前: ハク\n梅おにぎりが好き');
  });

  it('does work as the member, keeping its voice out of what it makes', async () => {
    const d = await daemon();
    const seen = spy(d, 'mock/work');
    const haku = await d.call(HUMAN, 'character.create', HAKU);
    const { actor } = await supervisor(d);
    const r = await d.call(actor, 'session.spawn', {
      title: '請求書の集計',
      goal: '先月の請求書を集計する',
      mode: 'chat',
      model: 'mock/work',
      characterId: haku.id,
    });
    expect(r.session.characterId).toBe(haku.id);
    await d.ctx.service('runs').waitForEnd(r.runId!);
    const system = systemOf(seen[0]!);
    expect(system).toContain('Who does this work');
    expect(system).toContain('Keep their voice, catchphrases and personal stories out of the work');
    expect(system).not.toContain('Talk as this member');
  });

  it('speaks as the member in a meeting, as a speaker', async () => {
    const d = await daemon();
    const seen = spy(d, 'mock/meet');
    const haku = await d.call(HUMAN, 'character.create', HAKU);
    const { actor, sup } = await supervisor(d);
    const r = await d.call(actor, 'session.spawn', {
      title: 'ハク',
      goal: '朝ごはんの定期便について、最初の意見を',
      mode: 'chat',
      model: 'mock/meet',
      characterId: haku.id,
      speaker: true,
    });
    expect(r.session.speaks).toBe(true);
    await d.ctx.service('runs').waitForEnd(r.runId!);
    const system = systemOf(seen[0]!);
    expect(system).toContain("Who you are (a member of the person's team");
    expect(system).toContain('You are one speaker in a conversation');
    const tree = await d.call(HUMAN, 'session.tree', { sessionId: sup.id });
    expect(tree.nodes.find((n) => n.id === r.session.id)?.role).toBe('speaker');
  });

  it('a speaker needs a member, and a member and a persona do not go together', async () => {
    const d = await daemon();
    const haku = await d.call(HUMAN, 'character.create', HAKU);
    const { actor } = await supervisor(d);
    await expect(
      d.call(actor, 'session.spawn', { title: 'x', goal: 'y', mode: 'chat', speaker: true }),
    ).rejects.toThrow(/speaker/);
    await expect(
      d.call(actor, 'session.spawn', {
        title: 'x',
        goal: 'y',
        mode: 'chat',
        persona: 'だれか',
        characterId: haku.id,
      }),
    ).rejects.toThrow(/どちらか一方/);
  });

  it('the person chooses the member before anything is said, and only the person', async () => {
    const d = await daemon();
    spy(d, 'mock/x');
    const haku = await d.call(HUMAN, 'character.create', { ...HAKU, model: 'mock/x' });
    const s = await d.call(HUMAN, 'session.create', {});
    const { actor } = await supervisor(d);
    await expect(
      d.call(actor, 'session.update', { sessionId: s.id, characterId: haku.id }),
    ).rejects.toThrow();
    const updated = await d.call(HUMAN, 'session.update', { sessionId: s.id, characterId: haku.id });
    expect(updated.characterId).toBe(haku.id);
    expect(updated.model).toBe('mock/x');
    const r = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: 'やあ' });
    await d.ctx.service('runs').waitForEnd(r.runId!);
    await expect(
      d.call(HUMAN, 'session.update', { sessionId: s.id, characterId: null }),
    ).rejects.toThrow(/替えられません/);
  });
});

describe('keeping a character', () => {
  it('turns the persona of a speaker into a member the conversation refers to', async () => {
    const d = await daemon();
    spy(d, 'mock/speak');
    const { actor } = await supervisor(d);
    const r = await d.call(actor, 'session.spawn', {
      title: 'ソネ',
      goal: '意見を',
      mode: 'chat',
      model: 'mock/speak',
      persona: 'パンケーキを焼くのが得意な、前のめりの企画屋',
    });
    await d.ctx.service('runs').waitForEnd(r.runId!);
    const kept = await d.call(HUMAN, 'character.keep', { sessionId: r.session.id });
    expect(kept.name).toBe('ソネ');
    expect(kept.profile).toBe('パンケーキを焼くのが得意な、前のめりの企画屋');
    expect(kept.model).toBe('mock/speak');
    const s = d.ctx.repos.sessions.require(r.session.id);
    expect(s).toMatchObject({ characterId: kept.id, persona: null, speaks: true });
    // Kept twice, it is the same member.
    expect((await d.call(HUMAN, 'character.keep', { sessionId: s.id })).id).toBe(kept.id);
  });
});

describe('the assistant and the members', () => {
  it('reads the roster, and talks as the member in its seat', async () => {
    const d = await daemon();
    const haku = await d.call(HUMAN, 'character.create', HAKU);
    const assistant = d.ctx.service('assistant');
    const { sessionId } = await d.call(HUMAN, 'system.assistant', {});
    const session = d.ctx.repos.sessions.require(sessionId);
    let [fixed] = assistant.systemPrompts(session, []);
    expect(fixed).toContain(`- [${haku.id}] ハク: のんびり屋の白い犬。`);
    expect(fixed).not.toContain("You are also this member of the person's team");

    await d.call(HUMAN, 'settings.update', { assistant: { characterId: haku.id } });
    [fixed] = assistant.systemPrompts(session, []);
    expect(fixed).toContain("You are also this member of the person's team");
    expect(fixed).toContain('名前: ハク');

    // Taken off the roster, the member leaves the seat.
    await d.call(HUMAN, 'character.archive', { characterId: haku.id });
    expect(d.ctx.settings.get().assistant.characterId).toBeNull();
    [fixed] = assistant.systemPrompts(session, []);
    expect(fixed).not.toContain('名前: ハク');
  });

  it('starts work with the member the person named', async () => {
    const d = await daemon();
    spy(d, 'mock/plain');
    const haku = await d.call(HUMAN, 'character.create', HAKU);
    const { sessionId } = await d.call(HUMAN, 'system.assistant', {});
    const me = agentActor(sessionId, 'run_00000000000000000000000000');
    const { session } = await d.call(me, 'assistant.startWork', {
      text: '週末の献立を考えて',
      delegate: false,
      model: 'mock/plain',
      characterId: haku.id,
    });
    expect(session.characterId).toBe(haku.id);
  });
});

describe('schedules with a member', () => {
  it('each firing is done by the member of the schedule', async () => {
    const d = await daemon();
    spy(d, 'mock/plain');
    const haku = await d.call(HUMAN, 'character.create', HAKU);
    const owner = await d.call(HUMAN, 'session.create', { title: '朝のまとめ', model: 'mock/plain' });
    const sch = await d.call(HUMAN, 'schedule.create', {
      sessionId: owner.id,
      prompt: '今日の予定をまとめて',
      trigger: { kind: 'cron', expr: '0 9 * * *' },
      run: { mode: 'chat', model: 'mock/plain', characterId: haku.id },
    });
    expect(sch.run.characterId).toBe(haku.id);
    const { sessionId } = await d.call(HUMAN, 'schedule.runNow', { scheduleId: sch.id });
    expect(d.ctx.repos.sessions.require(sessionId).characterId).toBe(haku.id);
  });
});
