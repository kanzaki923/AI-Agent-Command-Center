import {
  type Actor,
  type Attention,
  HOME_COUNT_KEYS,
  type HomeSnapshot,
  type HomeTree,
  type Params,
  type Result,
  type Schedule,
  type Session,
  type SessionState,
} from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { dayOf } from '../cost/ledger';
import { type CardFacts, depthFirst, inChunks, readCardFacts, toCard } from './cards';

/** States of a session that is doing something (its tree is shown on the home screen). */
const BUSY_STATES: readonly SessionState[] = ['working', 'queued', 'supervising'];
/** States that keep an older schedule firing visible (it still needs someone). */
const KEEP_FIRING_STATES: readonly SessionState[] = [
  'needs_you',
  'failed',
  'working',
  'queued',
  'supervising',
  'review',
];
/** Sessions whose root is listed whatever its age (besides open attention and schedules). */
const LISTED_STATES: readonly SessionState[] = [...BUSY_STATES, 'needs_you', 'failed', 'review'];

const quoted = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');

type Counts = HomeTree['counts'];

/** Which bucket of `HomeTree.counts` a state counts in (null: not counted). */
export function countKey(state: SessionState): keyof Counts | null {
  return HOME_COUNT_KEYS[state];
}

function emptyCounts(): Counts {
  return { working: 0, queued: 0, needsYou: 0, failed: 0, review: 0, done: 0, stopped: 0 };
}

/** A tree's spend is an estimate when anything in it was not reported by the provider. */
function spendEstimated(root: Session): boolean {
  return root.cost.treeUsd > 0 && root.cost.source !== 'reported';
}

/**
 * Ids of the root sessions the home screen lists (spec 20261029 §2.2 home): open attention,
 * something running or waiting, an enabled schedule, pinned, or activity within the window.
 * One query, whatever the number of trees.
 */
function listedRootIds(ctx: DaemonContext, sinceIso: string): string[] {
  return ctx.db
    .all<{ id: string }>(
      `SELECT root_session_id AS id FROM sessions
        WHERE archived_at IS NULL AND (
          last_activity_at >= ? OR state IN (${quoted(LISTED_STATES)})
          OR (parent_session_id IS NULL AND json_extract(data, '$.pinned') = 1))
       UNION SELECT root_session_id FROM attention WHERE status = 'open'
       UNION SELECT s.root_session_id FROM schedules sc JOIN sessions s ON s.id = sc.session_id
        WHERE sc.enabled = 1 AND s.archived_at IS NULL`,
      [sinceIso],
    )
    .map((r) => r.id)
    .filter((id): id is string => !!id);
}

/**
 * Older firings of the same schedule under the same parent, which the home screen folds
 * (only the latest is shown unless an older one still needs someone).
 */
function foldedFirings(sessions: readonly Session[]): Set<string> {
  const latest = new Map<string, Session>();
  for (const s of sessions) {
    if (!s.scheduleId || !s.parentSessionId) continue;
    const key = `${s.parentSessionId}/${s.scheduleId}`;
    const cur = latest.get(key);
    if (!cur || cur.createdAt < s.createdAt || (cur.createdAt === s.createdAt && cur.id < s.id)) {
      latest.set(key, s);
    }
  }
  const out = new Set<string>();
  for (const s of sessions) {
    if (!s.scheduleId || !s.parentSessionId) continue;
    if (latest.get(`${s.parentSessionId}/${s.scheduleId}`)?.id === s.id) continue;
    if (!KEEP_FIRING_STATES.includes(s.state)) out.add(s.id);
  }
  return out;
}

interface TreeDraft {
  root: Session;
  shown: { session: Session; depth: number }[];
  hiddenNodes: number;
  counts: Counts;
  nextRunAt: string | null;
  lastActivityAt: string;
  /** Something in the tree is working, waiting to start or supervising. */
  busy: boolean;
}

