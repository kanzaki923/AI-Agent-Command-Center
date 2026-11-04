import type { DaemonContext } from '../core/context';
import { dayOf, fromMicro } from '../cost/ledger';
import { MOCK_PREFIX } from './mock';
import { rosterModels } from './roster';

/**
 * The daemon's own work behind the scenes (sorting members' memories, writing conversation
 * summaries) shares one model and one daily limit (`settings.background`): the person
 * chooses them once, and the cost of what nobody asked for in the moment stays bounded.
 */

/** Ledger components that are background work. */
export const BACKGROUND_COMPONENTS = ['memory', 'summary'] as const;

/**
 * The model of background work: the setting, else the roster's cheapest by input price,
 * else `offline` (no connection, or the demo).
 */
export function backgroundModel(ctx: DaemonContext, offline: string): string {
  const s = ctx.settings.get();
  if (s.background.model) return s.background.model;
  const roster = rosterModels(s).filter((m) => !m.startsWith(MOCK_PREFIX));
  if (roster.length === 0) return offline;
  const pricing = ctx.hasService('pricing') ? ctx.service('pricing').lookup : null;
  const price = (m: string) => pricing?.(m)?.inputPerMTok ?? Number.POSITIVE_INFINITY;
  return [...roster].sort((a, b) => price(a) - price(b))[0]!;
}

/** What background work cost today (USD). */
export function backgroundSpentToday(ctx: DaemonContext): number {
  const day = dayOf(ctx.clock.iso(), ctx.settings.get().limits.timezone);
  const row = ctx.db.get<{ n: number | null }>(
    `SELECT SUM(cost_micro) AS n FROM usage_ledger WHERE day = ? AND component IN (${BACKGROUND_COMPONENTS.map(() => '?').join(', ')})`,
    [day, ...BACKGROUND_COMPONENTS],
  );
  return fromMicro(row?.n ?? 0);
}

/** Whether background work must wait for tomorrow (its own limit, or the limit of everything). */
export function backgroundLimitReached(ctx: DaemonContext): boolean {
  const limit = ctx.settings.get().background.dailyUsd;
  if (limit !== null && backgroundSpentToday(ctx) >= limit) return true;
  return ctx.hasService('ledger') && ctx.service('ledger').dailyLeft() === 0;
}
