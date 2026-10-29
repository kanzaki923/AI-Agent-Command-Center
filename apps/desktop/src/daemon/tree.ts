import type { SessionCard } from '@acc/protocol';
import { useQuery } from '@tanstack/react-query';
import { qk } from './keys';
import type { SessionTree } from './live';
import { useRuntime } from './runtime';

export type { SessionTree } from './live';

/**
 * The whole tree a session belongs to (`session.tree`): every session of it as a card, depth
 * first. Kept current by events (daemon/live.ts): state / now / cost / attention in place, new
 * children and outputs by a debounced refetch.
 */
export function useSessionTree(sessionId: string | null | undefined) {
  const rt = useRuntime();
  return useQuery<SessionTree>({
    queryKey: qk.tree(sessionId ?? ''),
    queryFn: () => rt.client.call('session.tree', { sessionId: sessionId! }),
    enabled: !!sessionId,
  });
}

/** Relations inside a tree, derived from its cards. */
export function treeRelations(tree: SessionTree | undefined, sessionId: string | null | undefined) {
  const nodes = tree?.nodes ?? [];
  const self = nodes.find((n) => n.id === sessionId) ?? null;
  const parent = self?.parentId ? (nodes.find((n) => n.id === self.parentId) ?? null) : null;
  const children: SessionCard[] = self ? nodes.filter((n) => n.parentId === self.id) : [];
  /** Ids of the session and its descendants. */
  const subtree = new Set<string>();
  if (self) {
    subtree.add(self.id);
    for (const n of nodes) if (n.parentId && subtree.has(n.parentId)) subtree.add(n.id);
  }
  return { self, parent, children, subtree, root: nodes.find((n) => n.id === tree?.rootSessionId) ?? null };
}
