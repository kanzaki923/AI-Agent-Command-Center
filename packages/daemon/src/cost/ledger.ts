import type { CostSource, LedgerComponent } from '@acc/protocol';
import type { Db } from '../core/db';

/** A usage_ledger row as stored (spec 20261029 §1.10). Money is integer micro-dollars. */
export interface LedgerRow {
  id: number;
  ts: string;
  day: string;
  session_id: string | null;
  root_session_id: string | null;
  project_id: string | null;
  run_id: string | null;
  model: string | null;
  component: LedgerComponent;
  cost_micro: number;
  input_tokens: number;
  output_tokens: number;
  source: CostSource;
}

export type NewLedgerRow = Omit<LedgerRow, 'id'>;

export const toMicro = (usd: number) => Math.round(usd * 1_000_000);
export const fromMicro = (micro: number) => micro / 1_000_000;

/** Weakest first: one unknown row makes a total a lower bound. */
const SOURCE_RANK: Record<CostSource, number> = { unknown: 0, estimated: 1, reported: 2 };
export function weakestSource(a: CostSource, b: CostSource): CostSource {
  return SOURCE_RANK[a] <= SOURCE_RANK[b] ? a : b;
}

/**
 * The calendar day of `iso` in an IANA time zone, as YYYY-MM-DD (UTC when the zone is
 * unknown). Ledger days follow settings.limits.timezone.
 */
export function dayOf(iso: string, timeZone: string): string {
  const date = new Date(iso);
  const format = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  try {
    return format(timeZone);
  } catch {
    return format('UTC');
  }
}

/** Plain SQL access to the usage ledger (not an entity table: rows are append-only facts). */
export class LedgerStore {
  constructor(private readonly db: Db) {}

  insert(row: NewLedgerRow): number {
    return this.db.run(
      `INSERT INTO usage_ledger (ts, day, session_id, root_session_id, project_id, run_id, model,
         component, cost_micro, input_tokens, output_tokens, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.ts,
        row.day,
        row.session_id,
        row.root_session_id,
        row.project_id,
        row.run_id,
        row.model,
        row.component,
        Math.round(row.cost_micro),
        Math.max(0, Math.round(row.input_tokens)),
        Math.max(0, Math.round(row.output_tokens)),
        row.source,
      ],
    ).lastInsertRowid;
  }

  /** Total of a day, in micro-dollars. */
  dayTotalMicro(day: string): number {
    return (
      this.db.get<{ n: number | null }>(
        'SELECT SUM(cost_micro) AS n FROM usage_ledger WHERE day = ?',
        [day],
      )?.n ?? 0
    );
  }

  /** Sum and weakest source per session (sessions without rows are absent). */
  perSession(): Map<string, { micro: number; source: CostSource }> {
    const out = new Map<string, { micro: number; source: CostSource }>();
    for (const r of this.db.all<{ session_id: string; micro: number; source: CostSource }>(
      `SELECT session_id, SUM(cost_micro) AS micro, source FROM usage_ledger
        WHERE session_id IS NOT NULL GROUP BY session_id, source`,
    )) {
      const cur = out.get(r.session_id);
      out.set(r.session_id, {
        micro: (cur?.micro ?? 0) + r.micro,
        source: cur ? weakestSource(cur.source, r.source) : r.source,
      });
    }
    return out;
  }

  rows(where = '1', params: (string | number)[] = []): LedgerRow[] {
    return this.db.all<LedgerRow>(`SELECT * FROM usage_ledger WHERE ${where} ORDER BY id`, params);
  }
}
