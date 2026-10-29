import type { Clock } from '../core/clock';

/**
 * At most one emission per key per `intervalMs` (spec 20261029 §2.3: `session.cost_updated`,
 * spend-driven `budget.updated`). The first change of a quiet key is emitted at once (inside
 * the caller's transaction); later changes within the interval are folded into one trailing
 * emission that reads the latest state when it fires.
 */
export class KeyedThrottle {
  private readonly last = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly trailing = new Map<string, () => void>();
  private closed = false;

  constructor(
    private readonly clock: Clock,
    private readonly intervalMs = 1000,
  ) {}

  /**
   * `now` runs immediately when the key is quiet; otherwise `later` runs once at the end of
   * the interval (the latest `later` wins).
   */
  touch(key: string, now: () => void, later: () => void): void {
    if (this.closed) return;
    const t = this.clock.now();
    const prev = this.last.get(key);
    if (prev === undefined || t - prev >= this.intervalMs || t < prev) {
      if (!this.timers.has(key)) {
        this.last.set(key, t);
        now();
        return;
      }
    }
    this.trailing.set(key, later);
    if (this.timers.has(key)) return;
    const wait = Math.max(1, this.intervalMs - (t - (prev ?? t)));
    const timer = setTimeout(() => this.fire(key), wait);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private fire(key: string): void {
    this.timers.delete(key);
    const fn = this.trailing.get(key);
    this.trailing.delete(key);
    if (!fn || this.closed) return;
    this.last.set(key, this.clock.now());
    fn();
  }

  /** Run every pending trailing emission now (tests, shutdown). */
  flush(): void {
    for (const key of [...this.timers.keys()]) {
      clearTimeout(this.timers.get(key));
      this.fire(key);
    }
  }

  close(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.trailing.clear();
    this.closed = true;
  }
}
