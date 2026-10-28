import { defineModule } from '../module';

/**
 * Run lifecycle, concurrency queue and approvals (architecture.md §2.6).
 *
 * Owns methods: run.list, run.get, run.cancel, run.retry, approval.list, approval.respond.
 *
 * TODO(runs):
 * - RunManager service (`ctx.provide('runs', ...)`): create -> queued -> running ->
 *   completed/failed/cancelled; awaiting_approval in between. Emit run.created,
 *   run.status_changed, run.completed / run.failed. Keep session.activeRunId in sync
 *   via `ctx.service('sessions').setActiveRun`.
 * - At most settings.maxConcurrentRuns in `running`; the rest wait in `queued`.
 * - Workspace write lock: one running run per workspace (Workspace.lockedByRunId).
 * - Evaluate capability + budget at start; release reservations at the end.
 * - Startup recovery (running/queued/awaiting_approval -> interrupted) is already done in
 *   core/recovery.ts before modules start.
 */
export const runsModule = defineModule({
  name: 'runs',
  register(_ctx) {
    // Not implemented yet. Methods owned by this module answer `not_found`
    // ({ reason: "not_implemented" }) until registered here.
  },
});
