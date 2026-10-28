import { defineModule } from '../module';

/**
 * Integration Manager (concept.md §6).
 *
 * Owns methods: integration.create, integration.list, integration.get, integration.run,
 * integration.approve, integration.reject, artifact.list, artifact.get.
 *
 * TODO(integration):
 * - Integration branch per integration; merge task branches in order, append IntegrationStep
 *   entries (merge / verify / fix / apply) and emit integration.updated after each step.
 * - Verification (build/test) after merge; record test_result artifacts.
 * - Human approval (approval kind "integration") before applying to the target branch.
 * - On failure keep every worktree and branch; nothing is lost.
 */
export const integrationModule = defineModule({
  name: 'integration',
  register(_ctx) {
    // Not implemented yet. Methods owned by this module answer `not_found`
    // ({ reason: "not_implemented" }) until registered here.
  },
});
