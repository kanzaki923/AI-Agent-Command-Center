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
  type TaskStatusPatch,
} from './service';

/**
 * Tasks, dependency DAG and readiness (architecture.md §2.3, concept.md §9.2).
 *
 * Implemented: task.create, task.list, task.get, task.update, task.cancel.
 * Service: `tasks` (TaskService: setStatus, readyTasks, topoOrder, dependents).
 * task.spawnWorker / task.wait live in the orchestrator module (they combine workspaces,
 * sessions, runs and policy).
 */
export const tasksModule = defineModule({
  name: 'tasks',
  register(ctx) {
    const { repos } = ctx;
    const tasks = new TaskService(ctx);
    ctx.provide('tasks', tasks);

    const taskScope = (taskId: string) => {
      const t = repos.tasks.get(taskId);
      return { projectIds: t?.projectId ? [t.projectId] : [] };
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
