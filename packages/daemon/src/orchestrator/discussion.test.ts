/**
 * Conversations between AIs: a supervisor leads speakers (children with a persona) turn by
 * turn. Real daemon, mock models: the mock supervisor runs the rounds and the mock speakers
 * play their characters. What is checked is what makes it cheap and readable — the words come
 * to the supervisor inside its wake, it passes them on without retyping them, speakers still
 * answering are gathered into one wake, and only the conclusion becomes an output.
 */
import type { Message, Session } from '@acc/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../core/errors';
import { setSupervisorLimits } from '../inbox/testkit';
import { WAKE_MARKER } from '../inbox/wake';
import { textOfParts } from '../llm/messages';
import { conversationFrame } from '../sessions/framing';
import { HUMAN, SYSTEM, type TestDaemonNoServer, createTestDaemon } from '../testing';
import { MOCK_ORCHESTRATOR_MODEL } from './mockModel';
import { MOCK_SPEAKER_MODEL } from './mockSpeaker';
import { MOCK_DISCUSSION_ROUNDS } from './mockSupervisor';

vi.setConfig({ testTimeout: 60_000 });

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof ApiError ? err.code : String(err);
  }
}

async function daemon(): Promise<TestDaemonNoServer> {
  const d = await createTestDaemon();
  cleanups.push(() => d.cleanup());
  d.ctx.service('llm').mock.chunkDelayMs = 0;
  setSupervisorLimits(d.ctx, { wakeDebounceMs: 100 });
  return d;
}

async function lead(d: TestDaemonNoServer): Promise<Session> {
  const s = await d.call(HUMAN, 'session.create', {
    kind: 'chat',
    title: '司会',
    model: MOCK_ORCHESTRATOR_MODEL,
  });
  await d.call(HUMAN, 'session.delegate', { sessionId: s.id });
  return s;
}

const messagesOf = (d: TestDaemonNoServer, sessionId: string): Message[] =>
  d.ctx.repos.messages.find({ where: { session_id: sessionId }, direction: 'asc' });
const childrenOf = (d: TestDaemonNoServer, sessionId: string): Session[] =>
  d.ctx.repos.sessions.find({ where: { parent_session_id: sessionId }, direction: 'asc' });
const wakesOf = (d: TestDaemonNoServer, sessionId: string): Message[] =>
  messagesOf(d, sessionId).filter((m) => m.meta?.kind === 'wake');
const outputsOf = (d: TestDaemonNoServer, sessionId: string) =>
  d.ctx.repos.artifacts
    .find({ where: { session_id: sessionId }, direction: 'asc' })
    .filter((a) => a.role === 'output');

