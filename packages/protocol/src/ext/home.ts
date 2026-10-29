/**
 * T7 Home: session states, "what is it doing now", the home screen in one call (spec
 * 20261029 §2.2, §3.7, §6). Schemas are fixed by the Core track; T7 implements them.
 */
import { z } from 'zod';
import { ArtifactId, AttentionId, ProjectId, ScheduleId, SessionId, Timestamp } from '../common';
import { SessionState } from '../domain';
import { type MethodDef, params } from '../method';
import { Attention } from './attention';

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
