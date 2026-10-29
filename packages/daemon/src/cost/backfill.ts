import { type CostSource, type SessionCost, TERMINAL_RUN_STATUSES } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { LedgerStore, dayOf, fromMicro, toMicro, weakestSource } from './ledger';

/**
 * Startup backfill of the usage ledger (spec 20261029 §1.12-2; idempotent, every start):
 * one row per ended run that has usage but no ledger row yet (`day` from its end, component
 * from its kind). Returns the number of rows added.
 */
export function backfillLedgerFromRuns(ctx: DaemonContext): number {
  const store = new LedgerStore(ctx.db);
  const tz = ctx.settings.get().limits.timezone;
  const runs = ctx.repos.runs.find({
    where: { status: [...TERMINAL_RUN_STATUSES] },
    sql: {
      clause: `id NOT IN (SELECT run_id FROM usage_ledger WHERE run_id IS NOT NULL)
        AND (json_extract(data, '$.usage.costUsd') > 0
          OR json_extract(data, '$.usage.inputTokens') > 0
          OR json_extract(data, '$.usage.outputTokens') > 0)`,
    },
    direction: 'asc',
  });
  if (runs.length === 0) return 0;
  const roots = new Map<string, string | null>();
  const rootOf = (sessionId: string) => {
    if (!roots.has(sessionId)) {
      roots.set(sessionId, ctx.repos.sessions.get(sessionId)?.rootSessionId ?? null);
    }
    return roots.get(sessionId) ?? null;
  };
  ctx.db.transaction(() => {
    for (const run of runs) {
      const ts = run.endedAt ?? run.updatedAt;
      store.insert({
        ts,
        day: dayOf(ts, tz),
        session_id: run.sessionId,
        root_session_id: rootOf(run.sessionId),
        project_id: run.projectId,
        run_id: run.id,
        model: run.model,
        component: run.kind === 'agent' ? 'agent' : 'llm',
        cost_micro: toMicro(run.usage.costUsd),
        input_tokens: run.usage.inputTokens,
        output_tokens: run.usage.outputTokens,
        source: run.usage.costSource,
      });
    }
  });
  return runs.length;
}

/**
 * Recompute every `Session.cost` from the ledger (own rows, and own + descendants for
 * `treeUsd`; `source` is the weakest among the rows counted in treeUsd). Writes only the
 * sessions whose cost changed, without events. Returns how many changed.
 */
export function recomputeSessionCosts(ctx: DaemonContext): number {
  const store = new LedgerStore(ctx.db);
  const own = store.perSession();
  const rows = ctx.db.all<{ id: string; parent_session_id: string | null; cost: string | null }>(
    `SELECT id, parent_session_id, json_extract(data, '$.cost') AS cost FROM sessions`,
  );
  const children = new Map<string, string[]>();
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    if (!r.parent_session_id || !ids.has(r.parent_session_id)) continue;
    const list = children.get(r.parent_session_id) ?? [];
    list.push(r.id);
    children.set(r.parent_session_id, list);
  }
  const tree = new Map<string, { micro: number; source: CostSource | null }>();
  const visiting = new Set<string>();
  const treeOf = (id: string): { micro: number; source: CostSource | null } => {
    const known = tree.get(id);
    if (known) return known;
    if (visiting.has(id)) return { micro: 0, source: null }; // a parent cycle: count once
    visiting.add(id);
    const mine = own.get(id);
    let micro = mine?.micro ?? 0;
    let source: CostSource | null = mine?.source ?? null;
    for (const c of children.get(id) ?? []) {
      const sub = treeOf(c);
      micro += sub.micro;
      if (sub.source) source = source ? weakestSource(source, sub.source) : sub.source;
    }
    visiting.delete(id);
    const out = { micro, source };
    tree.set(id, out);
    return out;
  };

  let changed = 0;
  ctx.db.transaction(() => {
    for (const r of rows) {
      const t = treeOf(r.id);
      const next: SessionCost = {
        ownUsd: fromMicro(own.get(r.id)?.micro ?? 0),
        treeUsd: fromMicro(t.micro),
        source: t.source ?? 'unknown',
      };
      const cur = r.cost ? (JSON.parse(r.cost) as Partial<SessionCost>) : null;
      const same =
        cur !== null &&
        cur.ownUsd === next.ownUsd &&
        cur.treeUsd === next.treeUsd &&
        cur.source === next.source;
      // An older row without `cost` reads as the empty default; only real spend needs a write.
      if (same || (cur === null && next.treeUsd === 0 && next.source === 'unknown')) continue;
      ctx.db.run(`UPDATE sessions SET data = json_set(data, '$.cost', json(?)) WHERE id = ?`, [
        JSON.stringify(next),
        r.id,
      ]);
      changed += 1;
    }
  });
  return changed;
}