describe('a discussion between speakers', () => {
  it('runs in rounds, passes words on as they are, and leaves only the conclusion', async () => {
    const d = await daemon();
    const host = await lead(d);
    await d.call(HUMAN, 'session.send', {
      sessionId: host.id,
      content: '「朝食の定期便」の企画会議をして',
    });

    const doc = await until(() => outputsOf(d, host.id)[0]);
    const speakers = childrenOf(d, host.id);
    // Two characters, each a talking chat on its own model.
    expect(speakers.map((s) => [s.title, s.kind, s.model])).toEqual([
      ['ミナト', 'chat', MOCK_SPEAKER_MODEL],
      ['サエ', 'chat', MOCK_SPEAKER_MODEL],
    ]);
    expect(speakers.every((s) => !!s.persona)).toBe(true);

    // One wake per round: the words of both speakers come in it, ready to read.
    const wakes = wakesOf(d, host.id);
    expect(wakes).toHaveLength(MOCK_DISCUSSION_ROUNDS);
    for (const w of wakes) {
      const items = w.meta?.kind === 'wake' ? w.meta.items : [];
      expect(items.map((i) => i.title).sort()).toEqual(['サエ', 'ミナト']);
      expect(items.every((i) => !!i.reply?.text)).toBe(true);
      expect(textOfParts(w.content)).toContain('<<<「ミナト」の発言ここから>>>');
    }

    // From the second round on, each speaker hears the other quoted with their name.
    const [minato, sae] = speakers;
    const toSae = messagesOf(d, sae!.id).filter((m) => m.meta?.kind === 'forward');
    expect(toSae).toHaveLength(MOCK_DISCUSSION_ROUNDS - 1);
    expect(toSae[0]!.meta).toEqual({
      kind: 'forward',
      items: [{ sessionId: minato!.id, title: 'ミナト' }],
    });
    const firstOfMinato = messagesOf(d, minato!.id).find((m) => m.role === 'assistant')!;
    const quoted = textOfParts(toSae[0]!.content);
    expect(quoted).toContain(textOfParts(firstOfMinato.content));
    // …and answers by name.
    const saeSecond = messagesOf(d, sae!.id).filter((m) => m.role === 'assistant')[1]!;
    expect(textOfParts(saeSecond.content)).toContain('ミナトさん');

    // Turns are words, not outputs; the supervisor publishes the conclusion.
    for (const s of speakers) expect(outputsOf(d, s.id)).toEqual([]);
    expect(doc.kind).toBe('document');
    expect(doc.title).toContain('話し合いのまとめ');
    await until(() => !d.ctx.repos.sessions.require(host.id).activeRunId);
    const last = messagesOf(d, host.id)
      .filter((m) => m.role === 'assistant')
      .at(-1)!;
    expect(textOfParts(last.content)).toContain('話し合いが終わりました');
  });

  it('gathers speakers still answering into one wake instead of one per speaker', async () => {
    const d = await daemon();
    // A slow speaker: answers about a second after the quick one.
    d.ctx
      .service('llm')
      .mock.define('mock/slow-speaker', () => ({ text: 'ゆっくり考えました。' }), {
        chunkDelayMs: 150,
      });
    const host = await lead(d);
    for (const [title, model] of [
      ['速い', MOCK_SPEAKER_MODEL],
      ['遅い', 'mock/slow-speaker'],
    ] as const) {
      await d.call(HUMAN, 'session.spawn', {
        parentSessionId: host.id,
        title,
        goal: '「新しい朝食」についてひとこと',
        mode: 'chat',
        persona: `${title}。慎重な人。`,
        model,
      });
    }

    const wake = await until(() => wakesOf(d, host.id)[0]);
    const items = wake.meta?.kind === 'wake' ? wake.meta.items : [];
    expect(items.map((i) => i.title).sort()).toEqual(['速い', '遅い']);
    expect(textOfParts(wake.content)).toContain('ゆっくり考えました。');
  });

  it('refuses a persona outside a chat, and passing on words nobody said yet', async () => {
    const d = await daemon();
    const host = await lead(d);
    expect(
      await codeOf(
        d.call(HUMAN, 'session.spawn', {
          parentSessionId: host.id,
          title: 'エージェント',
          goal: '調べて',
          mode: 'agent',
          persona: '探偵',
        }),
      ),
    ).toBe('invalid_params');
    const { session: quiet } = await d.call(HUMAN, 'session.spawn', {
      parentSessionId: host.id,
      title: 'まだ',
      goal: 'ひとこと',
      mode: 'chat',
      persona: 'まだ話していない人',
      model: MOCK_SPEAKER_MODEL,
      start: false,
    });
    const { session: other } = await d.call(HUMAN, 'session.spawn', {
      parentSessionId: host.id,
      title: '聞き手',
      goal: 'ひとこと',
      mode: 'chat',
      persona: '聞き手',
      model: MOCK_SPEAKER_MODEL,
      start: false,
    });
    expect(
      await codeOf(
        d.call(HUMAN, 'session.send', {
          sessionId: other.id,
          content: 'どう？',
          forward: [quiet.id],
        }),
      ),
    ).toBe('invalid_params');
    // Nobody to pass on (models send an empty list): an ordinary message.
    const sent = await d.call(HUMAN, 'session.send', {
      sessionId: other.id,
      content: 'どう？',
      forward: [],
    });
    expect(d.ctx.repos.messages.require(sent.messageId).meta).toBeNull();
  });
});

