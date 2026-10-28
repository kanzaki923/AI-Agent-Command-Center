import { type Actor, type AgentActor, type CapabilityGrant, matchAnyPattern } from '@acc/protocol';
import type { Clock } from '../core/clock';
import type { CallScope } from './registry';

export type PolicyDecision =
  { allowed: true; grantId: string | null } | { allowed: false; reason: string };

/**
 * Capability enforcement hook used by the dispatcher for every call.
 *
 * `scope` is undefined for global methods (no project involved) and a CallScope for
 * project-scoped methods; `projectIds: []` means "project-scoped but not narrowed"
 * (e.g. listing across all projects).
 *
 * The default implementation (GrantPolicyEngine) allows human/system actors and allows
 * agents only when an active grant matches. The policy module may replace `ctx.policy`
 * with a richer engine (limits, budget, delegation checks), keeping this interface.
 */
export interface PolicyEngine {
  check(actor: Actor, permission: string, scope: CallScope | undefined): PolicyDecision;
  /** Same decision without side effects such as auditing a denial (used to list LLM tools). */
  peek?(actor: Actor, permission: string, scope: CallScope | undefined): PolicyDecision;
}

/** Pure check of one grant against a permission + scope at time `nowIso`. */
export function grantAllows(
  grant: CapabilityGrant,
  permission: string,
  scope: CallScope | undefined,
  nowIso: string,
): { ok: true } | { ok: false; reason: string } {
  if (grant.revokedAt) return { ok: false, reason: 'grant revoked' };
  if (grant.expiresAt && grant.expiresAt <= nowIso) return { ok: false, reason: 'grant expired' };
  if (!matchAnyPattern(grant.permissions, permission)) {
    return { ok: false, reason: `permission "${permission}" not granted` };
  }
  const allowedProjects = grant.scope.projectIds;
  if (allowedProjects && scope) {
    if (scope.projectIds.length === 0) {
      return { ok: false, reason: 'grant is limited to specific projects; specify projectId' };
    }
    const outside = scope.projectIds.filter((p) => !allowedProjects.includes(p));
    if (outside.length > 0) {
      return { ok: false, reason: `project(s) outside grant scope: ${outside.join(', ')}` };
    }
  }
  return { ok: true };
}

/** Whether a grant's subject covers this agent actor. */
export function grantAppliesTo(grant: CapabilityGrant, actor: AgentActor): boolean {
  return grant.subject.kind === 'run'
    ? grant.subject.runId === actor.runId
    : grant.subject.sessionId === actor.sessionId;
}

/**
 * Default engine: human/system → allow; agent → allow iff some grant for its run/session
 * allows the permission in scope. Deny by default.
 */
export class GrantPolicyEngine implements PolicyEngine {
  constructor(
    private readonly grantsFor: (actor: AgentActor) => CapabilityGrant[],
    private readonly clock: Clock,
  ) {}

  check(actor: Actor, permission: string, scope: CallScope | undefined): PolicyDecision {
    if (actor.kind === 'human' || actor.kind === 'system') return { allowed: true, grantId: null };
    const now = this.clock.iso();
    const grants = this.grantsFor(actor).filter((g) => grantAppliesTo(g, actor));
    if (grants.length === 0) {
      return { allowed: false, reason: `no capability grant for this run (needs "${permission}")` };
    }
    const reasons: string[] = [];
    for (const g of grants) {
      const r = grantAllows(g, permission, scope, now);
      if (r.ok) return { allowed: true, grantId: g.id };
      reasons.push(r.reason);
    }
    return { allowed: false, reason: [...new Set(reasons)].join('; ') };
  }
}
