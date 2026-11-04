import type { DaemonContext } from '../core/context';
import { dayOf, fromMicro } from '../cost/ledger';
import { isFastModel } from './autoModel';
import { providerOf } from './gateway';
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
 * The cheapest of `models`: one on a plan first (it costs nothing per call; among those the
 * light tier, such as Luna, so the plan's quota lasts), then the lowest input price; unknown
 * prices last. Ties keep the roster's order.
 */
export function cheapestModel(
  models: readonly string[],
  onPlan: (model: string) => boolean,
  inputPrice: (model: string) => number | null,
): string | null {
  const cost = (m: string) =>
    onPlan(m) ? (isFastModel(m) ? -2 : -1) : (inputPrice(m) ?? Number.POSITIVE_INFINITY);
  return [...models].sort((a, b) => cost(a) - cost(b))[0] ?? null;
}

/**
 * The model of background work: the setting, else the roster's cheapest (a ChatGPT plan's
 * model first, then by input price), else `offline` (no connection, or the demo).
 */
export function backgroundModel(ctx: DaemonContext, offline: string): string {
  const s = ctx.settings.get();
  if (s.background.model) return s.background.model;
  const roster = rosterModels(s).filter((m) => !m.startsWith(MOCK_PREFIX));
  const pricing = ctx.hasService('pricing') ? ctx.service('pricing').lookup : null;
  // Signed in with ChatGPT, the OpenAI models run on the plan.
  const plan = !!s.providers.openai.chatgpt;
  return (
    cheapestModel(
      roster,
      (m) => plan && providerOf(m) === 'openai',
      (m) => pricing?.(m)?.inputPerMTok ?? null,
    ) ?? offline
  );
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
