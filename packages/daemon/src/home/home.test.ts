/**
 * T7 acceptance 2-5 (spec 20261029 §5.9): home.get in one call (no N+1, fast), kept current
 * by events alone, streaming text in session.messages, and the tree methods.
 */
import {
  type Actor,
  type HomeSnapshot,
  type HomeTree,
  type Session,
  type SessionCard,
  applyHomeEvent,
} from '@acc/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonContext } from '../core/context';
import { ApiError } from '../core/errors';
import { insertRun } from '../policy/testutil';
import {
  HUMAN,
  type TestDaemonNoServer,
  agentActor,
  createTestDaemon,
  insertTestTask,
} from '../testing';
import type { SessionStateTracker } from './state';
import {
  finishHeldRun,
  holdRuns,
  insertDocument,
  insertSchedule,
  openAttention,
  recordCost,
  resolveAttention,
  startHeldRun,
} from './testutil';

const daemons: TestDaemonNoServer[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
});

async function daemon() {
  const d = await createTestDaemon();
  daemons.push(d);
  (d.ctx.service('sessionState') as unknown as SessionStateTracker).nowIntervalMs = 0;
  d.ctx.service('llm').mock.chunkDelayMs = 0;
  return d;
}

const AI = (sessionId: string) => agentActor(sessionId, 'run_00000000000000000000000000');
const SCHEDULER = { kind: 'system', component: 'scheduler' } as const;
const HOUR = 3_600_000;

function create(
  ctx: DaemonContext,
  input: { title?: string; kind?: 'chat' | 'agent'; parentSessionId?: string; scheduleId?: string },
  actor: Actor = HUMAN,
): Session {
  return ctx.service('sessions').create(
    {
      kind: input.kind ?? 'chat',
      title: input.title ?? '',
      parentSessionId: input.parentSessionId ?? null,
      scheduleId: input.scheduleId ?? null,
    },
    actor,
  );
}

/** Move a session's activity into the past (an old tree the home screen leaves out). */
function age(ctx: DaemonContext, id: string, ms: number) {
  const at = new Date(ctx.clock.now() - ms).toISOString();
  ctx.repos.sessions.update(id, (s) => ({ ...s, lastActivityAt: at, createdAt: at }));
}

/**
 * 13 sessions in 5 trees:
 * - A ローンチ準備 (supervisor, $3 budget, weekly schedule): 調査 working, FAQ asking, 告知文
 *   done with 4 documents, データ failed, two firings of the schedule (older one folded)
 * - B 質問 (chat) with a chat child an AI started
 * - C 単独 (agent, working)
 * - D 先週 (old, with a child): not listed
 * - E ピン留め (old, pinned): listed
 */
