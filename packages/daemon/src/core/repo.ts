import type { z } from 'zod';
import type { Db, SqlValue } from './db';
import { invalidParams, notFound } from './errors';

/** Column value condition: `=` for scalars, `IN` for arrays, `IS NULL` for null, `{ not: null }` for IS NOT NULL. */
export type WhereValue = SqlValue | readonly SqlValue[] | { not: null };
export type Where = Record<string, WhereValue>;

export interface FindQuery {
  where?: Where;
  /** Extra raw SQL condition with positional params (column names must be literal). */
  sql?: { clause: string; params?: readonly SqlValue[] };
  /** Sort column (must be an indexed column or "id"). Ties break on id. Default: id. */
  orderBy?: string;
  /** Default: desc (newest first, since ids sort by creation time). */
  direction?: 'asc' | 'desc';
  limit?: number;
}

export interface PageQuery extends FindQuery {
  limit: number;
  cursor?: string | undefined;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface EntityTableDef<T, I = T> {
  table: string;
  /** Human-readable kind used in not_found errors, e.g. "session". */
  kind: string;
  /** Validates on write and read; `I` is what callers may insert (defaults optional). */
  schema: z.ZodType<T, I>;
  /** Indexed columns (besides `id` and `data`) and how to derive them from the entity. */
  columns: Record<string, (entity: T) => SqlValue>;
}

/**
 * Generic repository over an entity table (indexed columns + JSON `data`).
 * Entities are validated with zod on write and on read (so defaults added to schemas later
 * apply to old rows).
 */
export class EntityRepo<T extends { id: string }, I extends { id: string } = T> {
  private readonly columnNames: string[];
  private readonly insertSql: string;
  private readonly updateSql: string;

  constructor(
    private readonly db: Db,
    readonly def: EntityTableDef<T, I>,
  ) {
    this.columnNames = Object.keys(def.columns);
    const cols = ['id', ...this.columnNames, 'data'];
    this.insertSql = `INSERT INTO ${def.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    this.updateSql = `UPDATE ${def.table} SET ${[...this.columnNames, 'data'].map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
  }

  private parse(data: string): T {
    return this.def.schema.parse(JSON.parse(data));
  }

  private values(entity: T): SqlValue[] {
    return this.columnNames.map((c) => this.def.columns[c]!(entity));
  }

  private assertColumn(name: string): void {
    if (name !== 'id' && !this.columnNames.includes(name)) {
      throw new Error(`Unknown column "${name}" for table ${this.def.table}`);
    }
  }

  get(id: string): T | undefined {
    const row = this.db.get<{ data: string }>(`SELECT data FROM ${this.def.table} WHERE id = ?`, [
      id,
    ]);
    return row ? this.parse(row.data) : undefined;
  }

  /** Like get() but throws ApiError not_found. */
  require(id: string): T {
    const e = this.get(id);
    if (!e) throw notFound(this.def.kind, id);
    return e;
  }

  /** Insert (fields with schema defaults may be omitted). Returns the parsed entity. */
  insert(entity: I): T {
    const valid = this.def.schema.parse(entity);
    this.db.run(this.insertSql, [valid.id, ...this.values(valid), JSON.stringify(valid)]);
    return valid;
  }

  /** Read-modify-write inside a transaction. `fn` receives the current entity. */
  update(id: string, fn: (current: T) => T): T {
    return this.db.transaction(() => {
      const current = this.require(id);
      const next = this.def.schema.parse(fn(current));
      if (next.id !== id) throw new Error('update() must not change the id');
      this.db.run(this.updateSql, [...this.values(next), JSON.stringify(next), id]);
      return next;
    });
  }

  delete(id: string): boolean {
    return this.db.run(`DELETE FROM ${this.def.table} WHERE id = ?`, [id]).changes > 0;
  }

  private buildWhere(q: FindQuery): { clauses: string[]; params: SqlValue[] } {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    for (const [col, v] of Object.entries(q.where ?? {})) {
      if (v === undefined) continue;
      this.assertColumn(col);
      if (v === null) {
        clauses.push(`${col} IS NULL`);
      } else if (Array.isArray(v)) {
        if (v.length === 0) {
          clauses.push('0');
        } else {
          clauses.push(`${col} IN (${v.map(() => '?').join(', ')})`);
          params.push(...(v as SqlValue[]));
        }
      } else if (typeof v === 'object' && v !== null && 'not' in v) {
        clauses.push(`${col} IS NOT NULL`);
      } else {
        clauses.push(`${col} = ?`);
        params.push(v as SqlValue);
      }
    }
    if (q.sql) {
      clauses.push(`(${q.sql.clause})`);
      params.push(...(q.sql.params ?? []));
    }
    return { clauses, params };
  }

  find(q: FindQuery = {}): T[] {
    const orderBy = q.orderBy ?? 'id';
    this.assertColumn(orderBy);
    const dir = q.direction === 'asc' ? 'ASC' : 'DESC';
    const { clauses, params } = this.buildWhere(q);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const order = orderBy === 'id' ? `id ${dir}` : `${orderBy} ${dir}, id ${dir}`;
    const limit = q.limit !== undefined ? `LIMIT ${Math.max(0, Math.floor(q.limit))}` : '';
    return this.db
      .all<{ data: string }>(
        `SELECT data FROM ${this.def.table} ${where} ORDER BY ${order} ${limit}`,
        params,
      )
      .map((r) => this.parse(r.data));
  }

  findOne(q: Omit<FindQuery, 'limit'>): T | undefined {
    return this.find({ ...q, limit: 1 })[0];
  }

  count(q: Pick<FindQuery, 'where' | 'sql'> = {}): number {
    const { clauses, params } = this.buildWhere(q);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${this.def.table} ${where}`,
      params,
    )!.n;
  }

  /** Keyset pagination on (orderBy, id). Cursors are opaque to clients. */
  page(q: PageQuery): Page<T> {
    const orderBy = q.orderBy ?? 'id';
    this.assertColumn(orderBy);
    const desc = q.direction !== 'asc';
    const op = desc ? '<' : '>';
    let sql = q.sql;
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      const cursorClause =
        orderBy === 'id'
          ? { clause: `id ${op} ?`, params: [c.id] }
          : {
              clause: `(${orderBy} ${op} ? OR (${orderBy} = ? AND id ${op} ?))`,
              params: [c.value, c.value, c.id],
            };
      sql = sql
        ? {
            clause: `(${sql.clause}) AND ${cursorClause.clause}`,
            params: [...(sql.params ?? []), ...cursorClause.params],
          }
        : cursorClause;
    }
    const rows = this.find({ ...q, ...(sql ? { sql } : {}), limit: q.limit + 1 });
    const items = rows.slice(0, q.limit);
    const last = items[items.length - 1];
    const nextCursor =
      rows.length > q.limit && last
        ? encodeCursor({
            id: last.id,
            value: orderBy === 'id' ? last.id : this.def.columns[orderBy]!(last),
          })
        : null;
    return { items, nextCursor };
  }
}

interface CursorData {
  id: string;
  value: SqlValue;
}

function encodeCursor(c: CursorData): string {
  return Buffer.from(JSON.stringify([c.value, c.id])).toString('base64url');
}

function decodeCursor(s: string): CursorData {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[1] === 'string') {
      return { value: parsed[0] as SqlValue, id: parsed[1] };
    }
  } catch {
    // fall through
  }
  throw invalidParams('Invalid cursor');
}
