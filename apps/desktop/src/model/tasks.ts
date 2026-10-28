import type { Artifact, DiffStats, Message, Run, Session, Task, TaskStatus, Workspace } from '@acc/protocol';
import { TERMINAL_TASK_STATUSES } from '@acc/protocol';
import type { DisplayState } from '../lib/status';
import { untitled } from './board';

/**
 * The orchestrator's work as a tree (Command Mode, §5.1 "目標バー" expanded): goal → tasks,
 * each with its status, worker, worktree branch and diff stats. Pure; derived during render.
 */

export interface TaskNode {
  task: Task;
  children: TaskNode[];
  worker: Session | null;
  workerRun: Run | null;
  workspace: Workspace | null;
  diff: DiffStats | null;
  /** Unfinished tasks this one waits for (titles shown as "← A, B"). */
  waitsFor: Task[];
}

export interface TaskGroup {
  /** Orchestrator session id, or `human` for tasks people created. */
  id: string;
  goal: string;
  orchestrator: Session | null;
  projectId: string;
  roots: TaskNode[];
  counts: { total: number; done: number; running: number; review: number; failed: number };
  /** Latest change in the group (ordering, "finished a while ago" collapse). */
  updatedAt: string;
  /** Every task is done / cancelled / failed. */
  finished: boolean;
}

