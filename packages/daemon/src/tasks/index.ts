import { defineModule } from '../module';

/**
 * Tasks, dependency DAG and scheduling (architecture.md §2.3, concept.md §9.2).
 *
 * Owns methods: task.create, task.list, task.get, task.update, task.cancel, task.spawnWorker, task.wait.
 *
 * TODO(tasks):
 * - Validate dependsOn (same project, no cycles). pending -> ready when all deps are done.
 * - task.spawnWorker: workspace (ctx.service('workspaces')) + worker session (kind "agent",
 *   parentSessionId = caller's session) + run (ctx.service('runs')); delegate a child grant
 *   and budget from the caller when the caller is an agent.
 * - task.wait: long poll. Check current state first, then `ctx.bus.waitFor` on task.updated
 *   with `call.signal` (aborted when the client disconnects) and the timeout.
 * - Emit task.created / task.updated (with `changes`).
 */
export const tasksModule = defineModule({
  name: 'tasks',
  register(_ctx) {
    // Not implemented yet. Methods owned by this module answer `not_found`
    // ({ reason: "not_implemented" }) until registered here.
  },
});
