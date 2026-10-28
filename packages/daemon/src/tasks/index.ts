import { defineMethod } from '../api/registry';
import { defineModule } from '../module';
import { TaskService } from './service';

export {
  DEPENDENCY_REASONS,
  PARENT_CANCELLED,
  TaskService,
  compareTasks,
  isTerminalTaskStatus,
  readinessOf,
} from './service';

/**
 * Tasks, dependency DAG and readiness (architecture.md §2.3, concept.md §9.2).
 *
 * Implemented: task.create, task.list, task.get, task.update, task.cancel.
 * Service: `tasks` (TaskService: setStatus, readyTasks, topoOrder, dependents).
 *
 * TODO(integration): task.spawnWorker / task.wait.
 * - task.spawnWorker: `ctx.service('policy').assertCanSpawnWorker(actor, { projectId })`
 *   right before `runs.start`; workspace (ctx.service('workspaces')) + worker session
 *   (kind "agent", parentSessionId = caller's session) + run (ctx.service('runs'),
 *   parentRunId = caller's run); delegate a child grant
 *   (`policy.createGrant(..., { via: 'task.spawnWorker' })` with the grant returned by the
 *   assert as parentGrantId) and budget (`budget.allocate`) from the caller when it is an
 *   agent; `tasks.setStatus(taskId, 'running', ...)`.
 * - task.wait: long poll. Check current state first, then `ctx.bus.waitFor` on task.updated
 *   with `call.signal` (aborted when the client disconnects) and the timeout.
 */
export const tasksModule = defineModule({
  name: 'tasks',
  register(ctx) {
    const { repos } = ctx;
    const tasks = new TaskService(ctx);
    ctx.provide('tasks', tasks);

    const taskScope = (taskId: string) => {
      const t = repos.tasks.get(taskId);
      return { projectIds: t ? [t.projectId] : [] };
    };

    ctx.methods.register(
      defineMethod('task.create', {
        scope: (p) => ({ projectIds: [p.projectId] }),
        handler: (p, call) => tasks.create(p, call.actor),
      }),

      defineMethod('task.list', {
        scope: (p) => {
          if (p.projectId) return { projectIds: [p.projectId] };
          // Subtasks share their parent's project.
          if (p.parentTaskId) return taskScope(p.parentTaskId);
          return { projectIds: [] };
        },
        handler: (p) =>
          repos.tasks.page({
            where: {
              project_id: p.projectId,
              parent_task_id: p.parentTaskId,
              assignee_session_id: p.assigneeSessionId,
              ...(p.status ? { status: p.status } : {}),
            },
            direction: 'asc',
            limit: p.limit,
            cursor: p.cursor,
          }),
      }),

      defineMethod('task.get', {
        scope: (p) => taskScope(p.taskId),
        handler: (p) => tasks.get(p.taskId),
      }),

      defineMethod('task.update', {
        scope: (p) => taskScope(p.taskId),
        handler: (p, call) => tasks.update(p, call.actor),
      }),

      defineMethod('task.cancel', {
        scope: (p) => taskScope(p.taskId),
        handler: (p, call) => tasks.cancel(p.taskId, call.actor, p.reason ?? null),
      }),
    );
  },
});
