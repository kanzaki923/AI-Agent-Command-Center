import { AccClientError } from '@acc/client';
import { type HomeSnapshot, applyHomeEvent } from '@acc/protocol';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attention, card, event, homeSnapshot, homeTree, session } from '../test/fixtures';
import { createFakeClient } from '../test/fakeClient';
import { respondAttention } from './attention';
import { homeQuery } from './home';
import { qk } from './keys';
import { HOME_REFETCH_TYPES, type SessionTree, applyTreeEvent, createLiveViews, homeEvent } from './live';
import { createRuntime } from './runtime';

const root = card({ title: 'ローンチ準備', role: 'supervisor', state: 'supervising' });
const kid = card({ parentId: root.id, depth: 1, title: 'FAQ', state: 'working' });

function snap(over: Partial<HomeSnapshot> = {}): HomeSnapshot {
  return homeSnapshot({ trees: [homeTree(root, [kid], { counts: { working: 1, queued: 0, needsYou: 0, failed: 0, review: 0, done: 0, stopped: 0 } })], ...over });
}

const stateChanged = (to: 'needs_you' | 'done' | 'working', seq = 100) =>
  event(
    'session.state_changed',
    { sessionId: kid.id, rootSessionId: root.id, parentSessionId: root.id, from: 'working', to, stateSince: new Date().toISOString(), now: null },
    { seq },
  );

describe('homeEvent', () => {
  it('asks for a refetch for exactly the events applyHomeEvent does', () => {
    const s = snap();
    for (const type of HOME_REFETCH_TYPES) {
      expect(applyHomeEvent(s, { seq: 1, type, payload: {} }).refetch, type).toBe(true);
    }
  });

  it('patches a state change and ignores events it does not concern', () => {
    const s = snap();
    const out = homeEvent(s, stateChanged('done'));
    expect(out?.refetch).toBe(false);
    expect(out?.snapshot.trees[0]!.nodes[0]!.state).toBe('done');
    expect(homeEvent(s, event('tool.called', { runId: 'r', toolCallId: 't', name: 'x', input: {} }))).toBeNull();
  });

  it('refetches when a shown title changes', () => {
    const s = session({ id: kid.id, title: '新しい題' });
    expect(homeEvent(snap(), event('session.updated', { session: s, changes: ['title'] }))?.refetch).toBe(true);
    expect(homeEvent(snap(), event('session.updated', { session: s, changes: ['activeRunId'] }))).toBeNull();
  });
});

describe('applyTreeEvent', () => {
  const tree: SessionTree = { rootSessionId: root.id, nodes: [root, kid] };

  it('patches state, now, cost and attention of a node in place', () => {
    let t = applyTreeEvent(tree, stateChanged('needs_you')).tree;
    expect(t.nodes[1]!.state).toBe('needs_you');
    t = applyTreeEvent(t, event('session.now_changed', { sessionId: kid.id, rootSessionId: root.id, now: 'faq.md を編集' })).tree;
    expect(t.nodes[1]!.now).toBe('faq.md を編集');
    t = applyTreeEvent(t, event('session.cost_updated', { sessionId: kid.id, rootSessionId: root.id, ownUsd: 0.3, treeUsd: 0.3, source: 'estimated' })).tree;
    expect(t.nodes[1]!.costUsd).toBe(0.3);
    const a = attention({ id: kid.id, rootSessionId: root.id });
    t = applyTreeEvent(t, event('attention.opened', { attention: a })).tree;
    expect(t.nodes[1]!.attentionIds).toEqual([a.id]);
    t = applyTreeEvent(t, event('attention.resolved', { attention: a })).tree;
    expect(t.nodes[1]!.attentionIds).toEqual([]);
  });

  it('refetches for a new child of the tree only', () => {
    const child = session({ parentSessionId: root.id, rootSessionId: root.id });
    expect(applyTreeEvent(tree, event('session.created', { session: child })).refetch).toBe(true);
    const other = session();
    const out = applyTreeEvent(tree, event('session.created', { session: other }));
    expect(out).toEqual({ tree, refetch: false });
  });
});

