import type { Approval, Integration, Run, Session, Task } from '@acc/protocol';
import { sumUsage } from '../lib/format';
import {
  ATTENTION_RANK,
  type DisplayState,
  isAttention,
  runStatusToState,
} from '../lib/status';

export type Role = 'Orchestrator' | 'Worker' | 'Reviewer' | 'Integrator' | 'チャット';
export type Zone = 'attention' | 'running' | 'queued' | 'done' | 'idle';
export const ZONES: Zone[] = ['attention', 'running', 'queued', 'done', 'idle'];
export const ZONE_LABEL: Record<Zone, string> = {
  attention: '要対応',
  running: '実行中',
  queued: '待機中',
  done: '完了',
  idle: '未実行',
};

/** One row of Command Mode / the sidebar: a session (or an integration awaiting review). */
export interface BoardItem {
  id: string;
  kind: 'session' | 'integration';
  title: string;
  role: Role;
  state: DisplayState;
  zone: Zone;
  session: Session | null;
  run: Run | null;
  runs: Run[];
  task: Task | null;
  approval: Approval | null;
  integration: Integration | null;
  /** When the current state began (attention items: oldest first = waiting longest). */
  since: string;
  costUsd: number;
  costSource: Run['usage']['costSource'];
  model: string | null;
}

export interface BoardInput {
  sessions: Session[];
  runs: Run[];
  approvals: Approval[];
  tasks: Task[];
  integrations: Integration[];
  projectId?: string | null;
  /** Runs that completed a moment ago: they linger in their group before moving (§3.2). */
  lingering?: Readonly<Record<string, true>>;
}

export function untitled(session: Session): string {
  if (session.title.trim()) return session.title;
  return session.kind === 'agent' ? '無題のエージェント' : '新しいチャット';
}

export function roleOf(session: Session, run: Run | null): Role {
  if (run?.kind === 'orchestrator') return 'Orchestrator';
  if (session.kind === 'chat') return 'チャット';
  const t = session.title.toLowerCase();
  if (t.startsWith('review') || session.title.startsWith('レビュー')) return 'Reviewer';
  return 'Worker';
}

function zoneOf(state: DisplayState): Zone {
  if (isAttention(state)) return 'attention';
  if (state === 'running') return 'running';
  if (state === 'queued') return 'queued';
  if (state === 'idle') return 'idle';
  return 'done';
}

/** Latest run per session, newest first (runs are newest-first already, but be safe). */
function runsBySession(runs: Run[]): Map<string, Run[]> {
  const m = new Map<string, Run[]>();
  for (const r of runs) {
    const list = m.get(r.sessionId);
    if (list) list.push(r);
    else m.set(r.sessionId, [r]);
  }
  for (const list of m.values()) list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return m;
}

/**
 * Derive the Command board from cached entities. Pure; recomputed during render.
 */
