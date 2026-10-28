/**
 * Per-key promise queue: tasks with the same key run one after another, different keys run
 * concurrently. Used to serialize git operations that touch the same repository.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }

  /** Whether any task for `key` is running or queued. */
  busy(key: string): boolean {
    return this.tails.has(key);
  }
}
