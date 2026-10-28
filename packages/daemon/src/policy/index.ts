import { defineModule } from '../module';

/**
 * Capability grants and budgets (architecture.md §2.4, §2.5).
 *
 * Owns methods: grant.create, grant.list, grant.revoke, budget.get, budget.allocate, budget.release.
 *
 * TODO(policy):
 * - Replace `ctx.policy` with an engine that also enforces limits (maxWorkers, maxDepth)
 *   and delegation rules. The default GrantPolicyEngine (api/policy.ts) already matches
 *   permission patterns + project scope for agent actors; keep the PolicyEngine interface.
 * - grant.create: an agent may only delegate a subset of its own grant (permissions, scope,
 *   limits), depth = parent.depth + 1 <= settings.maxDelegationDepth. Humans create depth 0.
 * - grant.revoke cascades to descendants (parent_grant_id). Run-lifetime grants expire when
 *   the run reaches a terminal status (subscribe to run.* events).
 * - Budget service (`ctx.provide('budget', ...)`): allocate / reserve / spend / release with
 *   the invariant allocated + reserved + spent <= limit, all inside db.transaction. Emit
 *   budget.updated on every change. Unused amount returns to the parent on release.
 */
export const policyModule = defineModule({
  name: 'policy',
  register(_ctx) {
    // Not implemented yet. Methods owned by this module answer `not_found`
    // ({ reason: "not_implemented" }) until registered here.
  },
});