describe('one at a time', () => {
  it('a speaker spawned with start: false stays silent and speaks when its turn is sent', async () => {
    const d = await daemon();
    const host = await lead(d);
    const spawn = (title: string, start: boolean) =>
      d.call(HUMAN, 'session.spawn', {
        parentSessionId: host.id,
        title,
        goal: '「朝ごはん」についてひとこと',
        mode: 'chat',
        persona: `${title}。前のめりな人。`,
        model: MOCK_SPEAKER_MODEL,
        start,
      });
    const { session: first } = await spawn('一番手', true);
    const { session: second } = await spawn('二番手', false);

    // Only the first speaks; the silent one does not hold the wake back.
    const wake = await until(() => wakesOf(d, host.id)[0]);
    const items = wake.meta?.kind === 'wake' ? wake.meta.items : [];
    expect(items.map((i) => i.title)).toEqual(['一番手']);
    expect(messagesOf(d, second.id).filter((m) => m.role === 'assistant')).toEqual([]);

    // Its turn: started by the message that passes the first one's words on (sent here by
    // the system in place of the lead: a person's own message would not wake the lead).
    await d.call(SYSTEM, 'session.send', {
      sessionId: second.id,
      content: 'どう？',
      forward: [first.id],
    });
    const next = await until(() => wakesOf(d, host.id)[1]);
    const said = next.meta?.kind === 'wake' ? next.meta.items : [];
    expect(said.map((i) => i.title)).toEqual(['二番手']);
    expect(said[0]!.reply?.text).toContain('一番手さん');
  });
});

describe('a person talking to a speaker directly', () => {
  it('does not wake the lead for that turn, then or later', async () => {
    const d = await daemon();
    const host = await lead(d);
    const { session: speaker } = await d.call(HUMAN, 'session.spawn', {
      parentSessionId: host.id,
      title: 'ミナト',
      goal: '「朝ごはん」についてひとこと',
      mode: 'chat',
      persona: 'ミナト。前のめりな人。',
      model: MOCK_SPEAKER_MODEL,
    });
    // Its part in the discussion (the brief it was given, the lead's rounds) reaches the lead,
    // which runs the rounds to the end.
    await until(() => outputsOf(d, host.id)[0]);
    await until(() => !d.ctx.repos.sessions.require(host.id).activeRunId);
    const leadRuns = () => d.ctx.repos.runs.count({ where: { session_id: host.id } });
    const pending = () =>
      d.ctx.repos.inboxItems.find({ where: { session_id: host.id, status: 'pending' } });
    const before = { runs: leadRuns(), wakes: wakesOf(d, host.id).length };
    expect(before.wakes).toBe(MOCK_DISCUSSION_ROUNDS);

    // The person asks the speaker something themselves: the speaker answers them…
    const sent = await d.call(HUMAN, 'session.send', {
      sessionId: speaker.id,
      content: 'ミナトさん、ひとつ直接聞かせて',
    });
    expect((await d.ctx.service('runs').waitForEnd(sent.runId!)).status).toBe('completed');
    await new Promise((r) => setTimeout(r, 400));
    // …and the lead is not woken for it (no wake, no run, nothing waiting).
    expect(wakesOf(d, host.id)).toHaveLength(before.wakes);
    expect(leadRuns()).toBe(before.runs);
    expect(pending()).toEqual([]);
    // Looked at again later (another change of the speaker), it is still not delivered.
    d.ctx.service('supervisorInbox').evaluateChild(speaker.id);
    expect(pending()).toEqual([]);
  });
});

describe('the frame of a speaker', () => {
  it('plays the persona turn by turn and is not told to hand in a result', async () => {
    const d = await daemon();
    const host = await lead(d);
    const { session } = await d.call(HUMAN, 'session.spawn', {
      parentSessionId: host.id,
      title: 'ミナト',
      goal: '最初の意見を',
      mode: 'chat',
      persona: 'ミナト。前のめりな企画屋。',
      model: MOCK_SPEAKER_MODEL,
      start: false,
    });
    const frame = conversationFrame(d.ctx, session, { kind: 'chat', tools: 0 });
    expect(frame).toContain(
      '<<<キャラここから>>>\nミナト。前のめりな企画屋。\n<<<キャラここまで>>>',
    );
    expect(frame).toContain('one turn of the conversation');
    expect(frame).not.toContain('sum up the result');
    expect(frame).not.toContain(WAKE_MARKER);
  });
});
