import { useSyncExternalStore } from 'react';

/**
 * One shared 1-second ticker for the whole app (ui-design §10: no per-row setInterval).
 * The interval only runs while something is subscribed.
 */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = Date.now();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const snapshot = () => now;

/** Current time in ms, re-rendering once per second. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Test hook: number of active subscribers (there must be one interval regardless). */
export function tickerSubscriberCount(): number {
  return listeners.size;
}
