import { isTerminalRunStatus } from '@acc/protocol';
import { type CallScope, defineMethod } from '../api/registry';
import type { DaemonContext } from '../core/context';
import { defineModule } from '../module';
import { artifactScope } from '../outputs/scope';
import { ArtifactService } from './artifacts';
import { type IntegrationOptions, IntegrationService } from './service';

export { ArtifactService, MAX_TEST_OUTPUT_CHARS } from './artifacts';
export type { ArtifactRefs, RecordArtifactInput, ArtifactQuery } from './artifacts';
export { IntegrationService, DEFAULT_INTEGRATION_OPTIONS } from './service';
export type { IntegrationOptions } from './service';
export { runShellCommand, commandEnv } from './command';

declare module '../core/context' {
  interface Services {
    /** Record and read artifacts (diff / commit / test_result …). */
    artifacts: ArtifactService;
    /** Integration Manager (integration.* methods are thin wrappers around it). */
    integrations: IntegrationService;
  }
}

/**
 * What an artifact.list call touches, derived from whichever ref narrows it: the project, and
 * the sessions it names (an agent may only list inside its own session tree).
 */
function artifactListScope(
  ctx: DaemonContext,
  p: {
    projectId?: string;
    runId?: string;
    sessionId?: string;
    rootSessionId?: string;
    taskId?: string;
    workspaceId?: string;
  },
): CallScope {
  const run = p.runId ? ctx.repos.runs.get(p.runId) : undefined;
  const projectId =
    p.projectId ??
    run?.projectId ??
    (p.sessionId ? ctx.repos.sessions.get(p.sessionId)?.projectId : undefined) ??
    (p.taskId ? ctx.repos.tasks.get(p.taskId)?.projectId : undefined) ??
    (p.workspaceId ? ctx.repos.workspaces.get(p.workspaceId)?.projectId : undefined) ??
    undefined;
  const sessionIds = [p.sessionId, p.rootSessionId, run?.sessionId].filter((s): s is string => !!s);
  return {
    projectIds: projectId ? [projectId] : [],
    ...(sessionIds.length > 0 ? { sessionIds: [...new Set(sessionIds)] } : {}),
  };
}

/** Build the integration module (options are for tests: e.g. a short test timeout). */
export function createIntegrationModule(opts: Partial<IntegrationOptions> = {}) {
  return defineModule({
    name: 'integration',
    register(ctx) {
      const artifacts = new ArtifactService(ctx);
      const integrations = new IntegrationService(ctx, opts);
      ctx.provide('artifacts', artifacts);
      ctx.provide('integrations', integrations);

      const integrationScope = (integrationId: string) => {
        const i = ctx.repos.integrations.get(integrationId);
        return { projectIds: i ? [i.projectId] : [] };
      };

      ctx.methods.register(
        defineMethod('artifact.list', {
          scope: (p) => artifactListScope(ctx, p),
          handler: (p) => artifacts.list(p),
        }),

        defineMethod('artifact.get', {
          scope: (p) => artifactScope(ctx, p.artifactId),
          handler: (p) => artifacts.get(p.artifactId),
        }),

        defineMethod('integration.create', {
          scope: (p) => ({ projectIds: [p.projectId] }),
          handler: (p, call) => integrations.create({ ...p, actor: call.actor }),
        }),

        defineMethod('integration.list', {
          scope: (p) => ({ projectIds: p.projectId ? [p.projectId] : [] }),
          handler: (p) => integrations.list(p),
        }),

        defineMethod('integration.get', {
          scope: (p) => integrationScope(p.integrationId),
          handler: (p) => integrations.get(p.integrationId),
        }),

        defineMethod('integration.run', {
          scope: (p) => integrationScope(p.integrationId),
          handler: (p, call) => integrations.run(p.integrationId, call.actor),
        }),

        defineMethod('integration.approve', {
          scope: (p) => integrationScope(p.integrationId),
          // Human-only regardless of grants; enforced inside the service as well.
          handler: (p, call) => integrations.approve(p.integrationId, call.actor, p.note),
        }),

        defineMethod('integration.reject', {
          scope: (p) => integrationScope(p.integrationId),
          handler: (p, call) => integrations.reject(p.integrationId, call.actor, p.note),
        }),
      );

      // An integrator run ending resumes (or gives back) its integration.
      const off = ctx.bus.subscribe({ types: ['run.status_changed'] }, (e) => {
        if (e.type !== 'run.status_changed' || !isTerminalRunStatus(e.payload.to)) return;
        const run = ctx.repos.runs.get(e.payload.runId);
        if (run) integrations.onRunEnded(run);
      });
      ctx.onClose(off);

      return {
        start() {
          const recovered = integrations.recoverOnStart();
          if (recovered.length > 0) {
            ctx.log.warn('integrations interrupted by a restart were marked failed', { recovered });
          }
        },
        stop: () => integrations.stop(),
      };
    },
  });
}

/**
 * Integration Manager (concept.md §6) and artifacts.
 *
 * Methods: integration.create / list / get / run / approve / reject, artifact.list / get.
 * Services: `integrations`, `artifacts`.
 */
export const integrationModule = createIntegrationModule();