function draftTree(
  root: Session,
  members: readonly Session[],
  schedules: readonly Schedule[],
  maxNodes: number,
): TreeDraft {
  const order = depthFirst(root.id, members);
  const folded = foldedFirings(members);
  const hidden = new Set<string>();
  const visible: { session: Session; depth: number }[] = [];
  for (const node of order.slice(1)) {
    const parentHidden = node.session.parentSessionId
      ? hidden.has(node.session.parentSessionId)
      : false;
    if (parentHidden || folded.has(node.session.id) || visible.length >= maxNodes) {
      hidden.add(node.session.id);
      continue;
    }
    visible.push(node);
  }
  const counts = emptyCounts();
  let lastActivityAt = root.lastActivityAt;
  let busy = false;
  for (const { session } of order) {
    const key = countKey(session.state);
    if (key) counts[key] += 1;
    if (BUSY_STATES.includes(session.state)) busy = true;
    if (session.lastActivityAt > lastActivityAt) lastActivityAt = session.lastActivityAt;
  }
  const ids = new Set(order.map((o) => o.session.id));
  let nextRunAt: string | null = null;
  for (const sc of schedules) {
    if (!sc.nextRunAt || !ids.has(sc.sessionId)) continue;
    if (!nextRunAt || sc.nextRunAt < nextRunAt) nextRunAt = sc.nextRunAt;
  }
  return {
    root,
    shown: visible,
    hiddenNodes: order.length - 1 - visible.length,
    counts,
    nextRunAt,
    lastActivityAt,
    busy,
  };
}

/**
 * Sort key of a tree on the home screen: needing you (by the most urgent item), then busy,
 * then scheduled (soonest first), then recent (pinned first, latest activity first).
 */
function treeOrder(a: TreeDraft, b: TreeDraft, topPriority: Map<string, number>): number {
  const bucket = (t: TreeDraft) => {
    if (topPriority.has(t.root.id)) return 0;
    if (t.busy) return 1;
    if (t.nextRunAt) return 2;
    return 3;
  };
  const ba = bucket(a);
  const bb = bucket(b);
  if (ba !== bb) return ba - bb;
  if (ba === 0) {
    const d = topPriority.get(a.root.id)! - topPriority.get(b.root.id)!;
    if (d !== 0) return d;
  }
  if (ba === 2 && a.nextRunAt !== b.nextRunAt) return a.nextRunAt! < b.nextRunAt! ? -1 : 1;
  if (ba === 3 && a.root.pinned !== b.root.pinned) return a.root.pinned ? -1 : 1;
  if (a.lastActivityAt !== b.lastActivityAt) return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
  return a.root.id < b.root.id ? -1 : 1;
}

/** Today's spend is partly estimated (any non-reported row today). */
function todayEstimated(ctx: DaemonContext): boolean {
  try {
    const day = dayOf(ctx.clock.iso(), ctx.settings.get().limits.timezone);
    return !!ctx.db.get(
      `SELECT 1 AS x FROM usage_ledger WHERE day = ? AND source != 'reported' AND cost_micro != 0 LIMIT 1`,
      [day],
    );
  } catch {
    return false;
  }
}

/**
 * home.get (spec 20261029 §2.2, §6.4): everything the home screen draws, in a fixed number
 * of queries whatever the number of trees (no N+1). Apply events after `lastSeq` to stay
 * current (`applyHomeEvent` in @acc/protocol).
 */
