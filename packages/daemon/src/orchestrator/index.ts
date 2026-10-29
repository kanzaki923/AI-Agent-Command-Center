import type { Actor } from '@acc/protocol';
import { defineMethod } from '../api/registry';
import { defineModule } from '../module';
import { setupDemo } from './demo';
import { createOrchestratorExecutor } from './executor';
import { grantOrchestration, orchestrationGrants } from './grant';
import { MOCK_ORCHESTRATOR_MODEL, mockOrchestrator } from './mockModel';
import { resumeAfterRestart, resumeInterruptedOrchestrators } from './resume';
import { waitForIntegration, waitForTasks } from './wait';
import { WorkerService, runEndedBy } from './workers';

export {
  buildOrchestratorPrompt,
  buildSupervisorPrompt,
  createOrchestratorExecutor,
  supervisorMessages,
  treeSnapshot,
  ORCHESTRATOR_MAX_TURNS,
  ORCHESTRATOR_RESUME_NOTICE,
  PROJECT_ID_LABEL,
  REPOSITORY_LABEL,
  TREE_HEADING,
} from './executor';
export {
  ORCHESTRATOR_PERMISSIONS,
  SUPERVISOR_CODE_PERMISSIONS,
  SUPERVISOR_PERMISSIONS,
  SUPERVISOR_SCHEDULE_PERMISSIONS,
  delegateSession,
  grantOrchestration,
  orchestrationGrants,
  supervisorGrantsOf,
  supervisorPermissions,
  undelegateSession,
} from './grant';
export { RESTART_RESUME_TEXT, resumeAfterRestart, type RestartReport } from './resume';
export { MOCK_ORCHESTRATOR_MODEL, mockOrchestrator } from './mockModel';
export {
  DEMO_FILES,
  DEMO_GOAL_HINT,
  DEMO_SCHEDULE_TITLE,
  DEMO_SESSION_TITLE,
  LAUNCH_DEMO_FILES,
  setupDemo,
} from './demo';
export { taskSnapshot, waitForIntegration, waitForTasks } from './wait';
export {
  NO_CHANGES,
  ORCHESTRATION_SYSTEM,
  WORKER_DEFAULT_PERMISSIONS,
  WORKER_REASONS,
  INTERRUPTED,
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
 * - `session.delegate` (sessions/methods/delegate.ts → grant.ts) makes a chat a supervisor:
 *   its runs are kind `orchestrator`, short and event-driven (executor.ts) — it starts
 *   children with session.spawn, answers, and is woken by its inbox (src/inbox) when they
 *   finish. After a restart, supervisors are woken and child agents resume once (resume.ts).
 * - The older preset (`session.grantOrchestration`: task.create / task.spawnWorker and the
 *   blocking task.wait / integration.wait, which the executor adds for it only) still runs
 *   the code vertical slice until that flow moves to session.spawn.
 * - `orchestrator.recordDecision` puts judgement on the timeline. The daemon records its
 *   own decisions too (worker started, task → review).
 * - `mock/orchestrator` drives both offline; `system.setupDemo` prepares demo mode.
 */
export const orchestratorModule = defineModule({
  name: 'orchestrator',
  register(ctx) {
    /** An agent run blocked in a long wait lends its execution slot (its workers need one). */
    const lendingSlot = async <T>(actor: Actor, wait: () => Promise<T>): Promise<T> => {
      const back =
        actor.kind === 'agent' && ctx.hasService('runs')
          ? ctx.service('runs').lendSlot(actor.runId)
          : () => undefined;
      try {
        return await wait();
      } finally {
        back();
      }
    };
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

      defineMethod('task.retry', {
        scope: (p) => taskScope([p.taskId]),
        handler: (p, call) => workers.retry(p, call.actor),
      }),

      defineMethod('integration.resolveWithAgent', {
        scope: (p) => {
          const i = ctx.repos.integrations.get(p.integrationId);
          return { projectIds: i ? [i.projectId] : [] };
        },
        handler: (p, call) => workers.resolveIntegration(p, call.actor),
      }),

      defineMethod('task.wait', {
        scope: (p) => taskScope(p.taskIds),
        handler: (p, call) => lendingSlot(call.actor, () => waitForTasks(ctx, p, call.signal)),
      }),

      defineMethod('integration.wait', {
        scope: (p) => {
          const i = ctx.repos.integrations.get(p.integrationId);
          return { projectIds: i ? [i.projectId] : [] };
        },
        handler: (p, call) =>
          lendingSlot(call.actor, () => waitForIntegration(ctx, p, call.signal)),
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

    let resumeTimer: NodeJS.Immediate | null = null;
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
        // After every module has started (integrations recover their interrupted attempts
        // in their own start hook): notify / resume orchestrators cut off by the last stop.
        resumeTimer = setImmediate(() => {
          resumeTimer = null;
          if (!ctx.hasService('runs')) return;
          const r = resumeInterruptedOrchestrators(ctx, workers);
          if (r.notified.length > 0) ctx.log.info('interrupted orchestrators handled', { ...r });
          if (!ctx.hasService('supervisorInbox')) return;
          const restart = resumeAfterRestart(ctx);
          if (restart.woken.length + restart.resumed.length > 0) {
            ctx.log.info('interrupted supervisors and children resumed', { ...restart });
          }
        });
      },
      stop() {
        if (resumeTimer) clearImmediate(resumeTimer);
      },
    };
  },
});