async function fixture(d: TestDaemonNoServer) {
  const { ctx } = d;
  const agentRuns = holdRuns(ctx, 'agent');
  const a = create(ctx, { title: 'ローンチ準備' });
  ctx.service('policy').createGrant(
    {
      subject: { kind: 'session', sessionId: a.id },
      permissions: ['session.spawn', 'session.tree'],
      lifetime: 'session',
    },
    HUMAN,
  );
  ctx.service('budget').createRoot({
    subject: { kind: 'session', id: a.id },
    limitUsd: 3,
    actor: HUMAN,
  });
  const research = create(ctx, { title: '調査', kind: 'agent', parentSessionId: a.id }, AI(a.id));
  const faq = create(ctx, { title: 'FAQ', kind: 'agent', parentSessionId: a.id }, AI(a.id));
  const notice = create(ctx, { title: '告知文', kind: 'agent', parentSessionId: a.id }, AI(a.id));
  const data = create(ctx, { title: 'データ', kind: 'agent', parentSessionId: a.id }, AI(a.id));
  const schedule = insertSchedule(ctx, a.id, new Date(ctx.clock.now() + 2 * HOUR).toISOString());
  const firing1 = create(
    ctx,
    { title: '週次レポート · 1', kind: 'agent', parentSessionId: a.id, scheduleId: schedule.id },
    SCHEDULER,
  );
  const firing2 = create(
    ctx,
    { title: '週次レポート · 2', kind: 'agent', parentSessionId: a.id, scheduleId: schedule.id },
    SCHEDULER,
  );
  const researchRun = await startHeldRun(ctx, research.id, 'agent', agentRuns);
  researchRun.ctl.toolCalled({
    toolCallId: 't1',
    name: 'WebSearch',
    input: { query: '競合 価格' },
  });
  const question = openAttention(
    ctx,
    faq.id,
    'question',
    '価格（月額 980 円）を FAQ に載せる？',
    20,
  );
  insertRun(ctx, { sessionId: notice.id, status: 'completed' });
  ctx.service('sessionState').recompute(notice.id);
  for (let i = 1; i <= 4; i++) {
    insertDocument(ctx, notice.id, `告知文 v${i}`, new Date(ctx.clock.now() + i).toISOString());
  }
  const failure = openAttention(ctx, data.id, 'failure', 'データの集計に失敗', 30);
  insertRun(ctx, { sessionId: firing1.id, status: 'completed' });
  ctx.service('sessionState').recompute(firing1.id);
  insertTestTask(ctx, { projectId: null, status: 'pending', assigneeSessionId: firing2.id });
  ctx.service('sessionState').recompute(firing2.id);
  recordCost(ctx, research.id, 0.5);
  recordCost(ctx, notice.id, 0.75);

  const b = create(ctx, { title: '質問' });
  const bChild = create(ctx, { title: '下調べ', parentSessionId: b.id }, AI(b.id));

  const c = create(ctx, { title: '単独', kind: 'agent' });
  const cRun = await startHeldRun(ctx, c.id, 'agent', agentRuns);

  const old = create(ctx, { title: '先週' });
  const oldChild = create(ctx, { title: '先週の子', parentSessionId: old.id });
  age(ctx, old.id, 48 * HOUR);
  age(ctx, oldChild.id, 48 * HOUR);

  const pinned = create(ctx, { title: 'ピン留め' });
  ctx.repos.sessions.update(pinned.id, (s) => ({ ...s, pinned: true }));
  age(ctx, pinned.id, 72 * HOUR);

  return {
    agentRuns,
    a,
    research,
    researchRun,
    faq,
    notice,
    data,
    schedule,
    firing1,
    firing2,
    question,
    failure,
    b,
    bChild,
    c,
    cRun,
    old,
    pinned,
  };
}

const home = (d: TestDaemonNoServer) => d.call(HUMAN, 'home.get', {});
const byTitle = (t: HomeTree) =>
  Object.fromEntries([t.root, ...t.nodes].map((n) => [n.title, n] as const));

