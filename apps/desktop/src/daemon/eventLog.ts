import type { Event } from '@acc/protocol';
import { createStore } from 'zustand/vanilla';

interface EventLogState {
  /** Bumped on every change; `events` is mutated in place (100k events must not be copied per push). */
  version: number;
  /** Lowest seq loaded so far (history pagination). */
  oldestSeq: number | null;
}

/** Hard cap so a week-long session does not grow without bound. */
export const EVENT_LOG_CAP = 100_000;

/**
 * Append-only, seq-ordered event log for Timeline Mode and the ログ tab. Live events come
 * from the single subscription; history is merged in from `events.list`.
 */
export function createEventLog(cap = EVENT_LOG_CAP) {
  const store = createStore<EventLogState>(() => ({ version: 0, oldestSeq: null }));
  const events: Event[] = [];
  const seen = new Set<number>();

  const bump = () =>
    store.setState((s) => ({ version: s.version + 1, oldestSeq: events[0]?.seq ?? null }));

  const trim = () => {
    if (events.length <= cap) return;
    const removed = events.splice(0, events.length - cap);
    for (const e of removed) seen.delete(e.seq);
  };

  return {
    store,
    events,
    add(e: Event) {
      if (seen.has(e.seq)) return;
      seen.add(e.seq);
      const last = events[events.length - 1];
      if (!last || last.seq < e.seq) events.push(e);
      else {
        // Rare: out-of-order (history merged after live). Insert in place.
        let i = events.length - 1;
        while (i >= 0 && events[i]!.seq > e.seq) i--;
        events.splice(i + 1, 0, e);
      }
      trim();
      bump();
    },
    addMany(list: Event[]) {
      let changed = false;
      for (const e of list) {
        if (seen.has(e.seq)) continue;
        seen.add(e.seq);
        events.push(e);
        changed = true;
      }
      if (!changed) return;
      events.sort((a, b) => a.seq - b.seq);
      trim();
      bump();
    },
  };
}

export type EventLog = ReturnType<typeof createEventLog>;
