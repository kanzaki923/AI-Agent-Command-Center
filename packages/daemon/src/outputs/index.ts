import { defineMethod } from '../api/registry';
import { defineModule } from '../module';
import { Outputs } from './finalize';
import { publishArtifact } from './publish';
import { readArtifact } from './read';
import { onIntegrationUpdated, reviewArtifact } from './review';
import { artifactScope } from './scope';

export { Outputs, OUTPUTS_SYSTEM, lastAssistantText } from './finalize';
export { publishArtifact } from './publish';
export { readArtifact } from './read';
export { onIntegrationUpdated, releaseChildBudget, reviewArtifact } from './review';
export { trackedWrites } from './tracking';
export { asCurrentKind, storedKindsFor } from './legacy';
export { parseCsv, toCsv } from './csv';
export { artifactScope } from './scope';

/**
 * User-facing outputs (spec 20261029 §1.5, §3.4, §3.5; architecture.md §2.15):
 * `artifact.publish` / `read` / `review`, the `outputs` service (`finalize` when a child's run
 * ends), and the code process that follows integrations (applied → tasks done, outputs
 * accepted, budgets back; failures and pending approvals → attention).
 */
export const outputsModule = defineModule({
  name: 'outputs',
  register(ctx) {
    ctx.provide('outputs', new Outputs(ctx));
    ctx.methods.register(
      defineMethod('artifact.publish', {
        // The run's own session (an agent publishes into its own tree only).
        scope: (_p, call) => {
          if (call.actor.kind !== 'agent') return { projectIds: [] };
          const run = ctx.repos.runs.get(call.actor.runId);
          return {
            projectIds: run?.projectId ? [run.projectId] : [],
            sessionIds: [call.actor.sessionId],
          };
        },
        handler: (p, call) => publishArtifact(ctx, p, call.actor),
      }),
      defineMethod('artifact.read', {
        scope: (p) => artifactScope(ctx, p.artifactId),
        handler: (p) => readArtifact(ctx, p),
      }),
      defineMethod('artifact.review', {
        scope: (p) => artifactScope(ctx, p.artifactId),
        handler: (p, call) => reviewArtifact(ctx, p, call.actor),
      }),
    );

    const off = ctx.bus.subscribe({ types: ['integration.updated'] }, (e) => {
      if (e.type !== 'integration.updated') return;
      try {
        onIntegrationUpdated(ctx, e.payload.integration, e.payload.changes);
      } catch (err) {
        ctx.log.warn('outputs: following an integration failed', {
          integrationId: e.payload.integration.id,
          error: (err as Error).message,
        });
      }
    });
    ctx.onClose(off);
  },
});
