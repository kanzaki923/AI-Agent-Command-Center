import type { CostGroupBy, CostRange, CostSummary } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import type { SqlValue } from '../core/db';
import { dayOf, fromMicro } from './ledger';
import type { UsageLedger } from './service';

const DAY_MS = 86_400_000;

/** SQL `WHERE` for a range: whole days in settings.limits.timezone, or an explicit span. */
export function rangeWhere(
  range: CostRange,
  nowIso: string,
  timeZone: string,
): { clause: string; params: SqlValue[] } {
  if (typeof range === 'object') {
    return { clause: 'ts >= ? AND ts < ?', params: [range.from, range.to] };
  }
  const days = range === 'today' ? 1 : range === '7d' ? 7 : 30;
  const from = dayOf(new Date(Date.parse(nowIso) - (days - 1) * DAY_MS).toISOString(), timeZone);
  return { clause: 'day >= ? AND day <= ?', params: [from, dayOf(nowIso, timeZone)] };
}

/** Ids of a session and its descendants (recursive over parent_session_id). */
export const SUBTREE_CTE = `WITH RECURSIVE subtree(id) AS (
  SELECT ? UNION SELECT s.id FROM sessions s JOIN subtree t ON s.parent_session_id = t.id)`;

const GROUP_COLUMN: Record<CostGroupBy, string> = {
  day: 'day',
  project: 'project_id',
  root: 'root_session_id',
  model: 'model',
};

/**
 * `cost.summary`: spend in a range grouped by day / project / session tree / model, from the
 * ledger (adjust rows included, so corrected estimates net out). `subtreeOf` limits it to a
 * session and its descendants (agents: always their own tree).
 */
export function costSummary(
  ctx: DaemonContext,
  ledger: UsageLedger,
  p: { range: CostRange; groupBy: CostGroupBy; subtreeOf?: string | null },
): CostSummary {
  const settings = ctx.settings.get();
  const where = rangeWhere(p.range, ctx.clock.iso(), settings.limits.timezone);
  const col = GROUP_COLUMN[p.groupBy];
  const params: SqlValue[] = [];
  let prefix = '';
  let clause = where.clause;
  if (p.subtreeOf) {
    prefix = SUBTREE_CTE;
    params.push(p.subtreeOf);
    clause += ' AND session_id IN (SELECT id FROM subtree)';
  }
  params.push(...where.params);
  const rows = ctx.db.all<{ k: string | null; micro: number; weak: number }>(
    `${prefix}
     SELECT ${col} AS k, SUM(cost_micro) AS micro,
            SUM(CASE WHEN source = 'reported' THEN 0 ELSE 1 END) AS weak
       FROM usage_ledger WHERE ${clause} GROUP BY ${col}
      ORDER BY ${p.groupBy === 'day' ? 'k ASC' : 'micro DESC'}`,
    params,
  );
  const out = rows
    .filter((r) => r.micro !== 0 || r.weak > 0)
    .map((r) => ({
      key: r.k ?? 'none',
      label: labelOf(ctx, p.groupBy, r.k),
      usd: fromMicro(r.micro),
      estimated: r.weak > 0,
    }));
  const daily = ledger.daily();
  return {
    totalUsd: fromMicro(rows.reduce((n, r) => n + r.micro, 0)),
    estimated: out.some((r) => r.estimated),
    rows: out,
    daily: { limitUsd: daily.limitUsd, usedTodayUsd: daily.usedTodayUsd },
  };
}

function labelOf(ctx: DaemonContext, groupBy: CostGroupBy, key: string | null): string {
  switch (groupBy) {
    case 'day':
      return key ?? '不明';
    case 'project':
      return (key && ctx.repos.projects.get(key)?.name) || 'プロジェクトなし';
    case 'root':
      return (key && ctx.repos.sessions.get(key)?.title) || '会話なし';
    case 'model':
      return key ?? 'モデル不明';
  }
}