describe('home.get (acceptance 2)', () => {
  it('has every tree with its children, state, now, spend, attention and schedule', async () => {
    const d = await daemon();
    const f = await fixture(d);
    expect(d.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')!.n).toBe(13);
    const snap = await home(d);

    expect(snap.trees.map((t) => t.root.title)).toEqual([
      'ローンチ準備',
      '単独',
      'ピン留め',
      '質問',
    ]);
    expect(snap.totals).toMatchObject({
      working: 2,
      needsYou: 2,
      failed: 1,
      dailyLimitUsd: 20,
      estimated: true,
    });
    expect(snap.totals.spendTodayUsd).toBe(1.25);
    expect(snap.attention.map((x) => x.id)).toEqual([f.question.id, f.failure.id]);
    expect(snap.upcoming).toEqual([
      {
        scheduleId: f.schedule.id,
        sessionId: f.a.id,
        title: '週次レポート',
        at: f.schedule.nextRunAt,
      },
    ]);
    expect(snap.lastSeq).toBe(d.ctx.bus.lastSeq());

    const a = snap.trees[0]!;
    const cards = byTitle(a);
    expect(a.root).toMatchObject({
      role: 'supervisor',
      depth: 0,
      parentId: null,
      state: 'supervising',
    });
    expect(a.nodes.map((n) => [n.title, n.state, n.depth])).toEqual([
      ['調査', 'working', 1],
      ['FAQ', 'needs_you', 1],
      ['告知文', 'done', 1],
      ['データ', 'failed', 1],
      ['週次レポート · 2', 'queued', 1],
    ]);
    expect(a.hiddenNodes).toBe(1);
    expect(cards['調査']).toMatchObject({
      now: '「競合 価格」を検索',
      costUsd: 0.5,
      role: 'agent',
      startedBy: 'ai',
      parentId: f.a.id,
    });
    expect(cards['調査']!.stateSince).not.toBeNull();
    expect(cards['FAQ']!.attentionIds).toEqual([f.question.id]);
    expect(cards['データ']!.attentionIds).toEqual([f.failure.id]);
    expect(cards['告知文']!.outputs.map((o) => [o.kind, o.title])).toEqual([
      ['document', '告知文 v4'],
      ['document', '告知文 v3'],
      ['document', '告知文 v2'],
    ]);
    expect(cards['週次レポート · 2']).toMatchObject({
      startedBy: 'schedule',
      scheduleId: f.schedule.id,
    });
    expect(a.counts).toEqual({
      working: 1,
      queued: 1,
      needsYou: 1,
      failed: 1,
      review: 0,
      done: 2,
      stopped: 0,
    });
    expect(a.spend).toEqual({ treeUsd: 1.25, limitUsd: 3, estimated: true });
    expect(a.nextRunAt).toBe(f.schedule.nextRunAt);
    expect(a.root.budget).toEqual({ limitUsd: 3, usedUsd: 0 });

    const b = snap.trees.find((t) => t.root.id === f.b.id)!;
    expect(b.nodes).toMatchObject([{ title: '下調べ', role: 'chat', startedBy: 'ai', depth: 1 }]);
    expect(b.root).toMatchObject({ role: 'chat', startedBy: 'human', budget: null, now: null });
    expect(snap.trees.find((t) => t.root.id === f.c.id)!.root).toMatchObject({
      state: 'working',
      now: '準備中',
    });
  });

  it('cuts big trees at maxNodesPerTree and counts the rest', async () => {
    const d = await daemon();
    const root = create(d.ctx, { title: '大きな木' });
    for (let i = 0; i < 6; i++) create(d.ctx, { title: `子 ${i}`, parentSessionId: root.id });
    const snap = await d.call(HUMAN, 'home.get', { maxNodesPerTree: 4 });
    expect(snap.trees[0]!.nodes.map((n) => n.title)).toEqual(['子 0', '子 1', '子 2', '子 3']);
    expect(snap.trees[0]!.hiddenNodes).toBe(2);
    const recent = await d.call(HUMAN, 'home.get', { doneWithinHours: 0 });
    expect(recent.trees).toEqual([]);
  });

  it('reads a fixed number of queries whatever the number of trees, within 50ms', async () => {
    const d = await daemon();
    await fixture(d);
    const count = async () => {
      const all = vi.spyOn(d.ctx.db, 'all');
      const get = vi.spyOn(d.ctx.db, 'get');
      await home(d);
      const n = all.mock.calls.length + get.mock.calls.length;
      all.mockRestore();
      get.mockRestore();
      return n;
    };
    const before = await count();
    for (let i = 0; i < 8; i++) {
      const root = create(d.ctx, { title: `木 ${i}` });
      const child = create(d.ctx, { title: `子 ${i}`, kind: 'agent', parentSessionId: root.id });
      openAttention(d.ctx, child.id, 'question', `質問 ${i}`);
      insertDocument(d.ctx, child.id, `成果物 ${i}`);
      d.ctx.service('budget').createRoot({
        subject: { kind: 'session', id: root.id },
        limitUsd: 1,
        actor: HUMAN,
      });
    }
    const after = await count();
    expect((await home(d)).trees).toHaveLength(12);
    expect(after).toBe(before);

    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      await home(d);
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    expect(times[3]!).toBeLessThan(50);
  });
});

/** Fields events keep current (lastActivityAt and outputs need a new home.get). */
function live(snap: HomeSnapshot) {
  const card = (c: SessionCard) => ({
    id: c.id,
    state: c.state,
    stateSince: c.stateSince,
    now: c.now,
    costUsd: c.costUsd,
    attentionIds: c.attentionIds,
  });
  return {
    totals: snap.totals,
    attention: snap.attention.map((a) => a.id),
    trees: Object.fromEntries(
      snap.trees.map((t) => [
        t.root.id,
        {
          root: card(t.root),
          nodes: t.nodes.map(card),
          counts: t.counts,
          spend: t.spend,
        },
      ]),
    ),
  };
}

describe('events keep a snapshot current (acceptance 3)', () => {
  it('state, now, cost and attention events reproduce a fresh home.get', async () => {
    const d = await daemon();
    const f = await fixture(d);
    const chatRuns = holdRuns(d.ctx, 'chat');
    const before = await home(d);

    // Work happens: a chat child starts, an agent finishes, spend, a question is answered,
    // a new item opens.
    const chat = await startHeldRun(d.ctx, f.bChild.id, 'chat', chatRuns);
    chat.ctl.toolCalled({ toolCallId: 'x', name: 'session.tree', input: {} });
    recordCost(d.ctx, f.bChild.id, 0.25);
    recordCost(d.ctx, f.research.id, 0.125);
    resolveAttention(d.ctx, f.question.id);
    openAttention(d.ctx, f.c.id, 'approval', 'pnpm add zod を実行', 5);
    await finishHeldRun(d.ctx, f.agentRuns, f.researchRun.run.id);

    let snap = before;
    const { events } = d.ctx.bus.list({ since: before.lastSeq, limit: 5000 });
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'session.state_changed',
        'session.now_changed',
        'session.cost_updated',
        'attention.opened',
        'attention.resolved',
      ]),
    );
    for (const e of events) {
      const r = applyHomeEvent(snap, e);
      expect(r.refetch, e.type).toBe(false);
      snap = r.snapshot;
    }
    const fresh = await home(d);
    expect(snap.lastSeq).toBe(fresh.lastSeq);
    expect(live(snap)).toEqual(live(fresh));
    expect(byTitle(fresh.trees.find((t) => t.root.id === f.b.id)!)['下調べ']).toMatchObject({
      state: 'working',
      now: '状況を確認',
    });
  });

  it('asks for a refetch on structural changes', async () => {
    const d = await daemon();
    const before = await home(d);
    create(d.ctx, { title: '新しい会話' });
    const { events } = d.ctx.bus.list({ since: before.lastSeq });
    expect(events.some((e) => applyHomeEvent(before, e).refetch)).toBe(true);
  });
});

