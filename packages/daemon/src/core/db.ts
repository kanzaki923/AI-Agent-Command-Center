import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

/** Values accepted as SQL parameters. Booleans become 0/1, undefined becomes NULL. */
export type SqlValue = string | number | bigint | boolean | null | undefined | Uint8Array;
export type Row = Record<string, unknown>;

/**
 * Minimal synchronous DB interface. All daemon code goes through this, never through the
 * driver directly, so the driver (currently built-in `node:sqlite`) can be swapped.
 */
export interface Db {
  exec(sql: string): void;
  run(sql: string, params?: readonly SqlValue[]): { changes: number; lastInsertRowid: number };
  get<T = Row>(sql: string, params?: readonly SqlValue[]): T | undefined;
  all<T = Row>(sql: string, params?: readonly SqlValue[]): T[];
  /**
   * Run `fn` atomically. Nested calls use savepoints. Throwing rolls back (to the savepoint).
   * `fn` must be synchronous: do not await inside a transaction.
   */
  transaction<T>(fn: () => T): T;
  /** Run `fn` after the outermost transaction commits (immediately when not in one). Dropped on rollback. */
  afterCommit(fn: () => void): void;
  readonly inTransaction: boolean;
  close(): void;
}

function toSql(v: SqlValue): SQLInputValue {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export function openDb(path: string): Db {
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA synchronous = NORMAL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');
  return new SqliteDb(raw);
}

class SqliteDb implements Db {
  private readonly cache = new Map<string, StatementSync>();
  private depth = 0;
  private pendingAfterCommit: (() => void)[][] = [];
  private closed = false;

  constructor(private readonly raw: DatabaseSync) {}

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  run(sql: string, params: readonly SqlValue[] = []) {
    const r = this.stmt(sql).run(...params.map(toSql));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, params: readonly SqlValue[] = []): T | undefined {
    return this.stmt(sql).get(...params.map(toSql)) as T | undefined;
  }

  all<T = Row>(sql: string, params: readonly SqlValue[] = []): T[] {
    return this.stmt(sql).all(...params.map(toSql)) as T[];
  }

  transaction<T>(fn: () => T): T {
    const depth = this.depth;
    const sp = `sp_${depth}`;
    this.raw.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    this.pendingAfterCommit.push([]);
    let result: T;
    try {
      result = fn();
      if (result instanceof Promise) {
        throw new Error('Db.transaction callback must be synchronous');
      }
    } catch (err) {
      this.depth--;
      this.pendingAfterCommit.pop();
      this.raw.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
    this.depth--;
    const hooks = this.pendingAfterCommit.pop() ?? [];
    if (depth === 0) {
      this.raw.exec('COMMIT');
      this.runHooks(hooks);
    } else {
      this.raw.exec(`RELEASE ${sp}`);
      this.pendingAfterCommit[this.pendingAfterCommit.length - 1]?.push(...hooks);
    }
    return result;
  }

  afterCommit(fn: () => void): void {
    const top = this.pendingAfterCommit[this.pendingAfterCommit.length - 1];
    if (top) top.push(fn);
    else this.runHooks([fn]);
  }

  /** Committed hooks waiting to run, in commit order. */
  private readonly hookQueue: (() => void)[] = [];
  private draining = false;

  /**
   * Run hooks strictly in the order they were registered, even when a hook commits another
   * transaction (its hooks queue behind the remaining ones instead of running first). This
   * keeps event delivery in `seq` order: e.g. a run started inside a transaction is launched
   * by a hook, and the launch's events must not reach subscribers before the events emitted
   * later in the starting transaction.
   */
  private runHooks(hooks: (() => void)[]): void {
    this.hookQueue.push(...hooks);
    if (this.draining) return;
    this.draining = true;
    try {
      for (let h = this.hookQueue.shift(); h; h = this.hookQueue.shift()) {
        try {
          h();
        } catch (err) {
          console.error('[db] afterCommit hook failed', err);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    this.raw.close();
  }
}
