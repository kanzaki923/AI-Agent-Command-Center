/**
 * The assistant (right-hand spec §1, §3): one permission-bearing chat beside the human. Its
 * permissions (allowed and denied), the roots it starts, the limit of three per message, its
 * daily limit, and the offline `mock/right-hand` through the real tool loop.
 */
import type { Message, Run } from '@acc/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../core/errors';
import { insertDocument, openAttention } from '../home/testutil';
import { apiTools, methodForToolName } from '../llm';
import type { ChatRequest } from '../llm/types';
import { HUMAN, type TestDaemonNoServer, agentActor, createTestDaemon } from '../testing';
import { ASSISTANT_TITLE, MAX_TREES_PER_MESSAGE, MOCK_RIGHT_HAND_MODEL } from './permissions';
import { rememberPastRuns } from './history';
import { cronOf } from './mockRightHand';
import { NOTICES_PER_HOUR } from './notify';
import { STATUS_HEADING, statusBlock } from './prompt';
import { titleFromRequest } from './service';

const daemons: TestDaemonNoServer[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.cleanup();
});

async function daemon() {
  const d = await createTestDaemon();
  daemons.push(d);
  d.ctx.service('llm').mock.chunkDelayMs = 0;
  return d;
}

const texts = (msgs: Message[]) =>
  msgs
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''))
    .filter(Boolean);

/** Send to the assistant and wait for its run to end. */
async function ask(d: TestDaemonNoServer, sessionId: string, content: string): Promise<Run> {
  const r = await d.call(HUMAN, 'session.send', { sessionId, content });
  return d.ctx.service('runs').waitForEnd(r.runId!);
}

