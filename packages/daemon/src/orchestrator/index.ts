import { defineModule } from '../module';

/**
 * Orchestrator: LLM tools generated from the Control API (architecture.md §2.4).
 *
 * TODO(orchestrator):
 * - Generate LLM tool definitions from `@acc/protocol` `api` entries with `tool: true`
 *   (name, description, `z.toJSONSchema(spec.params, { io: 'input' })`), filtered by the
 *   run's capability grants.
 * - Execute tool calls with `ctx.call({ kind: 'agent', sessionId, runId }, method, params)`
 *   — the dispatcher enforces grants, so never bypass it.
 * - Orchestrator runs (Run.kind "orchestrator"): plan -> create tasks -> spawn workers ->
 *   task.wait -> review -> integration. Record judgements as orchestrator.decision events.
 */
export const orchestratorModule = defineModule({
  name: 'orchestrator',
  register(_ctx) {
    // Not implemented yet. Methods owned by this module answer `not_found`
    // ({ reason: "not_implemented" }) until registered here.
  },
});
