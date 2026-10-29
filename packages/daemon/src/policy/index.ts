import { GrantPolicyEngine } from '../api/policy';
import { defineMethod } from '../api/registry';
import { forbidden } from '../core/errors';
import { defineModule } from '../module';
import { BudgetManager } from './budget';
import { PolicyService, isRunEndEvent } from './grants';

export { BudgetManager, freeUsd } from './budget';
export {
  PolicyService,
  RUN_ENDED,
  WORK_SETTLED,
  endsWithWork,
  type CreateGrantInput,
  type CreateGrantOptions,
} from './grants';
export { anyPatternContains, patternContains } from './patterns';

/**
 * Capability grants and budgets (architecture.md §2.4, §2.5).
 *
 * Methods: grant.create, grant.list, grant.revoke, budget.get, budget.allocate, budget.release.
 * Services: `policy` (PolicyService, also installed as `ctx.policy`), `budget` (BudgetManager).
 */
export const policyModule = defineModule({
  name: 'policy',
  migrations: [
    {
      id: 'policy/0001_budget_reservations',
      sql: `
CREATE TABLE budget_reservations (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  amount_micro INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX budget_reservations_budget ON budget_reservations(budget_id, status);
`,
    },
  ],
  register(ctx) {
    const policy = new PolicyService(ctx);
    const budget = new BudgetManager(ctx);
    ctx.provide('policy', policy);
    ctx.provide('budget', budget);
    // Keep an engine injected through createDaemon({ policy }) (tests); replace the default.
    if (ctx.policy instanceof GrantPolicyEngine) ctx.policy = policy;

    // Run grants end with their run; `work` grants once their session's tree settles.
    const unsubscribe = ctx.bus.subscribe({ types: ['run.*'] }, (e) => {
      const to = e.type === 'run.status_changed' ? e.payload.to : undefined;
      if (!isRunEndEvent(e.type, to) || !e.runId) return;
      const sessionId = e.sessionId ?? ctx.repos.runs.get(e.runId)?.sessionId ?? null;
      policy.expireForRun(e.runId, sessionId);
    });
    ctx.onClose(unsubscribe);
    const unsubscribeState = ctx.bus.subscribe({ types: ['session.state_changed'] }, (e) => {
      if (e.type === 'session.state_changed') policy.expireSettledWork(e.payload.sessionId);
    });
    ctx.onClose(unsubscribeState);

    ctx.methods.register(
      defineMethod('grant.create', {
        handler: (p, call) =>
          policy.createGrant(
            {
              subject: p.subject,
              permissions: p.permissions,
              scope: p.scope,
              limits: p.limits,
              lifetime: p.lifetime,
              expiresAt: p.expiresAt ?? null,
              parentGrantId: p.parentGrantId ?? null,
              reason: p.reason ?? null,
            },
            call.actor,
          ),
      }),

      defineMethod('grant.list', {
        handler: (p, call) => ({
          items: policy.list(
            {
              ...(p.runId ? { runId: p.runId } : {}),
              ...(p.sessionId ? { sessionId: p.sessionId } : {}),
              includeRevoked: p.includeRevoked,
            },
            call.actor,
          ),
        }),
      }),

      defineMethod('grant.revoke', {
        handler: (p, call) => policy.revoke(p.grantId, call.actor, p.reason ?? null),
      }),

      defineMethod('budget.get', {
        handler: (p, call) => {
          const b = budget.get(p.budgetId);
          return policy.audit(call.actor, 'budget.get', () => {
            if (call.actor.kind === 'agent' && !budget.canView(call.actor, b)) {
              throw forbidden(`budget ${b.id} is not visible to this run`);
            }
            return { budget: b, children: budget.children(b.id) };
          });
        },
      }),

      defineMethod('budget.allocate', {
        handler: (p, call) =>
          policy.audit(call.actor, 'budget.allocate', () =>
            p.parentId === null
              ? budget.createRoot({ subject: p.subject, limitUsd: p.limitUsd, actor: call.actor })
              : budget.allocate({
                  parentId: p.parentId,
                  subject: p.subject,
                  limitUsd: p.limitUsd,
                  actor: call.actor,
                }),
          ),
      }),

      defineMethod('budget.release', {
        handler: (p, call) =>
          policy.audit(call.actor, 'budget.release', () => budget.release(p.budgetId, call.actor)),
      }),
    );

    return {
      start() {
        const expired = policy.sweepEndedRuns();
        const cancelled = budget.cancelStaleReservations();
        if (expired > 0 || cancelled > 0) {
          ctx.log.info('policy startup cleanup', { expiredGrants: expired, cancelled });
        }
      },
    };
  },
});
