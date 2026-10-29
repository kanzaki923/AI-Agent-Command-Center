import type { Project, Session, SessionState } from '@acc/protocol';
import { STATE_META, STATE_ORDER, isSettled, sortByState } from '../../lib/states';

/**
 * The sidebar's conversation tree (ui-redesign spec §4), derived from the session list. Pure:
 * the components only render what these functions return.
 */

export interface TreeNode {
  session: Session;
  /** Direct children, oldest first (spawn order: rows never move under the pointer). */
  children: TreeNode[];
  /** Every descendant, depth first. */
  descendants: Session[];
  /** Latest activity of the session or anything below it. */
  activityAt: string;
  /** The session and everything below it are settled (done / idle / stopped). */
  settled: boolean;
}

/** Conversations whose whole tree has been settled this long fold into 「以前」. */
export const OLDER_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Up to this many child dots per row, then `+N`. */
export const MAX_DOTS = 6;

const later = (a: string, b: string) => (a > b ? a : b);

/**
 * Roots (sessions without a parent) with their descendants. Children whose parent is not in
 * the list (archived) are left out. Roots: pinned first, then by the latest activity of their
 * tree.
 */
export function buildForest(sessions: readonly Session[]): TreeNode[] {
  const live = sessions.filter((s) => !s.archivedAt);
  const ids = new Set(live.map((s) => s.id));
  const byParent = new Map<string, Session[]>();
  for (const s of live) {
    if (!s.parentSessionId || !ids.has(s.parentSessionId)) continue;
    const list = byParent.get(s.parentSessionId) ?? [];
    list.push(s);
    byParent.set(s.parentSessionId, list);
  }
  const seen = new Set<string>();
  const node = (s: Session): TreeNode => {
    seen.add(s.id);
    const kids = (byParent.get(s.id) ?? [])
      .filter((k) => !seen.has(k.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : 1));
    const children = kids.map(node);
    let activityAt = later(s.lastActivityAt, s.stateSince ?? '');
    let settled = isSettled(s.state);
    const descendants: Session[] = [];
    for (const c of children) {
      descendants.push(c.session, ...c.descendants);
      activityAt = later(activityAt, c.activityAt);
      settled &&= c.settled;
    }
    return { session: s, children, descendants, activityAt, settled };
  };
  return live
    .filter((s) => !s.parentSessionId)
    .map(node)
    .sort(
      (a, b) =>
        Number(b.session.pinned) - Number(a.session.pinned) ||
        b.activityAt.localeCompare(a.activityAt) ||
        (a.session.id < b.session.id ? -1 : 1),
    );
}

/** A tree folds into 「以前」: settled for a week, and not pinned. */
export function isOlder(tree: TreeNode, now: number): boolean {
  return tree.settled && !tree.session.pinned && now - Date.parse(tree.activityAt) >= OLDER_AFTER_MS;
}

export interface SidebarGroup {
  /** null: conversations without a project (shown first, without a heading). */
  project: Project | null;
  trees: TreeNode[];
}

/** Group key of a tree, for the reorder hold (a tree moving between groups is held too). */
export function groupKeyOf(tree: TreeNode, now: number, grouped: boolean, projectIds: ReadonlySet<string>): string {
  if (isOlder(tree, now)) return 'older';
  const p = tree.session.projectId;
  return grouped && p && projectIds.has(p) ? p : '';
}

/**
 * Trees into groups (spec §4): with two or more projects, one group per project after the
 * conversations without one; otherwise a single group. Trees settled for a week go to `older`.
 * `keyOf` decides membership (pass the held one from the reorder hold).
 */
export function groupTrees(
  trees: readonly TreeNode[],
  projects: readonly Project[],
  keyOf: (t: TreeNode) => string,
): { groups: SidebarGroup[]; older: TreeNode[] } {
  const grouped = projects.length >= 2;
  const byKey = new Map<string, TreeNode[]>();
  for (const t of trees) {
    const k = keyOf(t);
    const list = byKey.get(k) ?? [];
    list.push(t);
    byKey.set(k, list);
  }
  const groups: SidebarGroup[] = [{ project: null, trees: byKey.get('') ?? [] }];
  if (grouped) for (const p of projects) groups.push({ project: p, trees: byKey.get(p.id) ?? [] });
  return { groups, older: byKey.get('older') ?? [] };
}

export interface VisibleRow {
  node: TreeNode;
  depth: number;
  /** guides[i]: the line joining the children of the ancestor at depth i runs through this row. */
  guides: boolean[];
  /** Last child of its parent (the connector ends here: └). */
  last: boolean;
  open: boolean;
}

/** The rows of one tree as shown: a closed node hides its children. */
export function visibleRows(root: TreeNode, isOpen: (id: string) => boolean): VisibleRow[] {
  const out: VisibleRow[] = [];
  const walk = (n: TreeNode, depth: number, guides: boolean[], last: boolean) => {
    const open = n.children.length > 0 && isOpen(n.session.id);
    out.push({ node: n, depth, guides, last, open });
    if (!open) return;
    const next = depth === 0 ? [] : [...guides, !last];
    n.children.forEach((c, i) => walk(c, depth + 1, next, i === n.children.length - 1));
  };
  walk(root, 0, [], true);
  return out;
}

/** Ids of the ancestors of a session (parent first), from the session list. */
export function ancestorsOf(sessions: readonly Session[], sessionId: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!sessionId) return out;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  let cur = byId.get(sessionId)?.parentSessionId ?? null;
  while (cur && !out.has(cur)) {
    out.add(cur);
    cur = byId.get(cur)?.parentSessionId ?? null;
  }
  return out;
}

/** The dots beside a row: descendants' states by priority, at most MAX_DOTS, then `+N`. */
export function childDots(descendants: readonly Session[], max = MAX_DOTS): { states: SessionState[]; more: number } {
  const states = sortByState(descendants, (s) => s.state).map((s) => s.state);
  return { states: states.slice(0, max), more: Math.max(0, states.length - max) };
}

/** Tooltip of the dots: how many in each state (`作業中 2 · あなたの出番 1`), priority order. */
export function stateCountsLabel(descendants: readonly Session[]): string {
  const counts = new Map<SessionState, number>();
  for (const s of descendants) counts.set(s.state, (counts.get(s.state) ?? 0) + 1);
  return STATE_ORDER.filter((s) => counts.has(s))
    .map((s) => `${STATE_META[s].label} ${counts.get(s)}`)
    .join(' · ');
}
