/**
 * T7 Home: session states, "what is it doing now", the home screen in one call (spec
 * 20261029 §2.2, §3.7, §6). Schemas are fixed by the Core track; T7 implements them.
 */
import { z } from 'zod';
import { ArtifactId, AttentionId, ProjectId, ScheduleId, SessionId, Timestamp } from '../common';
import { SessionState } from '../domain';
import { type MethodDef, params } from '../method';
import { Attention } from './attention';
import type { costEvents } from './cost';

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** Icon of a session: a supervisor holds a delegation grant; otherwise its kind. */
export const SessionRole = z.enum(['chat', 'agent', 'supervisor']);
export type SessionRole = z.infer<typeof SessionRole>;

/** Output kinds as the UI names them (`code` = a diff). */
export const OutputKind = z.enum(['document', 'data', 'link', 'files', 'code']);
export type OutputKind = z.infer<typeof OutputKind>;

/** One session as a chip / row on the home screen and in session.tree. */
export const SessionCard = z.object({
  id: SessionId,
  parentId: SessionId.nullable(),
  /** 0 for the root. */
  depth: z.int().nonnegative(),
  title: z.string(),
  role: SessionRole,
  state: SessionState,
  stateSince: Timestamp.nullable(),
  now: z.string().nullable(),
  costUsd: z.number(),
  budget: z.object({ limitUsd: z.number(), usedUsd: z.number() }).nullable(),
  /** Latest 3 outputs. */
  outputs: z.array(z.object({ id: ArtifactId, kind: OutputKind, title: z.string() })).max(3),
  attentionIds: z.array(AttentionId),
  startedBy: z.enum(['human', 'ai', 'schedule']),
  scheduleId: ScheduleId.nullable(),
  lastActivityAt: Timestamp,
});
export type SessionCard = z.infer<typeof SessionCard>;

const StateCounts = z.object({
  working: z.int().nonnegative(),
  queued: z.int().nonnegative(),
  needsYou: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  review: z.int().nonnegative(),
  done: z.int().nonnegative(),
  stopped: z.int().nonnegative(),
});

export const HomeTree = z.object({
  root: SessionCard,
  /** Descendants, depth first (with depth), cut at maxNodesPerTree. */
  nodes: z.array(SessionCard),
  /** Nodes left out (cut, or older schedule firings). */
  hiddenNodes: z.int().nonnegative(),
  counts: StateCounts,
  spend: z.object({
    treeUsd: z.number(),
    limitUsd: z.number().nullable(),
    /**
     * Spent plus what is handed to children (or held by calls) and not spent yet: the limit
     * minus what is still free. The tree cannot start more work once it reaches the limit.
     * Absent without a budget.
     */
    committedUsd: z.number().nullable().optional(),
    estimated: z.boolean(),
  }),
  /** Next run of a schedule attached to a session of this tree. */
  nextRunAt: Timestamp.nullable(),
  projectId: ProjectId.nullable(),
});
export type HomeTree = z.infer<typeof HomeTree>;

export const HomeSnapshot = z.object({
  now: Timestamp,
  /** Apply events after this seq to stay current. */
  lastSeq: z.int().nonnegative(),
  totals: z.object({
    working: z.int().nonnegative(),
    needsYou: z.int().nonnegative(),
    failed: z.int().nonnegative(),
    spendTodayUsd: z.number(),
    dailyLimitUsd: z.number().nullable(),
    estimated: z.boolean(),
  }),
  /** Open items, by priority (all trees). */
  attention: z.array(Attention),
  /** Root sessions: needing you, then working, then scheduled, then recent. */
  trees: z.array(HomeTree),
  /** Next 5 schedule firings. */
  upcoming: z.array(
    z.object({ scheduleId: ScheduleId, sessionId: SessionId, title: z.string(), at: Timestamp }),
  ),
});
export type HomeSnapshot = z.infer<typeof HomeSnapshot>;

/** Text being streamed into a session right now (session.messages `streaming`). */
export const StreamingMessage = z.object({
  messageId: z.string(),
  runId: z.string(),
  text: z.string(),
  reasoning: z.string(),
});
export type StreamingMessage = z.infer<typeof StreamingMessage>;

export const homeDomain = {
  SessionRole,
  OutputKind,
  SessionCard,
  HomeTree,
  HomeSnapshot,
  StreamingMessage,
} as const;

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

export const homeMethods = {
  'home.get': {
    params: params({
      doneWithinHours: z
        .int()
        .min(0)
        .max(24 * 30)
        .default(12),
      maxNodesPerTree: z.int().min(1).max(500).default(40),
    }),
    result: HomeSnapshot,
    description:
      'Everything the home screen shows in one call: every active session tree with its children, what they are doing, spend, items needing a human and upcoming schedules.',
    tool: false,
  },
  'session.tree': {
    params: params({ sessionId: SessionId.describe('Any session of the tree') }),
    result: z.object({ rootSessionId: SessionId, nodes: z.array(SessionCard) }),
    description:
      'The whole session tree a session belongs to: every session with its state, what it is doing now, spend and outputs. Use it to answer "what is going on".',
  },
} as const satisfies Record<string, MethodDef>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const homeEvents = {
  'session.state_changed': z.object({
    sessionId: SessionId,
    rootSessionId: SessionId,
    parentSessionId: SessionId.nullable(),
    from: SessionState,
    to: SessionState,
    stateSince: Timestamp.nullable(),
    now: z.string().nullable(),
  }),
  /** At most once per second per session. */
  'session.now_changed': z.object({
    sessionId: SessionId,
    rootSessionId: SessionId,
    now: z.string().nullable(),
  }),
} as const;

