import {
  Artifact,
  type ArtifactKind,
  type Attention,
  type BudgetAllocation,
  type OutputKind,
  type Session,
  type SessionCard,
  type SessionRole,
  matchAnyPattern,
} from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import type { SqlValue } from '../core/db';

/** Bound parameters per IN list (well under SQLite's limit). */
const CHUNK = 500;

/** Run `query` over `ids` in chunks and concatenate (one query per 500 ids). */
export function inChunks<T>(ids: readonly string[], query: (chunk: string[]) => T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...query(ids.slice(i, i + CHUNK)));
  return out;
}

const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** Permissions that make a session a supervisor (it may start children). */
const SUPERVISOR_PERMISSIONS = ['session.spawn', 'task.spawnWorker'];

/** User-facing outputs and how the UI names them (legacy note / file read as document / files). */
const OUTPUT_KINDS: Partial<Record<ArtifactKind, OutputKind>> = {
  document: 'document',
  data: 'data',
  link: 'link',
  files: 'files',
  diff: 'code',
  note: 'document',
  file: 'files',
};

/** Everything the cards of a set of sessions need besides the sessions (batched reads). */
export interface CardFacts {
  budgets: Map<string, BudgetAllocation>;
  supervisors: Set<string>;
  outputs: Map<string, SessionCard['outputs']>;
  attention: Map<string, string[]>;
}

/**
 * Read the card facts of many sessions in a fixed number of queries (per 500 sessions):
 * active budgets, delegation grants, the latest 3 outputs. `openAttention` is passed in
 * (home.get reads it once for the whole screen), in priority order.
 */
export function readCardFacts(
  ctx: DaemonContext,
  sessionIds: readonly string[],
  openAttention: readonly Attention[],
): CardFacts {
  const { repos } = ctx;
  const nowIso = ctx.clock.iso();
  const budgets = new Map<string, BudgetAllocation>();
  const supervisors = new Set<string>();
  const outputs = new Map<string, SessionCard['outputs']>();
  const attention = new Map<string, string[]>();
  if (sessionIds.length > 0) {
    // Newest first: the latest active budget of a session wins.
    for (const b of inChunks(sessionIds, (ids) =>
      repos.budgets.find({ where: { subject_kind: 'session', subject_id: ids, status: 'active' } }),
    )) {
      const id = b.subject.id;
      if (id && !budgets.has(id)) budgets.set(id, b);
    }
    for (const g of inChunks(sessionIds, (ids) =>
      repos.grants.find({ where: { subject_kind: 'session', subject_id: ids, revoked_at: null } }),
    )) {
      if (g.subject.kind !== 'session') continue;
      if (g.expiresAt && g.expiresAt <= nowIso) continue;
      if (SUPERVISOR_PERMISSIONS.some((p) => matchAnyPattern(g.permissions, p))) {
        supervisors.add(g.subject.sessionId);
      }
    }
    const kinds = Object.keys(OUTPUT_KINDS);
    const rows = inChunks(sessionIds, (ids) =>
      ctx.db.all<{ data: string }>(
        `SELECT data FROM (
           SELECT data, ROW_NUMBER() OVER (
             PARTITION BY session_id ORDER BY created_at DESC, id DESC) AS rn
           FROM artifacts
           WHERE session_id IN (${marks(ids.length)}) AND kind IN (${marks(kinds.length)})
             AND COALESCE(json_extract(data, '$.role'), 'output') = 'output'
         ) WHERE rn <= 3`,
        [...ids, ...kinds] as SqlValue[],
      ),
    );
    const latest = rows
      .map((row) => Artifact.parse(JSON.parse(row.data)))
      .sort((x, y) => newestFirst(x.createdAt, x.id, y.createdAt, y.id));
    for (const a of latest) {
      const kind = OUTPUT_KINDS[a.kind];
      if (!a.sessionId || !kind) continue;
      const list = outputs.get(a.sessionId) ?? [];
      list.push({ id: a.id, kind, title: a.title });
      outputs.set(a.sessionId, list);
    }
  }
  for (const a of openAttention) {
    const list = attention.get(a.sessionId) ?? [];
    list.push(a.id);
    attention.set(a.sessionId, list);
  }
  return { budgets, supervisors, outputs, attention };
}

function newestFirst(aAt: string, aId: string, bAt: string, bId: string): number {
  if (aAt !== bAt) return aAt < bAt ? 1 : -1;
  return aId < bId ? 1 : aId > bId ? -1 : 0;
}

/** Who started a session, for its badge: a schedule, an AI (spawned), or a person. */
export function startedBy(s: Session): SessionCard['startedBy'] {
  if (s.scheduleId) return 'schedule';
  if (s.createdBy.kind === 'agent') return 'ai';
  if (s.createdBy.kind === 'system' && s.createdBy.component === 'scheduler') return 'schedule';
  return 'human';
}

export function roleOf(s: Session, facts: CardFacts): SessionRole {
  return facts.supervisors.has(s.id) ? 'supervisor' : s.kind;
}

/** One session as a chip (home.get, session.tree). */
export function toCard(s: Session, depth: number, facts: CardFacts): SessionCard {
  const budget = facts.budgets.get(s.id);
  return {
    id: s.id,
    parentId: s.parentSessionId,
    depth,
    title: s.title,
    role: roleOf(s, facts),
    state: s.state,
    stateSince: s.stateSince,
    now: s.now,
    costUsd: s.cost.ownUsd,
    budget: budget ? { limitUsd: budget.limitUsd, usedUsd: budget.spentUsd } : null,
    outputs: facts.outputs.get(s.id) ?? [],
    attentionIds: facts.attention.get(s.id) ?? [],
    startedBy: startedBy(s),
    scheduleId: s.scheduleId,
    lastActivityAt: s.lastActivityAt,
  };
}

/**
 * Depth-first order of a tree's sessions (children oldest first), with depths. Sessions
 * whose parent is not in `sessions` (e.g. archived) are left out with their subtree.
 */
export function depthFirst(
  rootId: string,
  sessions: readonly Session[],
): { session: Session; depth: number }[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const children = new Map<string, Session[]>();
  for (const s of sessions) {
    if (!s.parentSessionId || s.id === rootId) continue;
    const list = children.get(s.parentSessionId) ?? [];
    list.push(s);
    children.set(s.parentSessionId, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
    );
  }
  const root = byId.get(rootId);
  if (!root) return [];
  const out: { session: Session; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (s: Session, depth: number) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    out.push({ session: s, depth });
    for (const c of children.get(s.id) ?? []) visit(c, depth + 1);
  };
  visit(root, 0);
  return out;
}
