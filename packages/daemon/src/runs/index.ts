import { defineMethod } from '../api/registry';
import { conflict } from '../core/errors';
import { defineModule } from '../module';
import { RunManager } from './manager';

export { RunManager, ACTIVE_RUN_STATUSES, mergeUsage, toErrorInfo } from './manager';

const RETRYABLE = ['failed', 'cancelled', 'interrupted'] as const;

/**
 * Run lifecycle, concurrency queue and approvals (architecture.md §2.6).
 * Provides `ctx.service('runs')` (RunsService in contracts.ts) and the methods
 * run.list / run.get / run.cancel / run.retry / approval.list / approval.respond.
 * Startup recovery of stale runs is done by core/recovery.ts before modules start.
 */
export const runsModule = defineModule({
  name: 'runs',
  register(ctx) {
    const { repos } = ctx;
    const manager = new RunManager(ctx);
    ctx.provide('runs', manager);

    const runScope = (runId: string) => {
      const r = repos.runs.get(runId);
      return { projectIds: r?.projectId ? [r.projectId] : [] };
    };

    ctx.methods.register(
      defineMethod('run.list', {
        scope: (p) => ({ projectIds: p.projectId ? [p.projectId] : [] }),
        handler: (p) =>
          repos.runs.page({
            where: {
              session_id: p.sessionId,
              task_id: p.taskId,
              project_id: p.projectId,
              kind: p.kind,
              status: p.status,
            },
            direction: 'desc',
            limit: p.limit,
            cursor: p.cursor,
          }),
      }),

      defineMethod('run.get', {
        scope: (p) => runScope(p.runId),
        handler: (p) => repos.runs.require(p.runId),
      }),

      defineMethod('run.cancel', {
        scope: (p) => runScope(p.runId),
        handler: (p, call) => manager.cancel(p.runId, call.actor, p.reason),
      }),

      defineMethod('run.retry', {
        scope: (p) => runScope(p.runId),
        handler: (p, call) => {
          const prev = repos.runs.require(p.runId);
          if (!(RETRYABLE as readonly string[]).includes(prev.status)) {
            throw conflict('失敗・キャンセル・中断した Run だけを再試行できます', {
              status: prev.status,
            });
          }
          const run = manager.start({
            sessionId: prev.sessionId,
            kind: prev.kind,
            createdBy: call.actor,
            taskId: prev.taskId,
            projectId: prev.projectId,
            workspaceId: prev.workspaceId,
            parentRunId: prev.parentRunId,
            retryOfRunId: prev.id,
            model: prev.model,
            runtime: prev.runtime,
            budgetId: prev.budgetId,
            triggerMessageId: prev.triggerMessageId,
          });
          return { runId: run.id };
        },
      }),

      defineMethod('approval.list', {
        scope: (p) => ({ projectIds: p.projectId ? [p.projectId] : [] }),
        handler: (p) =>
          repos.approvals.page({
            where: {
              status: p.status,
              project_id: p.projectId,
              session_id: p.sessionId,
              run_id: p.runId,
            },
            direction: 'desc',
            limit: p.limit,
            cursor: p.cursor,
          }),
      }),

      defineMethod('approval.respond', {
        scope: (p) => {
          const ap = repos.approvals.get(p.approvalId);
          return { projectIds: ap?.projectId ? [ap.projectId] : [] };
        },
        handler: (p, call) =>
          manager.resolveApproval(
            p.approvalId,
            {
              decision: p.decision === 'approve' ? 'approved' : 'rejected',
              note: p.note ?? null,
            },
            call.actor,
          ),
      }),
    );

    // Slots and locks free up outside this module too (settings, workspace module).
    const off = ctx.bus.subscribe(
      { types: ['settings.updated', 'workspace.updated', 'workspace.removed'] },
      () => manager.pump(),
    );

    return {
      async stop() {
        off();
        await manager.stop();
      },
    };
  },
});
