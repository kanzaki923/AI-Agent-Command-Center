import { useSyncExternalStore } from 'react';

/**
 * Shared tickers for the whole app (ui-design §10: no per-row setInterval): one 1-second
 * ticker for things that are working right now, one 30-second ticker for "12分前"-style
 * times. An interval only runs while something is subscribed to it.
 */
function createTicker(everyMs: number) {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let now = Date.now();
  return {
    listeners,
    subscribe: (fn: () => void): (() => void) => {
      listeners.add(fn);
      if (!timer) {
        now = Date.now();
        timer = setInterval(() => {
          now = Date.now();
          for (const l of listeners) l();
        }, everyMs);
      }
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    // While nothing ticks, a first reader gets the current time (not the time the last
    // ticker stopped); two reads in a row still agree, as useSyncExternalStore requires.
    snapshot: () => {
      if (!timer && Date.now() - now >= 1000) now = Date.now();
      return now;
    },
  };
}

const second = createTicker(1000);
const slow = createTicker(30_000);

/** Current time in ms, re-rendering once per second. */
export function useNow(): number {
  return useSyncExternalStore(second.subscribe, second.snapshot, second.snapshot);
}

/** Current time in ms, re-rendering every 30 seconds (relative times of settled things). */
export function useSlowNow(): number {
  return useSyncExternalStore(slow.subscribe, slow.snapshot, slow.snapshot);
}

/** Test hook: number of active subscribers of the 1-second ticker. */
export function tickerSubscriberCount(): number {
  return second.listeners.size;
}
