import { describe, expect, it } from 'vitest';
import { type HomeSnapshot, type SessionCard, applyHomeEvent } from './home';

const T0 = '2026-10-29T00:00:00.000Z';

function card(id: string, over: Partial<SessionCard> = {}): SessionCard {
  return {
    id,
    parentId: null,
    depth: 0,
    title: id,
    role: 'chat',
    state: 'idle',
    stateSince: null,
    now: null,
    costUsd: 0,
    budget: null,
    outputs: [],
    attentionIds: [],
    startedBy: 'human',
    scheduleId: null,
    lastActivityAt: T0,
    ...over,
  };
}

function snapshot(): HomeSnapshot {
  return {
    now: T0,
    lastSeq: 10,
    totals: {
      working: 1,
      needsYou: 0,
      failed: 0,
      spendTodayUsd: 1,
      dailyLimitUsd: 20,
      estimated: false,
    },
    attention: [],
    trees: [
      {
        root: card('ses_root', { state: 'supervising' }),
        nodes: [card('ses_kid', { parentId: 'ses_root', depth: 1, state: 'working' })],
        hiddenNodes: 1,
        counts: { working: 1, queued: 1, needsYou: 0, failed: 0, review: 0, done: 0, stopped: 0 },
        spend: { treeUsd: 1, limitUsd: null, estimated: false },
        nextRunAt: null,
        projectId: null,
      },
    ],
    upcoming: [],
  };
}

const changed = (
  seq: number,
  sessionId: string,
  from: string,
  to: string,
  rootSessionId = 'ses_root',
) => ({
  seq,
  type: 'session.state_changed',
  payload: { sessionId, rootSessionId, parentSessionId: null, from, to, stateSince: T0, now: null },
});

describe('applyHomeEvent', () => {
  it('ignores events the snapshot already includes and does not mutate its input', () => {
    const s = snapshot();
    expect(applyHomeEvent(s, changed(10, 'ses_kid', 'working', 'done')).snapshot).toBe(s);
    const r = applyHomeEvent(s, changed(11, 'ses_kid', 'working', 'done'));
    expect(r.snapshot.lastSeq).toBe(11);
    expect(s.trees[0]!.nodes[0]!.state).toBe('working');
  });

  it('moves counts and totals by state, including hidden nodes', () => {
    let s = applyHomeEvent(snapshot(), changed(11, 'ses_kid', 'working', 'failed')).snapshot;
    expect(s.trees[0]!.counts).toMatchObject({ working: 0, failed: 1 });
    expect(s.totals).toMatchObject({ working: 0, failed: 1 });
    expect(s.trees[0]!.nodes[0]!.state).toBe('failed');
    // A node cut from the snapshot still moves the tree's counts.
    s = applyHomeEvent(s, changed(12, 'ses_hidden', 'queued', 'working')).snapshot;
    expect(s.trees[0]!.counts).toMatchObject({ working: 1, queued: 0 });
    // supervising / idle are not counted.
    s = applyHomeEvent(s, changed(13, 'ses_root', 'supervising', 'idle')).snapshot;
    expect(s.trees[0]!.counts).toMatchObject({ working: 1, queued: 0, failed: 1 });
  });

  it('patches now and cost; spend follows the root', () => {
    let s = applyHomeEvent(snapshot(), {
      seq: 11,
      type: 'session.now_changed',
      payload: { sessionId: 'ses_kid', rootSessionId: 'ses_root', now: 'faq.md を編集' },
    }).snapshot;
    expect(s.trees[0]!.nodes[0]!.now).toBe('faq.md を編集');
    s = applyHomeEvent(s, {
      seq: 12,
      type: 'session.cost_updated',
      payload: {
        sessionId: 'ses_root',
        rootSessionId: 'ses_root',
        ownUsd: 0,
        treeUsd: 1.5,
        source: 'estimated',
      },
    }).snapshot;
    expect(s.trees[0]!.spend).toEqual({ treeUsd: 1.5, limitUsd: null, estimated: true });
    expect(s.totals).toMatchObject({ spendTodayUsd: 1.5, estimated: true });
  });

  it('keeps attention in priority order on the list and the card', () => {
    const item = (id: string, priority: number) => ({
      id,
      kind: 'question',
      status: 'open',
      sessionId: 'ses_kid',
      rootSessionId: 'ses_root',
      title: id,
      detail: null,
      choices: [],
      allowText: true,
      priority,
      refs: {},
      resolution: null,
      createdAt: T0,
      resolvedAt: null,
    });
    let s = snapshot();
    s = applyHomeEvent(s, {
      seq: 11,
      type: 'attention.opened',
      payload: { attention: item('atn_b', 20) },
    }).snapshot;
    s = applyHomeEvent(s, {
      seq: 12,
      type: 'attention.opened',
      payload: { attention: item('atn_a', 5) },
    }).snapshot;
    expect(s.attention.map((a) => a.id)).toEqual(['atn_a', 'atn_b']);
    expect(s.trees[0]!.nodes[0]!.attentionIds).toEqual(['atn_a', 'atn_b']);
    expect(s.totals.needsYou).toBe(2);
    s = applyHomeEvent(s, {
      seq: 13,
      type: 'attention.resolved',
      payload: { attention: item('atn_a', 5) },
    }).snapshot;
    expect(s.attention.map((a) => a.id)).toEqual(['atn_b']);
    expect(s.trees[0]!.nodes[0]!.attentionIds).toEqual(['atn_b']);
    expect(s.totals.needsYou).toBe(1);
  });

  it('asks for a refetch for trees it does not have and structural changes', () => {
    expect(
      applyHomeEvent(snapshot(), changed(11, 'ses_x', 'idle', 'working', 'ses_other')).refetch,
    ).toBe(true);
    expect(
      applyHomeEvent(snapshot(), { seq: 11, type: 'session.created', payload: {} }).refetch,
    ).toBe(true);
    expect(
      applyHomeEvent(snapshot(), { seq: 11, type: 'schedule.fired', payload: {} }).refetch,
    ).toBe(true);
    expect(applyHomeEvent(snapshot(), { seq: 11, type: 'tool.called', payload: {} }).refetch).toBe(
      false,
    );
  });
});
