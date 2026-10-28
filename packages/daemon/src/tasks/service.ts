import {
  type Actor,
  type Params,
  type SystemActor,
  TERMINAL_RUN_STATUSES,
  TERMINAL_TASK_STATUSES,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { conflict, invalidParams } from '../core/errors';

/** statusReason values set by automatic readiness. Blocks with other reasons are manual. */
export const DEPENDENCY_REASONS = {
  failed: 'dependency_failed',
  cancelled: 'dependency_cancelled',
  blocked: 'dependency_blocked',
} as const;

export const PARENT_CANCELLED = 'parent_cancelled';

export type TaskStatusPatch = Partial<
  Pick<Task, 'assigneeSessionId' | 'workspaceId' | 'resultSummary'>
>;

const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

const SCHEDULER: SystemActor = { kind: 'system', component: 'tasks' };

export function isTerminalTaskStatus(s: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly TaskStatus[]).includes(s);
}

/** Priority first (urgent → low), then creation order. */
export function compareTasks(a: Task, b: Task): number {
  return (
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Readiness is managed automatically while a task waits on its dependencies: `pending`,
 * `ready`, and `blocked` because of a dependency. Anything else (running, review, terminal,
 * blocked for a human) is left alone.
 */
function isAutoManaged(t: Task): boolean {
  return (
    t.status === 'pending' ||
    t.status === 'ready' ||
    (t.status === 'blocked' && (t.statusReason?.startsWith('dependency_') ?? false))
  );
}

/** Status a dependency-waiting task should have given its dependencies. */
export function readinessOf(deps: readonly Task[]): { status: TaskStatus; reason: string | null } {
  if (deps.some((d) => d.status === 'failed')) {
    return { status: 'blocked', reason: DEPENDENCY_REASONS.failed };
  }
  if (deps.some((d) => d.status === 'cancelled')) {
    return { status: 'blocked', reason: DEPENDENCY_REASONS.cancelled };
  }
  if (deps.some((d) => d.status === 'blocked')) {
    return { status: 'blocked', reason: DEPENDENCY_REASONS.blocked };
  }
  if (deps.every((d) => d.status === 'done')) return { status: 'ready', reason: null };
  return { status: 'pending', reason: null };
}

/**
 * Tasks and their dependency DAG (concept.md §9.2). Available as `ctx.service('tasks')`.
 *
 * Every status change goes through here so that dependents follow: a pending task whose
 * dependencies are all done becomes `ready`; one whose dependency failed / was cancelled /
 * is blocked becomes `blocked` (statusReason `dependency_*`) and returns to pending/ready
 * when that is resolved. Each change emits `task.updated` in the same transaction.
 */
export class TaskService {
  constructor(private readonly ctx: DaemonContext) {}

  get(taskId: string): Task {
    return this.ctx.repos.tasks.require(taskId);
  }

  create(p: Params<'task.create'>, actor: Actor): Task {
    const { ctx } = this;
    return ctx.db.transaction(() => {
      ctx.repos.projects.require(p.projectId);
      if (p.parentTaskId) {
        const parent = ctx.repos.tasks.get(p.parentTaskId);
        if (!parent) throw invalidParams(`unknown parentTaskId: ${p.parentTaskId}`);
        if (parent.projectId !== p.projectId) {
          throw invalidParams('parentTaskId belongs to a different project');
        }
      }
      const dependsOn = this.validateDeps(p.projectId, p.dependsOn, null);
      const { status, reason } = readinessOf(this.load(dependsOn));
      const now = ctx.clock.iso();
      const task = ctx.repos.tasks.insert({
        id: ctx.ids.next('task'),
        projectId: p.projectId,
        parentTaskId: p.parentTaskId ?? null,
        title: p.title.trim(),
        description: p.description,
        acceptanceCriteria: p.acceptanceCriteria,
        status,
        statusReason: reason,
        priority: p.priority,
        dependsOn,
        assigneeSessionId: null,
        workspaceId: null,
        resultSummary: null,
        createdBy: actor,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      });
      ctx.bus.emit({ type: 'task.created', actor, payload: { task } });
      return task;
    });
  }

  update(p: Params<'task.update'>, actor: Actor): Task {
    const { ctx } = this;
    return ctx.db.transaction(() => {
      const cur = ctx.repos.tasks.require(p.taskId);
      const now = ctx.clock.iso();
      const next: Task = { ...cur };
      const changes = new Set<string>();
      const assign = <K extends keyof Task>(key: K, value: Task[K] | undefined) => {
        if (value === undefined || JSON.stringify(cur[key]) === JSON.stringify(value)) return;
        next[key] = value;
        changes.add(key);
      };
      assign('title', p.title?.trim());
      assign('description', p.description);
      assign('acceptanceCriteria', p.acceptanceCriteria);
      assign('priority', p.priority);
      if (p.assigneeSessionId) ctx.repos.sessions.require(p.assigneeSessionId);
      assign('assigneeSessionId', p.assigneeSessionId);
      assign('resultSummary', p.resultSummary);
      if (p.dependsOn !== undefined) {
        assign('dependsOn', this.validateDeps(cur.projectId, p.dependsOn, cur.id));
      }
      if (p.status !== undefined && p.status !== cur.status) {
        if (p.status === 'ready') {
          const r = readinessOf(this.load(next.dependsOn));
          if (r.status !== 'ready') {
            throw invalidParams('cannot mark the task ready: some dependencies are not done yet');
          }
        }
        for (const c of applyStatus(next, p.status, null, now)) changes.add(c);
      }
      // Re-evaluate readiness when the dependencies changed or the task was put back to pending.
      if (isAutoManaged(next) && (changes.has('dependsOn') || p.status === 'pending')) {
        const r = readinessOf(this.load(next.dependsOn));
        for (const c of applyStatus(next, r.status, r.reason, now)) changes.add(c);
      }
      if (changes.size === 0) return cur;
      next.updatedAt = now;
      const task = ctx.repos.tasks.update(cur.id, () => next);
      ctx.bus.emit({ type: 'task.updated', actor, payload: { task, changes: [...changes] } });
      if (task.status !== cur.status) this.propagate(task);
      return task;
    });
  }

  /**
   * Set a task's status (used by workers / integration: running, review, done, failed ...).
   * No-op when nothing changes. Dependents are re-evaluated in the same transaction.
   */
  setStatus(
    taskId: string,
    status: TaskStatus,
    actor: Actor,
    reason?: string | null,
    /** Fields changed together with the status (e.g. the worker assignment). */
    patch: TaskStatusPatch = {},
  ): Task {
    const { ctx } = this;
    return ctx.db.transaction(() => {
      const cur = ctx.repos.tasks.require(taskId);
      const now = ctx.clock.iso();
      const next: Task = { ...cur };
      const changes = applyStatus(next, status, reason ?? null, now);
      for (const key of ['assigneeSessionId', 'workspaceId', 'resultSummary'] as const) {
        const value = patch[key];
        if (value === undefined || next[key] === value) continue;
        next[key] = value;
        changes.push(key);
      }
      if (changes.length === 0) return cur;
      next.updatedAt = now;
      const task = ctx.repos.tasks.update(cur.id, () => next);
      ctx.bus.emit({ type: 'task.updated', actor, payload: { task, changes } });
      if (task.status !== cur.status) this.propagate(task);
      return task;
    });
  }

  /**
   * Cancel a task, its unfinished subtasks, and their active runs. Dependents become
   * blocked (`dependency_cancelled`). Cancelling a done task is a conflict.
   */
  cancel(taskId: string, actor: Actor, reason?: string | null): Task {
    const { ctx } = this;
    const runIds: string[] = [];
    const task = ctx.db.transaction(() => {
      const cancelTree = (id: string, why: string | null): Task => {
        const cur = ctx.repos.tasks.require(id);
        if (cur.status === 'cancelled') return cur;
        if (cur.status === 'done') throw conflict(`task ${cur.id} is already done`);
        const updated = this.setStatus(id, 'cancelled', actor, why);
        for (const run of ctx.repos.runs.find({ where: { task_id: id } })) {
          if (!(TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status))
            runIds.push(run.id);
        }
        for (const sub of ctx.repos.tasks.find({
          where: { parent_task_id: id },
          direction: 'asc',
        })) {
          if (!isTerminalTaskStatus(sub.status)) cancelTree(sub.id, PARENT_CANCELLED);
        }
        return updated;
      };
      return cancelTree(taskId, reason ?? null);
    });
    // Runs are owned by the runs module; stop them after the task state is committed.
    if (runIds.length > 0 && ctx.hasService('runs')) {
      const runs = ctx.service('runs');
      for (const id of runIds) {
        try {
          runs.cancel(id, actor, 'task_cancelled');
        } catch (err) {
          ctx.log.warn('failed to cancel run of cancelled task', { runId: id, err });
        }
      }
    }
    return task;
  }

  /** Ready tasks of a project in the order they should be picked up (priority, then age). */
  readyTasks(projectId: string): Task[] {
    return this.ctx.repos.tasks
      .find({ where: { project_id: projectId, status: 'ready' } })
      .sort(compareTasks);
  }

  /**
   * Order tasks so that every task comes after the tasks it (transitively) depends on.
   * Independent tasks are ordered by priority, then age. Unknown ids → invalid_params.
   */
  topoOrder(taskIds: readonly string[]): Task[] {
    const ids = [...new Set(taskIds)];
    const tasks = new Map<string, Task>();
    for (const id of ids) {
      const t = this.ctx.repos.tasks.get(id);
      if (!t) throw invalidParams(`unknown task: ${id}`);
      tasks.set(id, t);
    }
    // Transitive dependencies within the requested set (paths may leave the set).
    const closure = new Map<string, Set<string>>();
    const reach = (id: string, stack: Set<string>): Set<string> => {
      const memo = closure.get(id);
      if (memo) return memo;
      if (stack.has(id)) throw conflict(`dependency cycle through task ${id}`);
      stack.add(id);
      const out = new Set<string>();
      const t = tasks.get(id) ?? this.ctx.repos.tasks.get(id);
      for (const dep of t?.dependsOn ?? []) {
        out.add(dep);
        for (const x of reach(dep, stack)) out.add(x);
      }
      stack.delete(id);
      closure.set(id, out);
      return out;
    };
    const remaining = new Map<string, Set<string>>();
    for (const id of ids) {
      remaining.set(id, new Set([...reach(id, new Set())].filter((d) => tasks.has(d))));
    }
    const ordered: Task[] = [];
    while (remaining.size > 0) {
      const free = [...remaining.entries()]
        .filter(([, deps]) => deps.size === 0)
        .map(([id]) => tasks.get(id)!)
        .sort(compareTasks);
      const pick = free[0];
      if (!pick) throw conflict('dependency cycle among tasks');
      ordered.push(pick);
      remaining.delete(pick.id);
      for (const deps of remaining.values()) deps.delete(pick.id);
    }
    return ordered;
  }

  /** Tasks that list `taskId` in dependsOn. */
  dependents(task: Pick<Task, 'id' | 'projectId'>): Task[] {
    return this.ctx.repos.tasks.find({
      where: { project_id: task.projectId },
      sql: {
        clause: "EXISTS (SELECT 1 FROM json_each(data, '$.dependsOn') WHERE value = ?)",
        params: [task.id],
      },
      direction: 'asc',
    });
  }

  // -------------------------------------------------------------------------

  /** Re-evaluate dependents of a task whose status changed (recursively via setStatus). */
  private propagate(task: Task): void {
    for (const dep of this.dependents(task)) {
      const cur = this.ctx.repos.tasks.require(dep.id);
      if (!isAutoManaged(cur)) continue;
      const r = readinessOf(this.load(cur.dependsOn));
      if (r.status !== cur.status || r.reason !== cur.statusReason) {
        this.setStatus(cur.id, r.status, SCHEDULER, r.reason);
      }
    }
  }

  private load(ids: readonly string[]): Task[] {
    return ids.map((id) => this.ctx.repos.tasks.get(id)).filter((t): t is Task => t !== undefined);
  }

  /**
   * Dedupe and validate dependencies: they must exist, be in the same project, and (for an
   * existing task) not lead back to it.
   */
  private validateDeps(
    projectId: string,
    deps: readonly string[],
    selfId: string | null,
  ): string[] {
    const unique = [...new Set(deps)];
    for (const id of unique) {
      if (id === selfId) throw invalidParams('a task cannot depend on itself');
      const t = this.ctx.repos.tasks.get(id);
      if (!t) throw invalidParams(`unknown task in dependsOn: ${id}`, { taskId: id });
      if (t.projectId !== projectId) {
        throw invalidParams(`dependency ${id} belongs to a different project`, { taskId: id });
      }
    }
    if (selfId) {
      const path = this.findPath(unique, selfId);
      if (path) {
        throw invalidParams(`dependsOn would create a cycle: ${[selfId, ...path].join(' -> ')}`, {
          cycle: [selfId, ...path],
        });
      }
    }
    return unique;
  }

  /** DFS along dependsOn from `starts`; returns the path to `target` if reachable. */
  private findPath(starts: readonly string[], target: string): string[] | null {
    const seen = new Set<string>();
    const visit = (id: string): string[] | null => {
      if (id === target) return [id];
      if (seen.has(id)) return null;
      seen.add(id);
      const t = this.ctx.repos.tasks.get(id);
      for (const dep of t?.dependsOn ?? []) {
        const p = visit(dep);
        if (p) return [id, ...p];
      }
      return null;
    };
    for (const s of starts) {
      const p = visit(s);
      if (p) return p;
    }
    return null;
  }
}

/** Apply a status (+ reason, completedAt) to `next` in place; returns the changed field names. */
function applyStatus(next: Task, status: TaskStatus, reason: string | null, now: string): string[] {
  const changes: string[] = [];
  if (next.status !== status) {
    next.status = status;
    changes.push('status');
  }
  if (next.statusReason !== reason) {
    next.statusReason = reason;
    changes.push('statusReason');
  }
  const completedAt = isTerminalTaskStatus(status) ? (next.completedAt ?? now) : null;
  if (next.completedAt !== completedAt) {
    next.completedAt = completedAt;
    changes.push('completedAt');
  }
  return changes;
}

declare module '../core/context' {
  interface Services {
    tasks: TaskService;
  }
}