export function taskState(status: TaskStatus): DisplayState {
  switch (status) {
    case 'pending':
    case 'ready':
    case 'blocked':
      return 'queued';
    case 'running':
      return 'running';
    case 'review':
      return 'review';
    case 'done':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

export function isTerminalTask(status: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly TaskStatus[]).includes(status);
}

/** Tasks a human may start a worker for (dependencies done, nothing running). */
export function canSpawn(task: Task): boolean {
  return task.status === 'ready' || (task.status === 'pending' && task.dependsOn.length === 0) || task.status === 'failed';
}

export interface TaskTreeInput {
  tasks: Task[];
  sessions: Session[];
  runs: Run[];
  workspaces: Workspace[];
  /** diff artifacts, newest first */
  diffs: Artifact[];
  projectId?: string | null;
}

const ORDER: Record<TaskStatus, number> = {
  running: 0,
  review: 1,
  failed: 2,
  blocked: 3,
  ready: 4,
  pending: 5,
  done: 6,
  cancelled: 7,
};

export function buildTaskGroups(input: TaskTreeInput): TaskGroup[] {
  const tasks = input.tasks.filter((t) => !input.projectId || t.projectId === input.projectId);
  if (tasks.length === 0) return [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const sessions = new Map(input.sessions.map((s) => [s.id, s]));
  const sessionByTask = new Map<string, Session>();
  for (const s of input.sessions) {
    if (!s.taskId) continue;
    const cur = sessionByTask.get(s.taskId);
    if (!cur || s.createdAt > cur.createdAt) sessionByTask.set(s.taskId, s);
  }
  const latestRun = new Map<string, Run>();
  for (const r of input.runs) {
    const cur = latestRun.get(r.sessionId);
    if (!cur || r.createdAt > cur.createdAt) latestRun.set(r.sessionId, r);
  }
  const workspaces = new Map(input.workspaces.map((w) => [w.id, w]));
  // Worktrees created for a task point back at it (Workspace.taskId), like integration.create looks them up.
  const wsByTask = new Map<string, Workspace>();
  for (const w of input.workspaces) {
    if (w.taskId && w.status !== 'removed' && !wsByTask.has(w.taskId)) wsByTask.set(w.taskId, w);
  }
  const diffByTask = new Map<string, DiffStats>();
  const diffByWorkspace = new Map<string, DiffStats>();
  for (const a of input.diffs) {
    if (a.kind !== 'diff') continue;
    if (a.taskId && !diffByTask.has(a.taskId)) diffByTask.set(a.taskId, a.data.stats);
    if (a.workspaceId && !diffByWorkspace.has(a.workspaceId)) diffByWorkspace.set(a.workspaceId, a.data.stats);
  }

  const groupOf = (t: Task): string => (t.createdBy.kind === 'agent' ? t.createdBy.sessionId : 'human');

  const node = (t: Task): TaskNode => {
    const worker = (t.assigneeSessionId ? sessions.get(t.assigneeSessionId) : undefined) ?? sessionByTask.get(t.id) ?? null;
    const workspace =
      (t.workspaceId ? workspaces.get(t.workspaceId) : undefined) ??
      wsByTask.get(t.id) ??
      (worker?.workspaceId ? workspaces.get(worker.workspaceId) : undefined) ??
      null;
    const workspaceId = workspace?.id ?? t.workspaceId ?? worker?.workspaceId ?? null;
    return {
      task: t,
      children: [],
      worker,
      workerRun: worker ? (latestRun.get(worker.id) ?? null) : null,
      workspace,
      diff: diffByTask.get(t.id) ?? (workspaceId ? diffByWorkspace.get(workspaceId) : undefined) ?? null,
      waitsFor: t.dependsOn
        .map((id) => byId.get(id))
        .filter((d): d is Task => !!d && d.status !== 'done'),
    };
  };

  const nodes = new Map(tasks.map((t) => [t.id, node(t)]));
  const groups = new Map<string, TaskGroup>();
  const sortNodes = (list: TaskNode[]) =>
    list.sort(
      (a, b) =>
        ORDER[a.task.status] - ORDER[b.task.status] ||
        a.task.createdAt.localeCompare(b.task.createdAt) ||
        a.task.id.localeCompare(b.task.id),
    );

  for (const t of tasks) {
    const gid = groupOf(t);
    let g = groups.get(gid);
    if (!g) {
      const orch = gid === 'human' ? null : (sessions.get(gid) ?? null);
      g = {
        id: gid,
        goal: orch ? untitled(orch) : 'あなたが作成した Task',
        orchestrator: orch,
        projectId: t.projectId,
        roots: [],
        counts: { total: 0, done: 0, running: 0, review: 0, failed: 0 },
        updatedAt: t.updatedAt,
        finished: true,
      };
      groups.set(gid, g);
    }
    const n = nodes.get(t.id)!;
    const parent = t.parentTaskId ? nodes.get(t.parentTaskId) : undefined;
    if (parent && groupOf(parent.task) === gid) parent.children.push(n);
    else g.roots.push(n);
    g.counts.total++;
    if (t.status === 'done') g.counts.done++;
    if (t.status === 'running') g.counts.running++;
    if (t.status === 'review') g.counts.review++;
    if (t.status === 'failed') g.counts.failed++;
    if (!isTerminalTask(t.status)) g.finished = false;
    if (t.updatedAt > g.updatedAt) g.updatedAt = t.updatedAt;
  }

  for (const n of nodes.values()) sortNodes(n.children);
  for (const g of groups.values()) {
    sortNodes(g.roots);
    // A single root with subtasks is the goal itself (orchestrators often plan that way).
    if (g.roots.length === 1 && g.roots[0]!.children.length > 0) g.goal = g.roots[0]!.task.title;
  }
  // Active work first, then most recently changed.
  return [...groups.values()].sort(
    (a, b) => Number(a.finished) - Number(b.finished) || b.updatedAt.localeCompare(a.updatedAt),
  );
}

/** Flatten the visible tree (for j/k and keyboard navigation). */
export function flattenTasks(groups: TaskGroup[]): TaskNode[] {
  const out: TaskNode[] = [];
  const walk = (n: TaskNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  for (const g of groups) g.roots.forEach(walk);
  return out;
}

/** Tasks of a group that are ready to integrate (review, with a workspace), in creation order. */
export function integrableTasks(group: TaskGroup): Task[] {
  return flattenTasks([group])
    .filter((n) => n.task.status === 'review' && !!n.workspace)
    .map((n) => n.task)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** First line of the first message a human wrote in the orchestrator chat (the goal). */
export function goalFromMessages(messages: readonly Message[], max = 80): string | null {
  const first = messages.find((m) => m.role === 'user' && m.author.kind === 'human');
  const text = first?.content.find((p) => p.type === 'text')?.text.trim();
  if (!text) return null;
  const line = text.split('\n')[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function workerLabel(n: TaskNode): string | null {
  return n.worker ? untitled(n.worker) : null;
}