// ---------------------------------------------------------------------------
// Keeping a snapshot current from events (for clients of home.get)
// ---------------------------------------------------------------------------

type StateChanged = z.infer<(typeof homeEvents)['session.state_changed']>;
type NowChanged = z.infer<(typeof homeEvents)['session.now_changed']>;
type CostUpdated = z.infer<(typeof costEvents)['session.cost_updated']>;

/** Which `HomeTree.counts` bucket a state counts in (`supervising` / `idle`: none). */
export const HOME_COUNT_KEYS: Record<SessionState, keyof HomeTree['counts'] | null> = {
  working: 'working',
  queued: 'queued',
  needs_you: 'needsYou',
  failed: 'failed',
  review: 'review',
  done: 'done',
  stopped: 'stopped',
  supervising: null,
  idle: null,
};

/** Event types that change the home screen in ways only a new home.get can show. */
const HOME_REFETCH_TYPES = new Set([
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

export interface HomeEventResult {
  snapshot: HomeSnapshot;
  /** The event touched something the snapshot cannot be patched for: call home.get again. */
  refetch: boolean;
}

/**
 * Apply one event (seq > snapshot.lastSeq) to a home.get snapshot without refetching:
 * `session.state_changed` / `now_changed` / `cost_updated` and `attention.opened` /
 * `resolved` are patched in place (counts, totals, cards). Structural changes (a new
 * session or tree, schedules, outputs, budgets) ask for a refetch. Tree order is not
 * re-sorted. Pure: returns a new snapshot.
 */
export function applyHomeEvent(
  snapshot: HomeSnapshot,
  event: { seq: number; type: string; payload: unknown },
): HomeEventResult {
  if (event.seq <= snapshot.lastSeq) return { snapshot, refetch: false };
  const snap: HomeSnapshot = structuredClone(snapshot);
  snap.lastSeq = event.seq;
  const treeOf = (rootId: string) => snap.trees.find((t) => t.root.id === rootId);
  const cardOf = (tree: HomeTree, id: string) =>
    tree.root.id === id ? tree.root : tree.nodes.find((n) => n.id === id);
  if (HOME_REFETCH_TYPES.has(event.type)) return { snapshot: snap, refetch: true };
  switch (event.type) {
    case 'session.state_changed': {
      const p = event.payload as StateChanged;
      const tree = treeOf(p.rootSessionId);
      const from = HOME_COUNT_KEYS[p.from];
      const to = HOME_COUNT_KEYS[p.to];
      if (p.from === 'working') snap.totals.working -= 1;
      if (p.to === 'working') snap.totals.working += 1;
      if (p.from === 'failed') snap.totals.failed -= 1;
      if (p.to === 'failed') snap.totals.failed += 1;
      if (!tree) return { snapshot: snap, refetch: true };
      if (from) tree.counts[from] = Math.max(0, tree.counts[from] - 1);
      if (to) tree.counts[to] += 1;
      const card = cardOf(tree, p.sessionId);
      if (card) Object.assign(card, { state: p.to, stateSince: p.stateSince, now: p.now });
      return { snapshot: snap, refetch: false };
    }
    case 'session.now_changed': {
      const p = event.payload as NowChanged;
      const tree = treeOf(p.rootSessionId);
      const card = tree && cardOf(tree, p.sessionId);
      if (card) card.now = p.now;
      return { snapshot: snap, refetch: false };
    }
    case 'session.cost_updated': {
      const p = event.payload as CostUpdated;
      const tree = treeOf(p.rootSessionId);
      if (!tree) return { snapshot: snap, refetch: true };
      const card = cardOf(tree, p.sessionId);
      if (card) card.costUsd = p.ownUsd;
      if (p.sessionId === tree.root.id) {
        // New spend is today's spend (a day change is picked up by the next home.get).
        snap.totals.spendTodayUsd += p.treeUsd - tree.spend.treeUsd;
        tree.spend.treeUsd = p.treeUsd;
        if (tree.spend.committedUsd != null) {
          tree.spend.committedUsd = Math.max(tree.spend.committedUsd, p.treeUsd);
        }
        tree.spend.estimated = p.treeUsd > 0 && p.source !== 'reported';
        if (tree.spend.estimated) snap.totals.estimated = true;
      }
      return { snapshot: snap, refetch: false };
    }
    case 'attention.opened': {
      const a = (event.payload as { attention: Attention }).attention;
      if (snap.attention.some((x) => x.id === a.id)) return { snapshot: snap, refetch: false };
      const tree = treeOf(a.rootSessionId);
      if (!tree) return { snapshot: snap, refetch: true };
      snap.attention.push(a);
      snap.attention.sort((x, y) => x.priority - y.priority || (x.id < y.id ? -1 : 1));
      snap.totals.needsYou = snap.attention.length;
      const card = cardOf(tree, a.sessionId);
      if (card) {
        const order = new Map(snap.attention.map((x, i) => [x.id, i]));
        card.attentionIds = [...card.attentionIds, a.id].sort(
          (x, y) => (order.get(x) ?? 0) - (order.get(y) ?? 0),
        );
      }
      return { snapshot: snap, refetch: false };
    }
    case 'attention.resolved': {
      const a = (event.payload as { attention: Attention }).attention;
      snap.attention = snap.attention.filter((x) => x.id !== a.id);
      snap.totals.needsYou = snap.attention.length;
      const tree = treeOf(a.rootSessionId);
      const card = tree && cardOf(tree, a.sessionId);
      if (card) card.attentionIds = card.attentionIds.filter((id) => id !== a.id);
      return { snapshot: snap, refetch: false };
    }
    default:
      return { snapshot: snap, refetch: false };
  }
}
