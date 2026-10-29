import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { createFakeClient } from '../test/fakeClient';
import { event, id, message, session } from '../test/fixtures';
import { createActivityStore } from './activity';
import { createDeltaStore, mergeOverlap, streamingForSession } from './deltas';
import { createEventLog } from './eventLog';
import { qk } from './keys';
import { messagesQuery } from './queries';
import { createRecentStore } from './recent';
import { createRuntime } from './runtime';
import { type ChatMessage, applyEvent } from './sync';

const now = (cb: () => void) => cb();

describe('a chat opened mid-answer (session.messages streaming)', () => {
  it('shows what was already written at once, then keeps streaming after it', async () => {
    const s = session({ kind: 'chat' });
    const runId = id('run');
    const messageId = id('msg');
    const fake = createFakeClient({
      'session.messages': () => ({
        items: [],
        hasMore: false,
        streaming: { messageId, runId, text: 'リモートワークを 1 年', reasoning: '' },
      }),
    });
    const rt = createRuntime(fake.client);
    await rt.queryClient.fetchQuery(messagesQuery(rt, s.id));
    const deltas = rt.streams.deltas;
    expect(streamingForSession(deltas.store.getState(), s.id)).toEqual([
      expect.objectContaining({ messageId, text: 'リモートワークを 1 年', partial: false }),
    ]);
    deltas.push({ runId, sessionId: s.id, messageId, kind: 'text', text: '続けて', index: 42 });
    deltas.flush();
    expect(streamingForSession(deltas.store.getState(), s.id)[0]!.text).toBe('リモートワークを 1 年続けて');
  });

  it('merges deltas that arrived before the snapshot without doubling them', () => {
    const deltas = createDeltaStore(now);
    const s = session();
    const runId = id('run');
    const messageId = id('msg');
    // Joined mid-stream: only the tail was received.
    deltas.push({ runId, sessionId: s.id, messageId, kind: 'text', text: '1 年続けて気づいた', index: 7 });
    deltas.seed(s.id, { messageId, runId, text: 'リモートワークを 1 年続けて', reasoning: '' });
    expect(streamingForSession(deltas.store.getState(), s.id)[0]!.text).toBe('リモートワークを 1 年続けて気づいた');
  });

  it('leaves a stream followed from its start alone, and skips a saved answer', async () => {
    const deltas = createDeltaStore(now);
    const s = session();
    const runId = id('run');
    const messageId = id('msg');
    deltas.push({ runId, sessionId: s.id, messageId, kind: 'text', text: 'ぜんぶ', index: 0 });
    deltas.seed(s.id, { messageId, runId, text: 'ぜ', reasoning: '' });
    expect(streamingForSession(deltas.store.getState(), s.id)[0]!.text).toBe('ぜんぶ');

    const saved = message(s, { id: messageId, role: 'assistant', runId });
    const fake = createFakeClient({
      'session.messages': () => ({ items: [saved], hasMore: false, streaming: { messageId, runId, text: 'x', reasoning: '' } }),
    });
    const rt = createRuntime(fake.client);
    await rt.queryClient.fetchQuery(messagesQuery(rt, s.id));
    expect(streamingForSession(rt.streams.deltas.store.getState(), s.id)).toEqual([]);
  });

  it('counts a short chance match as no overlap', () => {
    expect(mergeOverlap('です。', '。次に')).toBe('です。。次に');
    expect(mergeOverlap('abcdefghi', 'defghijk')).toBe('abcdefghijk');
    expect(mergeOverlap('abc', 'bc')).toBe('abc');
  });
});

describe('message.updated', () => {
  it('turns a queued message into a delivered one in the chat', () => {
    const qc = new QueryClient();
    const streams = { deltas: createDeltaStore(now), activity: createActivityStore(), events: createEventLog(), recent: createRecentStore() };
    const s = session();
    const m = message(s, { delivery: 'queued' });
    qc.setQueryData<ChatMessage[]>(qk.messages(s.id), [m]);
    applyEvent(qc, streams, event('message.updated', { message: { ...m, delivery: 'delivered' }, changes: ['delivery'] }));
    expect(qc.getQueryData<ChatMessage[]>(qk.messages(s.id))![0]!.delivery).toBe('delivered');
  });

  it('keeps the session list’s state, now and spend current', () => {
    const qc = new QueryClient();
    const streams = { deltas: createDeltaStore(now), activity: createActivityStore(), events: createEventLog(), recent: createRecentStore() };
    const s = session();
    qc.setQueryData(qk.sessions, [s]);
    applyEvent(qc, streams, event('session.state_changed', { sessionId: s.id, rootSessionId: s.id, parentSessionId: null, from: 'idle', to: 'working', stateSince: s.createdAt, now: '準備中' }));
    applyEvent(qc, streams, event('session.cost_updated', { sessionId: s.id, rootSessionId: s.id, ownUsd: 0.2, treeUsd: 0.5, source: 'estimated' }));
    expect(qc.getQueryData<typeof s[]>(qk.sessions)![0]).toMatchObject({ state: 'working', now: '準備中', cost: { ownUsd: 0.2, treeUsd: 0.5 } });
  });
});
