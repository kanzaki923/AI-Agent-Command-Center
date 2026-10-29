import {
  type Attention,
  type Event,
  type HomeSnapshot,
  type SessionCard,
  applyHomeEvent,
} from '@acc/protocol';
import type { QueryClient } from '@tanstack/react-query';
import { qk } from './keys';

/**
 * Live views of the session-tree screens (ui-redesign spec §3): the home snapshot and the
 * session trees are patched from events in place, and refetched — debounced, 300ms — only
 * when an event says the structure changed. Outputs, schedules and cost summaries are
 * refetched (debounced) when their events arrive.
 */

/** Events applyHomeEvent patches in place. */
export const HOME_PATCH_TYPES: ReadonlySet<string> = new Set([
  'session.state_changed',
  'session.now_changed',
  'session.cost_updated',
  'attention.opened',
  'attention.resolved',
]);

/** Events applyHomeEvent answers with `refetch: true` (kept in sync by a test). */
export const HOME_REFETCH_TYPES: ReadonlySet<string> = new Set([
  'session.created',
  'session.archived',
  'artifact.created',
  'artifact.updated',
  'schedule.created',
  'schedule.updated',
  'schedule.deleted',
  'schedule.fired',
  'grant.created',
  'grant.revoked',
  'budget.updated',
]);

/** session.updated changes the home screen shows (others are covered by their own events). */
const VISIBLE_SESSION_CHANGES = new Set(['title', 'pinned', 'projectId', 'archivedAt', 'parentSessionId']);

function isVisibleSessionUpdate(e: Event): boolean {
  return e.type === 'session.updated' && e.payload.changes.some((c) => VISIBLE_SESSION_CHANGES.has(c));
}

export interface HomeEventOutcome {
  snapshot: HomeSnapshot;
  refetch: boolean;
}

/** One event against a cached home snapshot; null when the event does not concern it. */
export function homeEvent(snapshot: HomeSnapshot, e: Event): HomeEventOutcome | null {
  if (isVisibleSessionUpdate(e)) return { snapshot, refetch: true };
  if (!HOME_PATCH_TYPES.has(e.type) && !HOME_REFETCH_TYPES.has(e.type)) return null;
  if (e.seq <= snapshot.lastSeq) return null;
  return applyHomeEvent(snapshot, e);
}

/** session.tree result as cached under qk.tree(id). */
export interface SessionTree {
  rootSessionId: string;
  nodes: SessionCard[];
}

/**
 * One event against a cached session tree: state / now / cost / attention are patched in
 * place; a new or archived session, a new output or a delegation change asks for a refetch.
 * Pure (returns the same object when nothing changed).
 */
export function applyTreeEvent(tree: SessionTree, e: Event): { tree: SessionTree; refetch: boolean } {
  const has = (id: string | null | undefined) => !!id && tree.nodes.some((n) => n.id === id);
  const patch = (id: string, fn: (n: SessionCard) => SessionCard) => {
    if (!has(id)) return { tree, refetch: false };
    return { tree: { ...tree, nodes: tree.nodes.map((n) => (n.id === id ? fn(n) : n)) }, refetch: false };
  };
  const refetch = { tree, refetch: true };
  const none = { tree, refetch: false };
  switch (e.type) {
    case 'session.state_changed': {
      const p = e.payload;
      return patch(p.sessionId, (n) => ({ ...n, state: p.to, stateSince: p.stateSince, now: p.now }));
    }
    case 'session.now_changed': {
      const p = e.payload;
      return patch(p.sessionId, (n) => ({ ...n, now: p.now }));
    }
    case 'session.cost_updated': {
      const p = e.payload;
      return patch(p.sessionId, (n) => ({ ...n, costUsd: p.ownUsd }));
    }
    case 'attention.opened': {
      const a = e.payload.attention;
      return patch(a.sessionId, (n) =>
        n.attentionIds.includes(a.id) ? n : { ...n, attentionIds: [...n.attentionIds, a.id] },
      );
    }
    case 'attention.resolved': {
      const a = e.payload.attention;
      return patch(a.sessionId, (n) => ({ ...n, attentionIds: n.attentionIds.filter((id) => id !== a.id) }));
    }
    case 'session.created': {
      const s = e.payload.session;
      return s.rootSessionId === tree.rootSessionId || has(s.parentSessionId) ? refetch : none;
    }
    case 'session.archived':
      return has(e.payload.sessionId) ? refetch : none;
    case 'session.updated':
      return has(e.payload.session.id) && isVisibleSessionUpdate(e) ? refetch : none;
    case 'artifact.created':
    case 'artifact.updated':
      return has(e.payload.artifact.sessionId) ? refetch : none;
    case 'grant.created':
    case 'grant.revoked':
      // The role (supervisor) of a node may have changed.
      return refetch;
    default:
      return none;
  }
}

/** Remove one open attention item from a home snapshot (optimistic answer). */
export function withoutAttention(snapshot: HomeSnapshot, attentionId: string): HomeSnapshot {
  if (!snapshot.attention.some((a) => a.id === attentionId)) return snapshot;
  const attention = snapshot.attention.filter((a) => a.id !== attentionId);
  const dropId = (c: SessionCard): SessionCard =>
    c.attentionIds.includes(attentionId) ? { ...c, attentionIds: c.attentionIds.filter((id) => id !== attentionId) } : c;
  return {
    ...snapshot,
    attention,
    totals: { ...snapshot.totals, needsYou: attention.length },
    trees: snapshot.trees.map((t) => ({ ...t, root: dropId(t.root), nodes: t.nodes.map(dropId) })),
  };
}