describe('session.messages streaming (acceptance 4)', () => {
  it('returns the text being written mid-stream, and nothing once it is a message', async () => {
    const d = await daemon();
    d.ctx.service('llm').mock.chunkDelayMs = 15;
    const s = await d.call(HUMAN, 'session.create', { model: 'mock/echo' });
    const firstDelta = new Promise<void>((resolve) => {
      const off = d.ctx.bus.subscribeDeltas({ sessionId: s.id }, (delta) => {
        if (delta.kind === 'text' && delta.index >= 3) {
          off();
          resolve();
        }
      });
    });
    const sent = await d.call(HUMAN, 'session.send', {
      sessionId: s.id,
      content: '途中で開いても書きかけの本文が見えるか確かめる長めのメッセージです',
    });
    await firstDelta;
    const mid = await d.call(HUMAN, 'session.messages', { sessionId: s.id });
    expect(mid.streaming).not.toBeNull();
    expect(mid.streaming!.runId).toBe(sent.runId);
    expect(mid.streaming!.text.length).toBeGreaterThan(0);
    expect('エコー: 途中で開いても書きかけの本文が見えるか').toContain(
      mid.streaming!.text.slice(0, 10),
    );
    expect(d.ctx.repos.sessions.require(s.id)).toMatchObject({
      state: 'working',
      now: '回答を作成中',
    });

    await d.ctx.service('runs').waitForEnd(sent.runId!);
    const after = await d.call(HUMAN, 'session.messages', { sessionId: s.id });
    expect(after.streaming).toBeNull();
    const reply = after.items.at(-1)!;
    expect(reply.role).toBe('assistant');
    expect(reply.id).toBe(mid.streaming!.messageId);
    expect(reply.content[0]).toMatchObject({ text: expect.stringContaining(mid.streaming!.text) });
    expect(d.ctx.repos.sessions.require(s.id)).toMatchObject({ state: 'idle', now: null });
  });
});

