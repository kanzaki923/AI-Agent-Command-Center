export interface BackoffOptions {
  /** First retry delay (default 250ms). */
  initialDelayMs?: number;
  /** Upper bound (default 5000ms). */
  maxDelayMs?: number;
  /** Growth per attempt (default 2). */
  factor?: number;
  /** Random +/- fraction applied to each delay (default 0.2). */
  jitter?: number;
}

/** Exponential backoff delay for `attempt` (0-based). `random` is injectable for tests. */
export function backoffDelay(
  attempt: number,
  opts: BackoffOptions = {},
  random: () => number = Math.random,
): number {
  const initial = opts.initialDelayMs ?? 250;
  const max = opts.maxDelayMs ?? 5000;
  const factor = opts.factor ?? 2;
  const jitter = opts.jitter ?? 0.2;
  const base = Math.min(max, initial * Math.pow(factor, Math.max(0, attempt)));
  const spread = base * jitter * (random() * 2 - 1);
  return Math.max(0, Math.round(Math.min(max, base + spread)));
}
