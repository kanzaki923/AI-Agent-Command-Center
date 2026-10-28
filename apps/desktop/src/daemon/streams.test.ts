import { afterEach, describe, expect, it, vi } from 'vitest';
import { event, session } from '../test/fixtures';
import { ACTIVITY_MIN_INTERVAL_MS, createActivityStore } from './activity';
import { createDeltaStore, streamingForSession } from './deltas';
import { createEventLog } from './eventLog';

describe('delta store (rAF batching, §6.1)', () => {
  it('applies all deltas of a frame in one store update', () => {
    let pending: (() => void) | null = null;
    const store = createDeltaStore((cb) => {
      pending = cb;
    });
    const updates = vi.fn();
    store.store.subscribe(updates);
    for (let i = 0; i < 10; i++) {
      store.push({ runId: 'r', sessionId: 's', messageId: 'm', kind: 'text', text: String(i), index: i });
    }
    expect(updates).not.toHaveBeenCalled();
    pending!();
    expect(updates).toHaveBeenCalledTimes(1);
    expect(store.store.getState().byMessage.m!.text).toBe('0123456789');
  });

  it('drops duplicate or replayed indexes and separates reasoning', () => {
    const store = createDeltaStore((cb) => cb());
    store.push({ runId: 'r', sessionId: 's', messageId: 'm', kind: 'text', text: 'a', index: 0 });
    store.push({ runId: 'r', sessionId: 's', messageId: 'm', kind: 'text', text: 'a', index: 0 });
    store.push({ runId: 'r', sessionId: 's', messageId: 'm', kind: 'reasoning', text: 'think', index: 1 });
    const m = store.store.getState().byMessage.m!;
    expect(m.text).toBe('a');
    expect(m.reasoning).toBe('think');
  });

  it('marks streams joined mid-way as partial', () => {
    const store = createDeltaStore((cb) => cb());
    store.push({ runId: 'r', sessionId: 's', messageId: 'late', kind: 'text', text: 'xx', index: 7 });
    store.push({ runId: 'r', sessionId: 's', messageId: 'full', kind: 'text', text: 'yy', index: 0 });
    expect(store.store.getState().byMessage.late!.partial).toBe(true);
    expect(store.store.getState().byMessage.full!.partial).toBe(false);
  });

  it('finishes all streams of a run', () => {
    const store = createDeltaStore((cb) => cb());
    store.push({ runId: 'r1', sessionId: 's', messageId: 'a', kind: 'text', text: 'x', index: 0 });
    store.push({ runId: 'r2', sessionId: 's', messageId: 'b', kind: 'text', text: 'y', index: 0 });
    store.finishRun('r1');
    expect(streamingForSession(store.store.getState(), 's').map((m) => m.messageId)).toEqual(['b']);
  });
});

describe('activity store (max 4 updates/s per row, §10)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('throttles a burst and keeps the last value', () => {
    vi.useFakeTimers();
    let now = 1000;
    const a = createActivityStore(() => now);
    a.set('r', 'one');
    expect(a.get('r')?.text).toBe('one');
    now += 50;
    a.set('r', 'two');
    a.set('r', 'three');
    expect(a.get('r')?.text).toBe('one');
    now += ACTIVITY_MIN_INTERVAL_MS;
    vi.advanceTimersByTime(ACTIVITY_MIN_INTERVAL_MS);
    expect(a.get('r')?.text).toBe('three');
    expect(a.get('r')?.rev).toBe(2);
  });

  it('clears immediately and ignores identical text', () => {
    const a = createActivityStore(() => 0);
    a.set('r', 'x');
    const rev = a.get('r')!.rev;
    a.set('r', 'x');
    expect(a.get('r')!.rev).toBe(rev);
    a.set('r', null);
    expect(a.get('r')).toBeUndefined();
  });
});

describe('event log', () => {
  it('keeps events ordered by seq, deduplicated, and capped', () => {
    const log = createEventLog(3);
    const s = session();
    const e1 = event('session.created', { session: s });
    const e2 = event('session.archived', { sessionId: s.id, archived: true });
    const e3 = event('settings.updated', { changes: [] });
    const e4 = event('settings.updated', { changes: ['x'] });
    log.add(e3);
    log.addMany([e1, e2, e3]);
    expect(log.events.map((e) => e.seq)).toEqual([e1.seq, e2.seq, e3.seq]);
    log.add(e4);
    expect(log.events.map((e) => e.seq)).toEqual([e2.seq, e3.seq, e4.seq]);
    expect(log.store.getState().oldestSeq).toBe(e2.seq);
  });
});