/** Put an attention item back (an optimistic answer failed), in priority order. */
export function withAttention(snapshot: HomeSnapshot, a: Attention): HomeSnapshot {
  if (snapshot.attention.some((x) => x.id === a.id)) return snapshot;
  const attention = [...snapshot.attention, a].sort((x, y) => x.priority - y.priority || (x.id < y.id ? -1 : 1));
  const addId = (c: SessionCard): SessionCard =>
    c.id === a.sessionId && !c.attentionIds.includes(a.id) ? { ...c, attentionIds: [...c.attentionIds, a.id] } : c;
  return {
    ...snapshot,
    attention,
    totals: { ...snapshot.totals, needsYou: attention.length },
    trees: snapshot.trees.map((t) => ({ ...t, root: addId(t.root), nodes: t.nodes.map(addId) })),
  };
}

type Timer = unknown;

export interface LiveViewsOptions {
  /** Debounce of structural refetches (home, trees). Spec §3: 300ms. */
  refetchMs?: number;
  /** Debounce of output / schedule / cost refetches. */
  slowRefetchMs?: number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
}

/** Events kept for replay onto a home snapshot that was in flight while they arrived. */
const REPLAY_MAX = 500;

export function createLiveViews(qc: QueryClient, opts: LiveViewsOptions = {}) {
  const refetchMs = opts.refetchMs ?? 300;
  const slowMs = opts.slowRefetchMs ?? 800;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t: Timer) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const timers = new Map<string, Timer>();
  const recent: Event[] = [];
  /** Attention answered from this window and not yet confirmed: hidden from every snapshot. */
  const answering = new Set<string>();

  const debounce = (key: string, ms: number, fn: () => void) => {
    const t = timers.get(key);
    if (t !== undefined) clearTimer(t);
    timers.set(
      key,
      setTimer(() => {
        timers.delete(key);
        fn();
      }, ms),
    );
  };
  const refetchHome = () => debounce('home', refetchMs, () => void qc.invalidateQueries({ queryKey: qk.home }));
  const refetchTree = (key: readonly unknown[]) =>
    debounce(`tree:${JSON.stringify(key)}`, refetchMs, () => void qc.invalidateQueries({ queryKey: key, exact: true }));

  const hide = (snap: HomeSnapshot): HomeSnapshot => {
    let out = snap;
    for (const id of answering) out = withoutAttention(out, id);
    return out;
  };

  return {
    /** Apply one live event (called by startSync inside its batch, after applyEvent). */
    apply(e: Event): void {
      if (HOME_PATCH_TYPES.has(e.type) || HOME_REFETCH_TYPES.has(e.type) || e.type === 'session.updated') {
        recent.push(e);
        if (recent.length > REPLAY_MAX) recent.splice(0, recent.length - REPLAY_MAX);
      }

      const snap = qc.getQueryData<HomeSnapshot>(qk.home);
      if (snap) {
        const out = homeEvent(snap, e);
        if (out) {
          if (out.snapshot !== snap) qc.setQueryData(qk.home, hide(out.snapshot));
          if (out.refetch) refetchHome();
        }
      }

      for (const [key, tree] of qc.getQueriesData<SessionTree>({ queryKey: ['session.tree'] })) {
        if (!tree) continue;
        const out = applyTreeEvent(tree, e);
        if (out.tree !== tree) qc.setQueryData(key, out.tree);
        if (out.refetch) refetchTree(key);
      }

      switch (e.type) {
        case 'artifact.created':
        case 'artifact.updated':
          debounce('outputs', slowMs, () => void qc.invalidateQueries({ queryKey: ['outputs'] }));
          break;
        case 'schedule.created':
        case 'schedule.updated':
        case 'schedule.deleted':
        case 'schedule.fired':
          debounce('schedules', slowMs, () => void qc.invalidateQueries({ queryKey: ['schedule.list'] }));
          break;
        case 'session.cost_updated':
        case 'cost.limit_reached':
        case 'settings.updated':
          debounce('cost', slowMs, () => void qc.invalidateQueries({ queryKey: ['cost.summary'] }));
          break;
        default:
          break;
      }
    },

    /** A fresh home.get result: replay events that arrived while it was in flight. */
    settleHome(snapshot: HomeSnapshot): HomeSnapshot {
      let snap = snapshot;
      let again = false;
      for (const e of recent) {
        if (e.seq <= snap.lastSeq) continue;
        const out = homeEvent(snap, e);
        if (!out) continue;
        snap = out.snapshot;
        again ||= out.refetch;
      }
      if (again) refetchHome();
      return hide(snap);
    },

    /** Hide an attention item while its answer is on the way (`false` shows it again). */
    setAnswering(attentionId: string, on: boolean): void {
      if (on) answering.add(attentionId);
      else answering.delete(attentionId);
    },

    dispose(): void {
      for (const t of timers.values()) clearTimer(t);
      timers.clear();
    },
  };
}

export type LiveViews = ReturnType<typeof createLiveViews>;
