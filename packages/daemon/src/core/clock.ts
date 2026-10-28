/** Injectable time source. Tests use `createManualClock`. */
export interface Clock {
  /** Milliseconds since epoch. */
  now(): number;
  /** ISO-8601 UTC timestamp with milliseconds. */
  iso(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
};

export interface ManualClock extends Clock {
  set(ms: number | Date): void;
  advance(ms: number): void;
}

export function createManualClock(start: number | Date = Date.UTC(2026, 0, 1)): ManualClock {
  let t = typeof start === 'number' ? start : start.getTime();
  return {
    now: () => t,
    iso: () => new Date(t).toISOString(),
    set: (ms) => {
      t = typeof ms === 'number' ? ms : ms.getTime();
    },
    advance: (ms) => {
      t += ms;
    },
  };
}
