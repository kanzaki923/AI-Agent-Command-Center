import { createStore } from 'zustand/vanilla';

export interface ActivityEntry {
  text: string;
  /** Increments per visible change, used as the animation key. */
  rev: number;
  at: number;
}

interface ActivityState {
  byRun: Record<string, ActivityEntry>;
}

/** ui-design §10: an activity line updates at most 4 times per second. */
export const ACTIVITY_MIN_INTERVAL_MS = 250;

/**
 * "What is it doing now" per run. Fed by tool.called events and deltas; throttled per run
 * so a busy agent does not flicker. The last value inside a throttle window wins.
 */
export function createActivityStore(now: () => number = Date.now) {
  const store = createStore<ActivityState>(() => ({ byRun: {} }));
  const pending = new Map<string, string | null>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const apply = (runId: string, text: string | null) => {
    const cur = store.getState().byRun;
    const prev = cur[runId];
    if (text === null) {
      if (!prev) return;
      const next = { ...cur };
      delete next[runId];
      store.setState({ byRun: next });
      return;
    }
    if (prev?.text === text) return;
    store.setState({
      byRun: { ...cur, [runId]: { text, rev: (prev?.rev ?? 0) + 1, at: now() } },
    });
  };

  return {
    store,
    set(runId: string, text: string | null) {
      const prev = store.getState().byRun[runId];
      const elapsed = prev ? now() - prev.at : Infinity;
      if (text === null || elapsed >= ACTIVITY_MIN_INTERVAL_MS) {
        const t = timers.get(runId);
        if (t) clearTimeout(t);
        timers.delete(runId);
        pending.delete(runId);
        apply(runId, text);
        return;
      }
      pending.set(runId, text);
      if (!timers.has(runId)) {
        timers.set(
          runId,
          setTimeout(() => {
            timers.delete(runId);
            if (!pending.has(runId)) return;
            const v = pending.get(runId) ?? null;
            pending.delete(runId);
            apply(runId, v);
          }, ACTIVITY_MIN_INTERVAL_MS - elapsed),
        );
      }
    },
    get(runId: string): ActivityEntry | undefined {
      return store.getState().byRun[runId];
    },
  };
}

export type ActivityStore = ReturnType<typeof createActivityStore>;
