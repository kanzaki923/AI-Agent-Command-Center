import { createStore } from 'zustand/vanilla';

/** run.completed: highlight once, then move to the done group after this delay (§3.2). */
export const COMPLETED_LINGER_MS = 1200;
/** run.failed: the 8% → 0 background fade plays only for this long after the event. */
export const FAILED_FLASH_MS = 1500;

interface RecentState {
  /** Runs that completed a moment ago (they linger in their group and sweep once). */
  completed: Record<string, true>;
  /** Runs that failed a moment ago (one background fade). */
  failed: Record<string, true>;
}

/**
 * One-shot "it just happened" marks, set from the event stream and cleared by timers.
 * Lets rows animate a state change exactly once without a per-row clock.
 */
export function createRecentStore() {
  const store = createStore<RecentState>(() => ({ completed: {}, failed: {} }));
  const mark = (kind: keyof RecentState, runId: string, ms: number) => {
    store.setState((s) => ({ [kind]: { ...s[kind], [runId]: true } }));
    setTimeout(() => {
      store.setState((s) => {
        const next = { ...s[kind] };
        delete next[runId];
        return { [kind]: next };
      });
    }, ms);
  };
  return {
    store,
    completed: (runId: string) => mark('completed', runId, COMPLETED_LINGER_MS),
    failed: (runId: string) => mark('failed', runId, FAILED_FLASH_MS),
  };
}

export type RecentStore = ReturnType<typeof createRecentStore>;
