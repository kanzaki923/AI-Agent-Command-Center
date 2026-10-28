import { defineModule } from '../module';

/**
 * Git worktree management (architecture.md §2.3).
 *
 * Owns methods: workspace.create, workspace.list, workspace.get, workspace.remove, workspace.diff.
 *
 * TODO(workspace):
 * - Create worktrees under `ctx.paths.worktrees` from project.repoPath (git CLI via
 *   child_process.execFile, never a shell string). Branch naming: `acc/<task-or-ws-id>`.
 * - workspace.diff: diff against baseRef including uncommitted changes (stats + per-file).
 * - Locks: Workspace.lockedByRunId; refuse concurrent writers with `conflict`.
 * - Emit workspace.created / workspace.updated / workspace.removed.
 * - Provide `ctx.provide('workspaces', ...)` for tasks/integration/runtime.
 */
export const workspaceModule = defineModule({
  name: 'workspace',
  register(_ctx) {
    // Not implemented yet. Methods owned by this module answer `not_found`
    // ({ reason: "not_implemented" }) until registered here.
  },
});
