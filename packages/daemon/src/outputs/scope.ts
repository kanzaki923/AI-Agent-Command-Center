import type { CallScope } from '../api/registry';
import type { DaemonContext } from '../core/context';

/** What a call on one artifact touches: its project and (for agents' tree check) its session. */
export function artifactScope(ctx: DaemonContext, artifactId: string): CallScope {
  const a = ctx.repos.artifacts.get(artifactId);
  return {
    projectIds: a?.projectId ? [a.projectId] : [],
    ...(a?.sessionId ? { sessionIds: [a.sessionId] } : {}),
  };
}
