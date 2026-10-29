import type { Attention, HomeSnapshot, HomeTree, SessionCard, SessionState } from '@acc/protocol';
import { isSettled, sortByState } from '../../lib/states';

/**
 * The shape of the home screen (spec §3.1) as plain data: which lanes in which order, which of
 * them are folded to their heading, and the order of each lane's chips. Kept apart from the
 * cards themselves so the shape can be held still while the pointer or keyboard is on the
 * screen (§3.3) while the cards keep showing live data.
 */
export interface LaneShape {
  /** Root session id of the tree. */
  id: string;
  /** Settled tree: only its heading is shown, quieter. */
  compact: boolean;
  /** Child chips in display order (state priority, then the daemon's order). */
  chips: string[];
}

/** Attention items shown before 「あと N 件」 when there are more than one more. */
export const ATTENTION_SHOWN = 5;

/** The attention items on screen: all of them, or 5 when more than 6 are open and not expanded. */
export function visibleAttention(items: readonly Attention[], expanded: boolean): { shown: Attention[]; more: number } {
  if (expanded || items.length <= ATTENTION_SHOWN + 1) return { shown: [...items], more: 0 };
  return { shown: items.slice(0, ATTENTION_SHOWN), more: items.length - ATTENTION_SHOWN };
}

/** Children of a tree's root shown as chips (every descendant; depth 1 in practice). */
export function laneChildren(tree: HomeTree): SessionCard[] {
  return sortByState(
    tree.nodes.filter((n) => n.depth >= 1),
    (n) => n.state,
  );
}

const OPEN_COUNTS: (keyof HomeTree['counts'])[] = ['working', 'queued', 'needsYou', 'failed', 'review'];

/**
 * Nothing in the tree needs anyone or moves: no attention, nothing working or waiting; every
 * shown session is done, idle or stopped.
 */
export function isSettledTree(tree: HomeTree, attention: readonly Attention[]): boolean {
  if (attention.some((a) => a.rootSessionId === tree.root.id)) return false;
  if (OPEN_COUNTS.some((k) => tree.counts[k] > 0)) return false;
  return [tree.root, ...tree.nodes].every((c) => isSettled(c.state));
}

/** The live shape of a snapshot (daemon's tree order). */
export function homeShape(snap: Pick<HomeSnapshot, 'trees' | 'attention'>): LaneShape[] {
  return snap.trees.map((t) => {
    const chips = laneChildren(t).map((c) => c.id);
    return { id: t.root.id, compact: isSettledTree(t, snap.attention), chips };
  });
}

/**
 * The shape to show while holding: what was on screen (`held`) for everything still there,
 * with lanes and chips that appeared since then added at the end, and whatever went away
 * dropped. Nothing already on screen moves or folds until the hold ends.
 */
export function heldShape(held: readonly LaneShape[], live: readonly LaneShape[]): LaneShape[] {
  const liveById = new Map(live.map((l) => [l.id, l]));
  const out: LaneShape[] = [];
  for (const h of held) {
    const l = liveById.get(h.id);
    if (!l) continue;
    const now = new Set(l.chips);
    const kept = h.chips.filter((id) => now.has(id));
    const keptSet = new Set(kept);
    out.push({ id: h.id, compact: h.compact, chips: [...kept, ...l.chips.filter((id) => !keptSet.has(id))] });
  }
  const heldIds = new Set(held.map((h) => h.id));
  for (const l of live) if (!heldIds.has(l.id)) out.push(l);
  return out;
}

/**
 * What J / K walk through, top to bottom (§3.4): the attention rows on screen, then for each
 * lane its heading (the root conversation) and its chips.
 */
export function navOrder(attentionIds: readonly string[], lanes: readonly LaneShape[]): string[] {
  const ids = [...attentionIds];
  for (const l of lanes) {
    ids.push(l.id);
    if (!l.compact) ids.push(...l.chips);
  }
  return ids;
}

/** One step of J / K from `current`; from nothing (or something gone) J starts at the top, K at the bottom. */
export function stepSelection(ids: readonly string[], current: string | null, dir: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = current ? ids.indexOf(current) : -1;
  if (at === -1) return dir === 1 ? ids[0]! : ids[ids.length - 1]!;
  return ids[Math.max(0, Math.min(ids.length - 1, at + dir))]!;
}

/** Where the selection goes when the selected item leaves (answered): the next one, else the one before. */
export function neighbourOf(ids: readonly string[], id: string): string | null {
  const at = ids.indexOf(id);
  if (at === -1) return null;
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

/** The states a tree's band shows, in priority order, with their counts (zeros left out). */
export const BAND_STATES: { state: SessionState; key: keyof HomeTree['counts'] }[] = [
  { state: 'needs_you', key: 'needsYou' },
  { state: 'failed', key: 'failed' },
  { state: 'working', key: 'working' },
  { state: 'queued', key: 'queued' },
  { state: 'review', key: 'review' },
  { state: 'stopped', key: 'stopped' },
  { state: 'done', key: 'done' },
];

export function bandSegments(counts: HomeTree['counts']): { state: SessionState; n: number }[] {
  return BAND_STATES.map(({ state, key }) => ({ state, n: counts[key] })).filter((s) => s.n > 0);
}