export function buildHomeSnapshot(ctx: DaemonContext, p: Params<'home.get'>): HomeSnapshot {
  const { repos } = ctx;
  return ctx.db.transaction(() => {
    const lastSeq = ctx.bus.lastSeq();
    const nowMs = ctx.clock.now();
    const nowIso = new Date(nowMs).toISOString();
    const sinceIso = new Date(nowMs - p.doneWithinHours * 3_600_000).toISOString();

    const openAttention = repos.attention.find({
      where: { status: 'open' },
      orderBy: 'priority',
      direction: 'asc',
    });
    const schedules = repos.schedules.find({
      where: { enabled: true, next_run_at: { not: null } },
      orderBy: 'next_run_at',
      direction: 'asc',
    });
    const rootIds = listedRootIds(ctx, sinceIso);
    const members = inChunks(rootIds, (ids) =>
      repos.sessions.find({ where: { root_session_id: ids, archived_at: null } }),
    );
    const byRoot = new Map<string, Session[]>();
    for (const s of members) {
      const list = byRoot.get(s.rootSessionId) ?? [];
      list.push(s);
      byRoot.set(s.rootSessionId, list);
    }

    const drafts: TreeDraft[] = [];
    for (const [rootId, list] of byRoot) {
      const root = list.find((s) => s.id === rootId && !s.parentSessionId);
      if (!root) continue;
      drafts.push(draftTree(root, list, schedules, p.maxNodesPerTree));
    }
    const topPriority = new Map<string, number>();
    for (const a of openAttention) {
      if (!topPriority.has(a.rootSessionId)) topPriority.set(a.rootSessionId, a.priority);
    }
    drafts.sort((a, b) => treeOrder(a, b, topPriority));

    const cardIds = drafts.flatMap((t) => [t.root.id, ...t.shown.map((n) => n.session.id)]);
    const facts = readCardFacts(ctx, cardIds, openAttention);
    const trees: HomeTree[] = drafts.map((t) => toTree(t, facts));

    const stateCounts = new Map(
      ctx.db
        .all<{ state: string; n: number }>(
          'SELECT state, COUNT(*) AS n FROM sessions WHERE archived_at IS NULL GROUP BY state',
        )
        .map((r) => [r.state, r.n]),
    );
    const listed = new Set(members.map((s) => s.id));
    return {
      now: nowIso,
      lastSeq,
      totals: {
        working: stateCounts.get('working') ?? 0,
        needsYou: openAttention.length,
        failed: stateCounts.get('failed') ?? 0,
        spendTodayUsd: ctx.hasService('ledger') ? ctx.service('ledger').usedToday() : 0,
        dailyLimitUsd: ctx.settings.get().limits.dailyUsd,
        estimated: todayEstimated(ctx),
      },
      attention: openAttention,
      trees,
      upcoming: schedules
        .filter((s) => listed.has(s.sessionId))
        .slice(0, 5)
        .map((s) => ({
          scheduleId: s.id,
          sessionId: s.sessionId,
          title: s.title,
          at: s.nextRunAt!,
        })),
    };
  });
}

function toTree(t: TreeDraft, facts: CardFacts): HomeTree {
  const rootBudget = facts.budgets.get(t.root.id);
  return {
    root: toCard(t.root, 0, facts),
    nodes: t.shown.map((n) => toCard(n.session, n.depth, facts)),
    hiddenNodes: t.hiddenNodes,
    counts: t.counts,
    spend: {
      treeUsd: t.root.cost.treeUsd,
      limitUsd: rootBudget ? rootBudget.limitUsd : null,
      committedUsd: rootBudget
        ? Math.max(
            t.root.cost.treeUsd,
            rootBudget.spentUsd + rootBudget.allocatedUsd + rootBudget.reservedUsd,
          )
        : null,
      estimated: spendEstimated(t.root),
    },
    nextRunAt: t.nextRunAt,
    projectId: t.root.projectId,
  };
}

/**
 * session.tree: every (non-archived) session of the tree as cards, depth first, the root at
 * depth 0. An agent sees only its own subtree (it may not touch its parent or siblings,
 * spec §1.8), so its view is rooted at its own session.
 */
export function buildSessionTree(
  ctx: DaemonContext,
  sessionId: string,
  actor: Actor,
): Result<'session.tree'> {
  const { repos } = ctx;
  return ctx.db.transaction(() => {
    const session = repos.sessions.require(sessionId);
    const realRoot = session.rootSessionId;
    const viewRoot = actor.kind === 'agent' ? actor.sessionId : realRoot;
    const members = repos.sessions.find({
      where: { root_session_id: realRoot },
      sql: { clause: 'archived_at IS NULL OR id = ?', params: [viewRoot] },
    });
    const order = depthFirst(viewRoot, members);
    const openAttention: Attention[] = repos.attention.find({
      where: { root_session_id: realRoot, status: 'open' },
      orderBy: 'priority',
      direction: 'asc',
    });
    const facts = readCardFacts(
      ctx,
      order.map((o) => o.session.id),
      openAttention,
    );
    return {
      rootSessionId: viewRoot,
      nodes: order.map((o) => toCard(o.session, o.depth, facts)),
    };
  });
}
