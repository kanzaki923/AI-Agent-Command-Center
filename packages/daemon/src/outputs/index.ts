import type { Run } from '@acc/protocol';
import { stubMethod } from '../api/registry';
import type { FinalizeResult, OutputsService } from '../contracts';
import { defineModule } from '../module';

/**
 * Placeholder of the outputs service (T3, architecture.md §2.15): records nothing. The
 * worktree diff is still recorded by the agent executor as before.
 */
export class StubOutputs implements OutputsService {
  finalize(_run: Run): Promise<FinalizeResult> {
    return Promise.resolve({ needsReview: false, artifactIds: [] });
  }
}

/** User-facing outputs: publish, read, review (T3, spec 20261029 §1.5, §3.4, §3.5). */
export const outputsModule = defineModule({
  name: 'outputs',
  register(ctx) {
    ctx.provide('outputs', new StubOutputs());
    ctx.methods.register(
      stubMethod('artifact.publish'),
      stubMethod('artifact.read'),
      stubMethod('artifact.review'),
    );
  },
});
