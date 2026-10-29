import type { CostGroupBy, CostRange, CostSummary } from '@acc/protocol';
import { useQuery } from '@tanstack/react-query';
import { toastError } from '../store/toast';
import { qk } from './keys';
import { type AppRuntime, useRuntime } from './runtime';

export interface CostQuery {
  range?: CostRange;
  groupBy?: CostGroupBy;
  rootSessionId?: string;
}

/**
 * `cost.summary` (spend by day / project / tree / model with the daily limit). Refetched,
 * debounced, while it is shown and spend changes (daemon/live.ts). Pass `enabled: false` while
 * the popover is closed.
 */
export function useCostSummary(params: CostQuery, opts: { enabled?: boolean } = {}) {
  const rt = useRuntime();
  const p = { range: params.range ?? 'today', groupBy: params.groupBy ?? 'root', ...(params.rootSessionId ? { rootSessionId: params.rootSessionId } : {}) };
  return useQuery<CostSummary>({
    queryKey: qk.cost(p),
    queryFn: () => rt.client.call('cost.summary', p),
    enabled: opts.enabled ?? true,
    staleTime: 2_000,
  });
}

/** Today's limit +N (today only; the setting stays). */
export async function raiseDailyLimit(rt: AppRuntime, addUsd: number): Promise<boolean> {
  try {
    await rt.client.call('cost.raiseDaily', { addUsd });
    void rt.queryClient.invalidateQueries({ queryKey: qk.home });
    void rt.queryClient.invalidateQueries({ queryKey: ['cost.summary'] });
    return true;
  } catch (err) {
    toastError(err, '上限を上げられませんでした');
    return false;
  }
}

/** The daily limit setting (null removes it). */
export async function setDailyLimit(rt: AppRuntime, dailyUsd: number | null): Promise<boolean> {
  try {
    await rt.client.call('settings.update', { limits: { dailyUsd } });
    void rt.queryClient.invalidateQueries({ queryKey: qk.home });
    void rt.queryClient.invalidateQueries({ queryKey: qk.settings });
    return true;
  } catch (err) {
    toastError(err, '上限を変更できませんでした');
    return false;
  }
}

/** Budget of a session's tree (null removes it). */
export async function setTreeBudget(rt: AppRuntime, sessionId: string, limitUsd: number | null): Promise<boolean> {
  try {
    await rt.client.call('session.setBudget', { sessionId, limitUsd });
    void rt.queryClient.invalidateQueries({ queryKey: qk.home });
    return true;
  } catch (err) {
    toastError(err, '予算を変更できませんでした');
    return false;
  }
}

/** Add to a budget (a child's budget is topped up from its parent). */
export async function raiseBudget(rt: AppRuntime, budgetId: string, addUsd: number): Promise<boolean> {
  try {
    await rt.client.call('budget.raise', { budgetId, addUsd });
    return true;
  } catch (err) {
    toastError(err, '予算を増やせませんでした');
    return false;
  }
}