describe('session tree methods (acceptance 5)', () => {
  async function tree(d: TestDaemonNoServer) {
    const root = await d.call(HUMAN, 'session.create', { title: 'root' });
    const child = await d.call(HUMAN, 'session.create', {
      title: 'child',
      kind: 'agent',
      parentSessionId: root.id,
    });
    const grandchild = await d.call(HUMAN, 'session.create', {
      title: 'grandchild',
      parentSessionId: child.id,
    });
    const sibling = await d.call(HUMAN, 'session.create', {
      title: 'sibling',
      parentSessionId: root.id,
    });
    const other = await d.call(HUMAN, 'session.create', { title: 'other' });
    return { root, child, grandchild, sibling, other };
  }

  it('session.list walks the tree', async () => {
    const d = await daemon();
    const t = await tree(d);
    const roots = await d.call(HUMAN, 'session.list', { rootsOnly: true });
    expect(roots.items.map((s) => s.title).sort()).toEqual(['other', 'root']);
    const kids = await d.call(HUMAN, 'session.list', { parentSessionId: t.root.id });
    expect(kids.items.map((s) => s.title).sort()).toEqual(['child', 'sibling']);
    const nullParent = await d.call(HUMAN, 'session.list', { parentSessionId: null });
    expect(nullParent.items).toHaveLength(2);
  });

  it('session.tree returns the whole tree depth first from any of its sessions', async () => {
    const d = await daemon();
    const t = await tree(d);
    for (const from of [t.root, t.grandchild]) {
      const r = await d.call(HUMAN, 'session.tree', { sessionId: from.id });
      expect(r.rootSessionId).toBe(t.root.id);
      expect(r.nodes.map((n) => [n.title, n.depth, n.parentId])).toEqual([
        ['root', 0, null],
        ['child', 1, t.root.id],
        ['grandchild', 2, t.child.id],
        ['sibling', 1, t.root.id],
      ]);
    }
    await d.call(HUMAN, 'session.archive', { sessionId: t.sibling.id });
    const r = await d.call(HUMAN, 'session.tree', { sessionId: t.root.id });
    expect(r.nodes.map((n) => n.title)).toEqual(['root', 'child', 'grandchild']);
  });

  it('an agent sees and lists only its own subtree', async () => {
    const d = await daemon();
    const t = await tree(d);
    d.ctx.service('policy').createGrant(
      {
        subject: { kind: 'session', sessionId: t.child.id },
        permissions: ['session.tree', 'session.list'],
        lifetime: 'session',
      },
      HUMAN,
    );
    const agent = agentActor(t.child.id, d.ctx.ids.next('run'));
    const r = await d.call(agent, 'session.tree', { sessionId: t.grandchild.id });
    expect(r.rootSessionId).toBe(t.child.id);
    expect(r.nodes.map((n) => [n.title, n.depth])).toEqual([
      ['child', 0],
      ['grandchild', 1],
    ]);
    const err = await d
      .call(agent, 'session.tree', { sessionId: t.sibling.id })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('forbidden');
    const listed = await d.call(agent, 'session.list', {});
    expect(listed.items.map((s) => s.title).sort()).toEqual(['child', 'grandchild']);
  });
});