export function buildBoard(input: BoardInput): BoardItem[] {
  const { projectId } = input;
  const inProject = (p: string | null) => !projectId || p === projectId;
  const runMap = runsBySession(input.runs);
  const taskMap = new Map(input.tasks.map((t) => [t.id, t]));
  const pendingBySession = new Map<string, Approval>();
  for (const a of input.approvals) {
    if (a.status !== 'pending' || !a.sessionId || a.integrationId) continue;
    const cur = pendingBySession.get(a.sessionId);
    if (!cur || a.createdAt < cur.createdAt) pendingBySession.set(a.sessionId, a);
  }

  const items: BoardItem[] = [];
  for (const s of input.sessions) {
    if (s.archivedAt || !inProject(s.projectId)) continue;
    const runs = runMap.get(s.id) ?? [];
    const run = (s.activeRunId ? runs.find((r) => r.id === s.activeRunId) : undefined) ?? runs[0] ?? null;
    const task = s.taskId ? (taskMap.get(s.taskId) ?? null) : null;
    const approval = pendingBySession.get(s.id) ?? null;
    let state: DisplayState = run ? runStatusToState(run.status) : 'idle';
    let since = run?.startedAt ?? run?.createdAt ?? s.lastActivityAt;
    if (approval) {
      state = 'awaiting_approval';
      since = approval.createdAt;
    } else if (run && (state === 'failed' || state === 'interrupted')) {
      since = run.endedAt ?? run.updatedAt;
    } else if (state === 'completed' && task?.status === 'review') {
      state = 'review';
      since = task.updatedAt;
    } else if (state === 'completed' || state === 'cancelled') {
      since = run?.endedAt ?? s.lastActivityAt;
    }
    const usage = sumUsage(runs.map((r) => r.usage));
    let zone = zoneOf(state);
    if (state === 'completed' && run && input.lingering?.[run.id]) zone = 'running';
    items.push({
      id: s.id,
      kind: 'session',
      title: untitled(s),
      role: roleOf(s, run),
      state,
      zone,
      session: s,
      run,
      runs,
      task,
      approval,
      integration: null,
      since,
      costUsd: usage.costUsd,
      costSource: usage.costSource,
      model: run?.model ?? s.model,
    });
  }

  for (const i of input.integrations) {
    if (!inProject(i.projectId)) continue;
    // A conflict stops the integration just like a failure: someone has to step in.
    if (i.status !== 'awaiting_approval' && i.status !== 'failed' && i.status !== 'conflict') continue;
    const approval =
      input.approvals.find((a) => a.status === 'pending' && a.integrationId === i.id) ?? null;
    const state: DisplayState = i.status === 'awaiting_approval' ? 'review' : 'failed';
    items.push({
      id: i.id,
      kind: 'integration',
      title: i.title || '統合候補',
      role: 'Integrator',
      state,
      zone: 'attention',
      session: null,
      run: null,
      runs: [],
      task: null,
      approval,
      integration: i,
      since: i.updatedAt,
      costUsd: 0,
      costSource: 'unknown',
      model: null,
    });
  }
  return sortBoard(items);
}

const ZONE_ORDER: Record<Zone, number> = { attention: 0, running: 1, queued: 2, done: 3, idle: 4 };

/**
 * Attention: approvals -> failed -> interrupted -> review, oldest first (waiting longest).
 * Running / queued: oldest start first (stable while running). Done / idle: newest first.
 */
export function compareItems(a: BoardItem, b: BoardItem): number {
  const z = ZONE_ORDER[a.zone] - ZONE_ORDER[b.zone];
  if (z !== 0) return z;
  if (a.zone === 'attention' && isAttention(a.state) && isAttention(b.state)) {
    const r = ATTENTION_RANK[a.state] - ATTENTION_RANK[b.state];
    if (r !== 0) return r;
    return a.since.localeCompare(b.since) || a.id.localeCompare(b.id);
  }
  if (a.zone === 'running' || a.zone === 'queued') {
    return a.since.localeCompare(b.since) || a.id.localeCompare(b.id);
  }
  return b.since.localeCompare(a.since) || a.id.localeCompare(b.id);
}

export function sortBoard(items: BoardItem[]): BoardItem[] {
  return [...items].sort(compareItems);
}

export function groupByZone(items: BoardItem[]): Record<Zone, BoardItem[]> {
  const out: Record<Zone, BoardItem[]> = { attention: [], running: [], queued: [], done: [], idle: [] };
  for (const it of items) out[it.zone].push(it);
  return out;
}

export interface AttentionCounts {
  total: number;
  awaiting_approval: number;
  failed: number;
  interrupted: number;
  review: number;
}

export function attentionCounts(items: BoardItem[]): AttentionCounts {
  const c: AttentionCounts = { total: 0, awaiting_approval: 0, failed: 0, interrupted: 0, review: 0 };
  for (const it of items) {
    if (!isAttention(it.state)) continue;
    c[it.state]++;
    c.total++;
  }
  return c;
}

/** Ctrl+J order: next attention item after `currentId` (wraps). */
export function nextAttention(
  items: BoardItem[],
  currentId: string | null,
  dir: 1 | -1 = 1,
): BoardItem | null {
  const list = sortBoard(items).filter((i) => i.zone === 'attention');
  if (list.length === 0) return null;
  const i = currentId ? list.findIndex((x) => x.id === currentId) : -1;
  if (i === -1) return dir === 1 ? list[0]! : list[list.length - 1]!;
  return list[(i + dir + list.length) % list.length]!;
}

/** Elapsed reference for a row: run start -> end (or now). */
export function elapsedRange(item: BoardItem): { start: string | null; end: string | null } {
  const r = item.run;
  if (!r) return { start: null, end: null };
  return { start: r.startedAt ?? r.createdAt, end: r.endedAt };
}
