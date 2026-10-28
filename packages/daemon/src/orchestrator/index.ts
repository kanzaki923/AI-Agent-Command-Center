import { defineMethod } from '../api/registry';
import { defineModule } from '../module';
import { setupDemo } from './demo';
import { createOrchestratorExecutor } from './executor';
import { grantOrchestration, orchestrationGrants } from './grant';
import { MOCK_ORCHESTRATOR_MODEL, mockOrchestrator } from './mockModel';
import { waitForIntegration, waitForTasks } from './wait';
import { WorkerService, runEndedBy } from './workers';

export {
  buildOrchestratorPrompt,
  createOrchestratorExecutor,
  ORCHESTRATOR_MAX_TURNS,
} from './executor';
export { ORCHESTRATOR_PERMISSIONS, grantOrchestration, orchestrationGrants } from './grant';
export { MOCK_ORCHESTRATOR_MODEL, mockOrchestrator } from './mockModel';
export { DEMO_FILES, DEMO_SESSION_TITLE, DEMO_GOAL_HINT, setupDemo } from './demo';
export { taskSnapshot, waitForIntegration, waitForTasks } from './wait';
export {
  NO_CHANGES,
  ORCHESTRATION_SYSTEM,
  WORKER_DEFAULT_PERMISSIONS,
  WORKER_REASONS,
  WorkerService,
} from './workers';

declare module '../core/context' {
  interface Services {
    /** Workers: spawn for a task, follow their runs (task → review / failed). */
    workers: WorkerService;
  }
}

/**
 * Orchestrator (concept §2, §3.1): orchestration is a role, not a session type.
 *
 * - `session.grantOrchestration` gives a chat session the orchestrator preset; its next
 *   `session.send` then runs as kind `orchestrator` (system prompt + Control API tools from
 *   the same contract and dispatcher as humans).
 * - `task.spawnWorker` / `task.wait` / `integration.wait` are what an orchestrator (or a
 *   human) uses to delegate and supervise; `orchestrator.recordDecision` puts its judgement
 *   on the timeline. The daemon records its own decisions too (worker started, task → review).
 * - `mock/orchestrator` drives the whole vertical slice offline; `system.setupDemo` prepares
 *   demo mode around it.
 */
export const orchestratorModule = defineModule({
  name: 'orchestrator',
  register(ctx) {
    const workers = new WorkerService(ctx);
    ctx.provide('workers', workers);

    const taskScope = (taskIds: readonly string[]) => ({
      projectIds: [
        ...new Set(
          taskIds.map((id) => ctx.repos.tasks.get(id)?.projectId).filter((x): x is string => !!x),
        ),
      ],
    });

    ctx.methods.register(
      defineMethod('task.spawnWorker', {
        scope: (p) => taskScope([p.taskId]),
        handler: (p, call) => workers.spawn(p, call.actor),
      }),

      defineMethod('task.wait', {
        scope: (p) => taskScope(p.taskIds),
        handler: (p, call) => waitForTasks(ctx, p, call.signal),
      }),

      defineMethod('integration.wait', {
        scope: (p) => {
          const i = ctx.repos.integrations.get(p.integrationId);
          return { projectIds: i ? [i.projectId] : [] };
        },
        handler: (p, call) => waitForIntegration(ctx, p, call.signal),
      }),

      defineMethod('orchestrator.recordDecision', {
        // The tasks it is about, else the project the recording run works on.
        scope: (p, call) => {
          if (p.taskIds?.length) return taskScope(p.taskIds);
          const a = call.actor;
          if (a.kind !== 'agent') return { projectIds: [] };
          const run = ctx.repos.runs.get(a.runId);
          const projectId =
            run?.projectId ?? orchestrationGrants(ctx, a)[0]?.scope.projectIds?.[0] ?? null;
          return { projectIds: projectId ? [projectId] : [] };
        },
        handler: (p, call) => {
          const a = call.actor;
          const run = a.kind === 'agent' ? ctx.repos.runs.get(a.runId) : undefined;
          const taskProject = p.taskIds?.[0] ? ctx.repos.tasks.get(p.taskIds[0])?.projectId : null;
          workers.decide(
            {
              decision: p.decision,
              rationale: p.rationale,
              ...(p.taskIds ? { taskIds: p.taskIds } : {}),
            },
            {
              projectId: run?.projectId ?? taskProject ?? null,
              sessionId: a.kind === 'agent' ? a.sessionId : null,
              runId: a.kind === 'agent' ? a.runId : null,
              taskId: p.taskIds?.length === 1 ? p.taskIds[0]! : null,
            },
            a,
          );
          return { ok: true as const };
        },
      }),

      defineMethod('session.grantOrchestration', {
        scope: (p) => {
          const s = ctx.repos.sessions.get(p.sessionId);
          const projectId = p.projectId ?? s?.projectId;
          return { projectIds: projectId ? [projectId] : [] };
        },
        handler: (p, call) => grantOrchestration(ctx, p, call.actor),
      }),

      defineMethod('system.setupDemo', {
        handler: (p, call) => setupDemo(ctx, p, call.actor),
      }),
    );

    // Worker runs drive their task: completed → review, otherwise → failed.
    const unsubscribe = ctx.bus.subscribe({ types: ['run.status_changed'] }, (e) => {
      const runId = runEndedBy(e);
      if (!runId) return;
      const run = ctx.repos.runs.get(runId);
      if (!run) return;
      try {
        workers.onRunEnded(run);
      } catch (err) {
        ctx.log.error('failed to update the task of a finished worker', { runId, err });
      }
    });
    ctx.onClose(unsubscribe);

    return {
      start() {
        ctx.service('llm').mock.define(MOCK_ORCHESTRATOR_MODEL, mockOrchestrator, {
          label: 'モック（オーケストレーター）',
        });
        if (ctx.hasService('runs')) {
          ctx.service('runs').registerExecutor('orchestrator', createOrchestratorExecutor(ctx));
        }
        const fixed = workers.reconcile();
        if (fixed > 0) ctx.log.info('tasks of finished workers reconciled', { tasks: fixed });
      },
    };
  },
});
