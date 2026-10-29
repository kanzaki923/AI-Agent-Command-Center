import type { Attention, HomeSnapshot, HomeTree, SessionCard } from '@acc/protocol';
import { useQuery } from '@tanstack/react-query';
import { qk } from './keys';
import { type AppRuntime, useRuntime } from './runtime';

/**
 * The home screen's data (ui-redesign spec §3): one `home.get`, kept current by events
 * (daemon/live.ts patches it with applyHomeEvent and refetches, debounced 300ms, when an event
 * says so). Everything else that shows trees, attention or today's spend reads this snapshot.
 */
export function homeQuery(rt: AppRuntime) {
  return {
    queryKey: qk.home,
    queryFn: async (): Promise<HomeSnapshot> => rt.live.settleHome(await rt.client.call('home.get', {})),
  };
}

export function useHome() {
  const rt = useRuntime();
  return useQuery<HomeSnapshot>(homeQuery(rt));
}

/** A slice of the home snapshot; re-renders only when that slice changes (structural sharing). */
export function useHomeSelect<T>(select: (snap: HomeSnapshot) => T) {
  const rt = useRuntime();
  return useQuery<HomeSnapshot, Error, T>({ ...homeQuery(rt), select }).data;
}

const NO_ATTENTION: Attention[] = [];
const NO_TREES: HomeTree[] = [];

/**
 * Open attention items by priority: all of them, or those of one session / one tree. They
 * come from the home snapshot (it holds every open item).
 */
export function useAttention(filter: { sessionId?: string | null; rootSessionId?: string | null } = {}): Attention[] {
  const { sessionId, rootSessionId } = filter;
  return (
    useHomeSelect((s) =>
      s.attention.filter(
        (a) => (!sessionId || a.sessionId === sessionId) && (!rootSessionId || a.rootSessionId === rootSessionId),
      ),
    ) ?? NO_ATTENTION
  );
}

/** Attention items by id, in the given order (unknown ids are skipped). */
export function useAttentionItems(ids: readonly string[]): Attention[] {
  const key = ids.join(',');
  return (
    useHomeSelect((s) => {
      if (!key) return NO_ATTENTION;
      const byId = new Map(s.attention.map((a) => [a.id, a]));
      return ids.map((id) => byId.get(id)).filter((a): a is Attention => !!a);
    }) ?? NO_ATTENTION
  );
}

/** Today's spend against the daily limit (title bar meter). */
export function useTodaySpend(): { usedUsd: number; limitUsd: number | null; estimated: boolean } | null {
  return (
    useHomeSelect((s) => ({
      usedUsd: s.totals.spendTodayUsd,
      limitUsd: s.totals.dailyLimitUsd,
      estimated: s.totals.estimated,
    })) ?? null
  );
}

/** The trees of the home screen, in the daemon's order. */
export function useHomeTrees(): HomeTree[] {
  return useHomeSelect((s) => s.trees) ?? NO_TREES;
}

/** A session's card if it is on the home screen (root or node of a shown tree). */
export function findCard(snap: HomeSnapshot | undefined, sessionId: string | null | undefined): SessionCard | null {
  if (!snap || !sessionId) return null;
  for (const t of snap.trees) {
    if (t.root.id === sessionId) return t.root;
    const n = t.nodes.find((x) => x.id === sessionId);
    if (n) return n;
  }
  return null;
}

/** Current snapshot from the cache, outside React (commands, shortcuts). */
export function homeSnapshot(rt: AppRuntime): HomeSnapshot | undefined {
  return rt.queryClient.getQueryData<HomeSnapshot>(qk.home);
}