describe('createLiveViews', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('patches the cached home snapshot and refetches it once, 300ms after a burst', () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
    qc.setQueryData(qk.home, snap());
    const live = createLiveViews(qc);
    live.apply(stateChanged('done', 101));
    expect(qc.getQueryData<HomeSnapshot>(qk.home)!.trees[0]!.nodes[0]!.state).toBe('done');
    for (let i = 0; i < 3; i++) live.apply(event('session.created', { session: session() }, { seq: 102 + i }));
    vi.advanceTimersByTime(299);
    expect(invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.home });
  });

  it('replays events that arrived while home.get was in flight', () => {
    const qc = new QueryClient();
    const live = createLiveViews(qc);
    live.apply(stateChanged('needs_you', 50));
    const fresh = live.settleHome(snap({ lastSeq: 40 }));
    expect(fresh.trees[0]!.nodes[0]!.state).toBe('needs_you');
    const old = live.settleHome(snap({ lastSeq: 60 }));
    expect(old.trees[0]!.nodes[0]!.state).toBe('working');
  });

  it('keeps an attention item being answered out of a refetched snapshot', () => {
    const qc = new QueryClient();
    const live = createLiveViews(qc);
    const a = attention({ id: kid.id, rootSessionId: root.id });
    live.setAnswering(a.id, true);
    expect(live.settleHome(snap({ attention: [a] })).attention).toEqual([]);
    live.setAnswering(a.id, false);
    expect(live.settleHome(snap({ attention: [a] })).attention).toEqual([a]);
  });
});

describe('respondAttention', () => {
  it('removes the item at once and keeps it gone when the daemon answers', async () => {
    const a = attention({ id: kid.id, rootSessionId: root.id }, { choices: [{ id: 'c1', label: '書く', tone: 'primary' }] });
    let sent: unknown = null;
    const fake = createFakeClient({
      'attention.respond': (p) => {
        sent = p;
        return { ...a, status: 'resolved' };
      },
    });
    const rt = createRuntime(fake.client);
    rt.queryClient.setQueryData(qk.home, snap({ attention: [a] }));
    const pending = respondAttention(rt, a, { choiceId: 'c1' });
    expect(rt.queryClient.getQueryData<HomeSnapshot>(qk.home)!.attention).toEqual([]);
    expect(rt.queryClient.getQueryData<HomeSnapshot>(qk.home)!.totals.needsYou).toBe(0);
    expect(await pending).toBe(true);
    expect(sent).toEqual({ attentionId: a.id, choiceId: 'c1' });
  });

  it('puts the item back when the answer fails', async () => {
    const a = attention({ id: kid.id, rootSessionId: root.id });
    const fake = createFakeClient({
      'attention.respond': () => {
        throw new AccClientError('conflict', 'already answered');
      },
    });
    const rt = createRuntime(fake.client);
    rt.queryClient.setQueryData(qk.home, snap({ attention: [a] }));
    expect(await respondAttention(rt, a, { text: 'はい' })).toBe(false);
    expect(rt.queryClient.getQueryData<HomeSnapshot>(qk.home)!.attention.map((x) => x.id)).toEqual([a.id]);
  });

  it('opens the settings for the daily limit’s 設定 instead of answering', async () => {
    const { useUi } = await import('../store/ui');
    useUi.setState({ settingsOpen: false });
    const a = attention({ id: kid.id }, { kind: 'budget' });
    const fake = createFakeClient({});
    const rt = createRuntime(fake.client);
    expect(await respondAttention(rt, a, { choiceId: 'open_settings' })).toBe(true);
    expect(useUi.getState().settingsOpen).toBe(true);
    expect(fake.calls).toEqual([]);
  });
});

describe('homeQuery', () => {
  it('reads home.get through the replay of live events', async () => {
    const fake = createFakeClient({ 'home.get': () => snap({ lastSeq: 10 }) });
    const rt = createRuntime(fake.client);
    rt.live.apply(stateChanged('needs_you', 11));
    const s = await rt.queryClient.fetchQuery(homeQuery(rt));
    expect(s.trees[0]!.nodes[0]!.state).toBe('needs_you');
  });
});
