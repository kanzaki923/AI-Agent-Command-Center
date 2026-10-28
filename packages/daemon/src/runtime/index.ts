import { defineModule } from '../module';

/**
 * Agent Runtime abstraction (architecture.md §2.3).
 *
 * TODO(runtime):
 * - `AgentRuntime` interface: start(run, workspace, prompt, tools) -> async stream of
 *   messages / tool calls / tool results / usage; cancel(); optional resume().
 * - Implementations: Claude Agent SDK (via LiteLLM), and a deterministic mock runtime for tests.
 * - Emit tool.called / tool.result events, persist messages via ctx.service('sessions').
 * - Dangerous tool uses become approvals (kind "tool_use") and put the run in awaiting_approval.
 * - Provide a runtime registry service: `ctx.provide('runtimes', ...)`.
 */
export const runtimeModule = defineModule({
  name: 'runtime',
  register(_ctx) {
    // Not implemented yet. Methods owned by this module answer `not_found`
    // ({ reason: "not_implemented" }) until registered here.
  },
});