describe('system.assistant', () => {
  it('creates the assistant once, as a chat with a grant over every tree, and keeps it off the home trees', async () => {
    const d = await daemon();
    const a = await d.call(HUMAN, 'system.assistant', {});
    const again = await d.call(HUMAN, 'system.assistant', {});
    expect(again.sessionId).toBe(a.sessionId);
    const s = d.ctx.repos.sessions.require(a.sessionId);
    expect(s).toMatchObject({ kind: 'chat', title: ASSISTANT_TITLE, parentSessionId: null });
    expect(s.model).toBeNull();
    const grants = d.ctx.service('policy').sessionGrantsAllowing(s.id, 'home.get');
    expect(grants).toHaveLength(1);
    expect(grants[0]!.scope.allSessions).toBe(true);
    expect(grants[0]!.lifetime).toBe('session');

    await d.call(HUMAN, 'session.create', { kind: 'chat', title: '普通の会話' });
    const home = await d.call(HUMAN, 'home.get', {});
    expect(home.trees.map((t) => t.root.title)).toEqual(['普通の会話']);
    // The card of the assistant itself carries its role (the sidebar's fixed row).
    const tree = await d.call(HUMAN, 'session.tree', { sessionId: s.id });
    expect(tree.nodes[0]).toMatchObject({ role: 'assistant' });
  });

  it('cannot be archived or made a supervisor', async () => {
    const d = await daemon();
    const { sessionId } = await d.call(HUMAN, 'system.assistant', {});
    await expect(d.call(HUMAN, 'session.archive', { sessionId })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(d.call(HUMAN, 'session.delegate', { sessionId })).rejects.toMatchObject({
      code: 'invalid_params',
    });
  });
});

describe('what the assistant may call (the grant, not the prompt)', () => {
  it('offers the overview, starting work, talking to and stopping trees, schedules; never the turn of the human', async () => {
    const d = await daemon();
    const { sessionId } = await d.call(HUMAN, 'system.assistant', {});
    const tools = apiTools(d.ctx, agentActor(sessionId, 'run_00000000000000000000000000')).map(
      (t) => methodForToolName(t.name),
    );
    for (const m of [
      'home.get',
      'assistant.startWork',
      'session.send',
      'session.stop',
      'session.resume',
      'session.tree',
      'schedule.create',
      'cost.summary',
      'project.list',
    ]) {
      expect(tools, m).toContain(m);
    }
    for (const m of [
      'attention.respond',
      'attention.dismiss',
      'session.spawn',
      'session.archive',
      'session.setBudget',
      'cost.raiseDaily',
      'settings.update',
      'project.create',
      'system.shutdown',
      'grant.create',
    ]) {
      expect(tools, m).not.toContain(m);
    }
  });

  it('reaches other trees: stops a root it did not start, is refused the turn of the human', async () => {
    const d = await daemon();
    const { sessionId } = await d.call(HUMAN, 'system.assistant', {});
    const other = await d.call(HUMAN, 'session.create', { kind: 'chat', title: 'よその会話' });
    const me = agentActor(sessionId, 'run_00000000000000000000000000');
    const stopped = await d.call(me, 'session.stop', { sessionId: other.id, tree: true });
    expect(stopped.stoppedSessionIds).toContain(other.id);
    expect((await d.call(me, 'session.list', {})).items.map((s) => s.id)).toContain(other.id);
    await expect(
      d.call(me, 'attention.respond', { attentionId: 'atn_00000000000000000000000000', text: 'x' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('assistant.startWork', () => {
  it('starts a delegated root from the words of the human, unchanged; the lane says the assistant started it', async () => {
    const d = await daemon();
    const { sessionId } = await d.call(HUMAN, 'system.assistant', {});
    const me = agentActor(sessionId, 'run_00000000000000000000000000');
    const text = '来月のローンチ準備を進めて。\n競合の価格、FAQ、告知文。';
    const { session } = await d.call(me, 'assistant.startWork', { text });
    expect(session.title).toBe('来月のローンチ準備を進めて。');
    expect(session.parentSessionId).toBeNull();
    expect(d.ctx.service('policy').sessionAllows(session.id, 'session.spawn')).toBe(true);
    const msgs = await d.call(HUMAN, 'session.messages', { sessionId: session.id });
    expect(msgs.items[0]).toMatchObject({
      role: 'user',
      author: { kind: 'system', component: 'assistant' },
      content: [{ type: 'text', text }],
    });
    const home = await d.call(HUMAN, 'home.get', {});
    const tree = home.trees.find((t) => t.root.id === session.id)!;
    expect(tree.root).toMatchObject({ startedBy: 'assistant', role: 'supervisor' });
    expect(tree.goal).toBe('来月のローンチ準備を進めて。');
  });

  it('a human starts a single agent in the code of a project; the limit of three is for the assistant only', async () => {
    const d = await daemon();
    const { session } = await d.call(HUMAN, 'assistant.startWork', {
      text: 'ブログ記事を書いて',
      delegate: false,
    });
    expect(session.kind).toBe('chat');
    expect(d.ctx.service('policy').sessionAllows(session.id, 'session.spawn')).toBe(false);
    const home = await d.call(HUMAN, 'home.get', {});
    expect(home.trees.find((t) => t.root.id === session.id)!.root.startedBy).toBe('human');

    const { sessionId } = await d.call(HUMAN, 'system.assistant', {});
    const me = agentActor(sessionId, 'run_00000000000000000000000000');
    for (let i = 0; i < MAX_TREES_PER_MESSAGE; i++) {
      await d.call(me, 'assistant.startWork', { text: `仕事 ${i}` });
    }
    await expect(d.call(me, 'assistant.startWork', { text: 'もう 1 本' })).rejects.toMatchObject({
      code: 'limit_exceeded',
    });
    // Another run of the assistant starts fresh.
    const next = agentActor(sessionId, 'run_00000000000000000000000000001');
    await expect(d.call(next, 'assistant.startWork', { text: '次の言葉' })).resolves.toBeTruthy();
  });

  it('names a conversation by the first line of what was asked, cut to 40 characters', () => {
    expect(titleFromRequest('  競合の価格を調べて\n詳しくは添付を見て ')).toBe(
      '競合の価格を調べて',
    );
    const long = 'あ'.repeat(60);
    expect(titleFromRequest(long)).toBe(`${'あ'.repeat(39)}…`);
  });
});

describe('mock/right-hand through the real tool loop', () => {
  it('new work → a lane is born and the assistant says so; 今どう？ → one or two lines; 止めて → stopped', async () => {
    const d = await daemon();
    const { sessionId } = await d.call(HUMAN, 'system.assistant', {});

    const r1 = await ask(d, sessionId, '来月のローンチ準備を進めて');
    expect(r1.status).toBe('completed');
    expect(r1.model).toBe(MOCK_RIGHT_HAND_MODEL);
    let home = await d.call(HUMAN, 'home.get', {});
    expect(home.trees).toHaveLength(1);
    expect(home.trees[0]!.root).toMatchObject({
      title: '来月のローンチ準備を進めて',
      startedBy: 'assistant',
      role: 'supervisor',
    });
    let said = texts((await d.call(HUMAN, 'session.messages', { sessionId })).items);
    expect(said.at(-1)).toBe('「来月のローンチ準備を進めて」を始めます。終わったら知らせます。');

    const r2 = await ask(d, sessionId, '今どう？');
    expect(r2.status).toBe('completed');
    said = texts((await d.call(HUMAN, 'session.messages', { sessionId })).items);
    expect(said.at(-1)).toMatch(/出番/);
    expect(said.at(-1)).toContain('「来月のローンチ準備を進めて」');
    expect(said.at(-1)!.split('\n').length).toBeLessThanOrEqual(2);

    const r3 = await ask(d, sessionId, 'ローンチ準備を止めて');
    expect(r3.status).toBe('completed');
    home = await d.call(HUMAN, 'home.get', {});
    expect(home.trees[0]!.root.state).toBe('stopped');
    said = texts((await d.call(HUMAN, 'session.messages', { sessionId })).items);
    expect(said.at(-1)).toBe('止めました。再開は言ってください。');
  });

  it('毎朝 9 時 → a conversation with a schedule; the reply names the rhythm', async () => {
    const d = await daemon();
    const { sessionId } = await d.call(HUMAN, 'system.assistant', {});
    const run = await ask(d, sessionId, '毎朝 9 時に昨日のまとめを作って');
    expect(run.status).toBe('completed');
    const schedules = await d.call(HUMAN, 'schedule.list', {});
    expect(schedules.items).toHaveLength(1);
    expect(schedules.items[0]!.trigger).toMatchObject({ kind: 'cron', expr: '0 9 * * *' });
    const owner = d.ctx.repos.sessions.require(schedules.items[0]!.sessionId);
    expect(owner.id).not.toBe(sessionId);
    expect(owner.title).toBe('毎朝 9 時に昨日のまとめを作って');
    const said = texts((await d.call(HUMAN, 'session.messages', { sessionId })).items);
    expect(said.at(-1)).toMatch(/^毎朝 9:00。最初は /);
    expect(cronOf('毎週 10 時に')).toBe('0 10 * * 1');
    expect(cronOf('毎日')).toBe('0 9 * * *');
  });

  it('stops for the day at settings.assistant.dailyUsd', async () => {
    const d = await daemon();
    const { sessionId } = await d.call(HUMAN, 'system.assistant', {});
    await d.call(HUMAN, 'settings.update', { assistant: { dailyUsd: 0 } });
    expect((await d.call(HUMAN, 'settings.get', {})).assistant).toEqual({
      model: null,
      dailyUsd: 0,
    });
    const run = await ask(d, sessionId, '今どう？');
    expect(run.status).toBe('failed');
    expect(run.error?.message).toContain('右腕は今日の上限');
    expect(() => d.ctx.service('assistant').assertWithinDailyLimit()).toThrow(ApiError);
  });
});

describe('the status in the system prompt', () => {
  it('lists each tree with its children and the open items, so 今どう？ needs no tool call', async () => {
    const d = await daemon();
    await d.call(HUMAN, 'system.assistant', {});
    const root = d.ctx.service('sessions').create({ kind: 'chat', title: 'ローンチ準備' }, HUMAN);
    const child = d.ctx
      .service('sessions')
      .create({ kind: 'agent', title: 'FAQ を書く', parentSessionId: root.id }, HUMAN);
    openAttention(d.ctx, child.id, 'question', '価格を載せますか？');
    const block = statusBlock(d.ctx);
    expect(block).toContain(STATUS_HEADING);
    expect(block).toMatch(
      /^- \[ses_[0-9a-z]+\] 「ローンチ準備」 state=\w+ progress=0\/1 needsYou=1$/m,
    );
    expect(block).toContain('    - 「FAQ を書く」 state=needs_you');
    expect(block).toContain('      質問: 「価格を載せますか？」');
    // The assistant itself is not a tree.
    expect(block).not.toContain(ASSISTANT_TITLE);
  });
});

describe('what the assistant remembers of past runs', () => {
  const msg = (over: Partial<Message> & Pick<Message, 'role' | 'content'>): Message => ({
    id: `msg_${String(Math.random()).slice(2, 28).padEnd(26, '0')}`,
    sessionId: 'ses_00000000000000000000000000',
    runId: null,
    author: HUMAN,
    model: null,
    createdAt: '2026-10-30T00:00:00.000Z',
    delivery: 'delivered',
    meta: null,
    usage: null,
    ...over,
  });

  it('keeps the calls of a past run, cuts their results to a digest and drops reasoning; the current run stays whole', () => {
    const history: Message[] = [
      msg({ role: 'user', content: [{ type: 'text', text: '準備を進めて' }] }),
      msg({
        role: 'assistant',
        runId: 'run_1',
        content: [
          { type: 'reasoning', text: '…' },
          {
            type: 'tool_call',
            toolCallId: 'c1',
            name: 'assistant.startWork',
            input: { text: '準備を進めて', title: '準備' },
          },
        ],
      }),
      msg({
        role: 'tool',
        runId: 'run_1',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'c1',
            output: { session: { id: 'ses_1', title: '準備', state: 'working', cost: {} } },
            isError: false,
          },
        ],
      }),
      msg({
        role: 'assistant',
        runId: 'run_1',
        content: [{ type: 'text', text: '「準備」を始めます。' }],
      }),
      msg({ role: 'user', content: [{ type: 'text', text: '止めて' }] }),
      msg({
        role: 'assistant',
        runId: 'run_2',
        content: [
          {
            type: 'tool_call',
            toolCallId: 'c2',
            name: 'session.stop',
            input: { sessionId: 'ses_1', tree: true },
          },
        ],
      }),
      msg({
        role: 'tool',
        runId: 'run_2',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'c2',
            output: { error: { code: 'forbidden', message: 'だめ' } },
            isError: true,
          },
        ],
      }),
      msg({ role: 'user', content: [{ type: 'text', text: '今どう？' }] }),
      msg({
        role: 'assistant',
        runId: 'run_3',
        content: [{ type: 'tool_call', toolCallId: 'c3', name: 'home.get', input: {} }],
      }),
      msg({
        role: 'tool',
        runId: 'run_3',
        content: [{ type: 'tool_result', toolCallId: 'c3', output: { trees: [] }, isError: false }],
      }),
    ];
    const kept = rememberPastRuns(history, 'run_3');
    expect(kept.map((m) => m.role)).toEqual(history.map((m) => m.role));
    // The call stays a call (no reasoning); its result is the digest, not the Session.
    expect(kept[1]!.content).toEqual([
      {
        type: 'tool_call',
        toolCallId: 'c1',
        name: 'assistant.startWork',
        input: { text: '準備を進めて', title: '準備' },
      },
    ]);
    expect(kept[2]!.content).toEqual([
      {
        type: 'tool_result',
        toolCallId: 'c1',
        output: { ok: true, id: 'ses_1', title: '準備', state: 'working' },
        isError: false,
      },
    ]);
    expect(kept[3]!.content).toEqual([{ type: 'text', text: '「準備」を始めます。' }]);
    expect(kept[6]!.content).toEqual([
      {
        type: 'tool_result',
        toolCallId: 'c2',
        output: { error: { message: 'だめ' } },
        isError: true,
      },
    ]);
    // The current run: untouched.
    expect(kept[8]).toBe(history[8]);
    expect(kept[9]).toBe(history[9]);
  });

  it('the model sees two system messages (fixed role, then the status) and no tool results of earlier runs', async () => {
    const d = await daemon();
    const { sessionId } = await d.call(HUMAN, 'system.assistant', {});
    await ask(d, sessionId, '来月のローンチ準備を進めて');
    const seen: ChatRequest[] = [];
    d.ctx.service('llm').mock.define('mock/spy', (req) => {
      seen.push(req);
      return { text: '見ました。' };
    });
    await d.call(HUMAN, 'settings.update', { assistant: { model: 'mock/spy' } });
    const run = await ask(d, sessionId, '今どう？');
    expect(run.status).toBe('completed');
    const req = seen[0]!;
    const roles = req.messages.map((m) => m.role);
    expect(roles.slice(0, 2)).toEqual(['system', 'system']);
    // The result of the earlier startWork went as its digest, not the whole Session.
    const results = req.messages.filter((m) => m.role === 'tool') as { content: string }[];
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0]!.content)).toMatchObject({
      ok: true,
      title: '来月のローンチ準備を進めて',
    });
    expect(results[0]!.content).not.toContain('createdBy');
    expect((req.messages[0] as { content: string }).content).toContain('You are the assistant');
    expect((req.messages[0] as { content: string }).content).not.toContain(STATUS_HEADING);
    expect((req.messages[1] as { content: string }).content).toContain(STATUS_HEADING);
    const past = req.messages.filter((m) => m.role === 'assistant') as {
      content: string | null;
      toolCalls?: { name: string }[];
    }[];
    expect(past[0]!.toolCalls?.map((c) => c.name)).toEqual(['assistant__startWork']);
    expect(past[1]!.content).toBe(
      '「来月のローンチ準備を進めて」を始めます。終わったら知らせます。',
    );
  });
});

describe('the assistant speaks up when a tree ends or fails', () => {
  const settle = (
    d: TestDaemonNoServer,
    root: { id: string; rootSessionId: string },
    to: 'done' | 'failed',
    from = 'working',
  ) => {
    d.ctx.repos.sessions.update(root.id, (s) => ({ ...s, state: to }));
    d.ctx.bus.emit({
      type: 'session.state_changed',
      actor: HUMAN,
      payload: {
        sessionId: root.id,
        rootSessionId: root.rootSessionId,
        parentSessionId: null,
        from: from as 'working',
        to,
        stateSince: d.ctx.clock.iso(),
        now: null,
      },
    });
  };
  const until = async <T>(fn: () => T | null | undefined | false, ms = 5000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('posts a notice with the outputs and answers it in its own words; children and the assistant itself never do', async () => {
    const d = await daemon();
    const { sessionId } = await d.call(HUMAN, 'system.assistant', {});
    d.ctx.service('assistant').notifier.debounceMs = 0;
    const root = d.ctx.service('sessions').create({ kind: 'chat', title: 'ローンチ準備' }, HUMAN);
    const child = d.ctx
      .service('sessions')
      .create({ kind: 'agent', title: 'FAQ', parentSessionId: root.id }, HUMAN);
    insertDocument(d.ctx, child.id, 'FAQ（5 問）');
    settle(d, root, 'done');
    const notice = await until(() =>
      d.ctx.repos.messages
        .find({ where: { session_id: sessionId } })
        .find((m) => m.role === 'system'),
    );
    expect(notice.meta).toMatchObject({
      kind: 'wake',
      items: [
        {
          sessionId: root.id,
          title: 'ローンチ準備',
          change: 'done',
          artifactIds: [expect.stringMatching(/^art_/)],
        },
      ],
    });
    expect(notice.content[0]).toMatchObject({ type: 'text' });
    expect((notice.content[0] as { text: string }).text).toContain(
      '「ローンチ準備」が終わりました。できたもの: FAQ（5 問）',
    );
    const reply = await until(() =>
      d.ctx.repos.messages
        .find({ where: { session_id: sessionId } })
        .find((m) => m.role === 'assistant'),
    );
    expect((reply.content[0] as { text: string }).text).toBe(
      '「ローンチ準備」が終わりました。できたもの: FAQ（5 問）',
    );

    // A child settling, or the assistant itself, is nobody's news.
    settle(d, { id: child.id, rootSessionId: root.id }, 'failed');
    const me = d.ctx.repos.sessions.require(sessionId);
    settle(d, me, 'failed');
    await new Promise((r) => setTimeout(r, 50));
    expect(
      d.ctx.repos.messages
        .find({ where: { session_id: sessionId } })
        .filter((m) => m.role === 'system'),
    ).toHaveLength(1);
  });

  it('skips a root that moved on before the notice and stops at the hourly limit', async () => {
    const d = await daemon();
    await d.call(HUMAN, 'system.assistant', {});
    const n = d.ctx.service('assistant').notifier;
    const root = d.ctx.service('sessions').create({ kind: 'chat', title: '一瞬' }, HUMAN);
    d.ctx.repos.sessions.update(root.id, (s) => ({ ...s, state: 'working' }));
    expect(n.notify(root.id, 'failed')).toBeNull();
    d.ctx.repos.sessions.update(root.id, (s) => ({ ...s, state: 'failed' }));
    for (let i = 0; i < NOTICES_PER_HOUR; i++) expect(n.notify(root.id, 'failed')).not.toBeNull();
    expect(n.notify(root.id, 'failed')).toBeNull();
  });
});
