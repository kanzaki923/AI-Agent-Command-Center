import type { Actor } from '@acc/protocol';
import { defineMethod } from '../api/registry';
import { forbidden } from '../core/errors';
import type { DaemonContext } from '../core/context';
import { defineModule } from '../module';
import { ownTreeOnly } from '../policy/grants';
import { backfillLedgerFromRuns, recomputeSessionCosts } from './backfill';
import { BudgetReturns } from './returns';
import { COST_SYSTEM, UsageLedger } from './service';
import { CallLog } from './calls';
import { costSummary } from './summary';

/** The whole-app usage is not one tree's: only a human, or an agent that sees every tree. */
function humansOrAll(ctx: DaemonContext, actor: Actor): void {
  if (actor.kind === 'agent' && ownTreeOnly(ctx, actor)) {
    throw forbidden('利用統計を見られるのは人間と右腕だけです');
  }
}

export { LedgerStore, dayOf, fromMicro, toMicro, weakestSource, type LedgerRow } from './ledger';
export { backfillLedgerFromRuns, recomputeSessionCosts } from './backfill';
export { UsageLedger, COST_SYSTEM, DAILY_LIMIT } from './service';
export { BudgetReturns } from './returns';
export { costSummary, rangeWhere } from './summary';
export { CALL_LOG_DAYS, CallLog, promptShape, type LlmCallInput } from './calls';
export { KeyedThrottle } from './throttle';
export { setSessionBudget } from './sessionBudget';

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Attentions for runs that ended for money (spec 20261029 §3.4, §3.8-7/9): a used-up budget
 * (one per budget: +$1 / +$5 / stop), and LiteLLM's own key budget (one for everything).
 * The daily limit notifies itself when it refuses (UsageLedger.assertDailyLeft).
 */
/** A settings change that can move the daily limit (`limits` / `limits.dailyUsd`). */
function isLimitChange(key: string): boolean {
  return key === 'limits' || key.startsWith('limits.');
}

function watchSpendFailures(ctx: DaemonContext, ledger: UsageLedger): () => void {
  return ctx.bus.subscribe({ types: ['run.status_changed'] }, (e) => {
    if (e.type !== 'run.status_changed' || e.payload.to !== 'failed') return;
    const run = ctx.repos.runs.get(e.payload.runId);
    if (!run) return;
    if (run.error?.code === 'llm_quota_exceeded') {
      ledger.notifyLlmQuota(run.sessionId, run.error.message);
      return;
    }
    if (e.payload.reason !== 'budget_exhausted' || !run.budgetId) return;
    const budget = ctx.repos.budgets.get(run.budgetId);
    if (!budget || !ctx.hasService('attention')) return;
    try {
      ctx.service('attention').open({
        kind: 'budget',
        sessionId: run.sessionId,
        title: `予算（${usd(budget.limitUsd)}）の上限に達しました`,
        detail:
          budget.allocatedUsd + budget.reservedUsd > 0
            ? `使用額は ${usd(budget.spentUsd)}、子に渡した分が ${usd(budget.allocatedUsd + budget.reservedUsd)} です。予算を増やすと続けられます。`
            : `使用額は ${usd(budget.spentUsd)} です。予算を増やすと続けられます。`,
        refs: { budgetId: budget.id },
        actor: COST_SYSTEM,
      });
    } catch (err) {
      ctx.log.error('failed to open the budget attention', { runId: run.id, err });
    }
  });
}

/**
 * Usage ledger, cost summaries, the daily limit and budget changes (T5, spec 20261029 §1.10,
 * §3.8; architecture.md §2.17). Service: `ledger` (UsageLedger). Methods: cost.summary,
 * cost.raiseDaily, budget.raise (session.setBudget lives in sessions/methods).
 */
export const costModule = defineModule({
  name: 'cost',
  migrations: [
    {
      id: 'cost/0001_ledger',
      sql: `
CREATE TABLE usage_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  session_id TEXT,
  root_session_id TEXT,
  project_id TEXT,
  run_id TEXT,
  model TEXT,
  component TEXT NOT NULL,
  cost_micro INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL
);
CREATE INDEX usage_ledger_day ON usage_ledger(day);
CREATE INDEX usage_ledger_root ON usage_ledger(root_session_id);
CREATE INDEX usage_ledger_session ON usage_ledger(session_id);
CREATE INDEX usage_ledger_run ON usage_ledger(run_id);
`,
    },
    {
      id: 'cost/0002_daily',
      sql: `
CREATE TABLE cost_daily_raises (
  day TEXT PRIMARY KEY,
  extra_micro INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE cost_notices (
  key TEXT PRIMARY KEY,
  attention_id TEXT,
  created_at TEXT NOT NULL
);
`,
    },
    {
      // How much input came from the prompt cache (older rows: unknown, counted as none).
      id: 'cost/0003_cache_tokens',
      sql: `
ALTER TABLE usage_ledger ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_ledger ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
`,
    },
    {
      // One row per model call the daemon makes (cost/calls.ts), kept CALL_LOG_DAYS.
      id: 'cost/0004_llm_calls',
      sql: `
CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  run_id TEXT,
  session_id TEXT,
  root_session_id TEXT,
  role TEXT NOT NULL,
  turn INTEGER NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  finish_reason TEXT,
  duration_ms INTEGER NOT NULL,
  first_token_ms INTEGER,
  input_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_micro INTEGER NOT NULL,
  cost_source TEXT NOT NULL,
  messages INTEGER NOT NULL,
  tools INTEGER NOT NULL,
  tools_hash TEXT NOT NULL,
  system_hash TEXT NOT NULL,
  prefix_messages INTEGER NOT NULL,
  prefix_hash TEXT NOT NULL,
  prefix_continues INTEGER,
  gap_ms INTEGER
);
CREATE INDEX llm_calls_session ON llm_calls(session_id, id);
CREATE INDEX llm_calls_day ON llm_calls(day);
CREATE INDEX llm_calls_run ON llm_calls(run_id);
`,
    },
  ],
  register(ctx) {
    const ledger = new UsageLedger(ctx);
    ctx.provide('ledger', ledger);
    const callLog = new CallLog(ctx);
    ctx.provide('callLog', callLog);
    ctx.onClose(() => ledger.close());

    ctx.methods.register(
      defineMethod('cost.summary', {
        scope: (p, call) => {
          const sessionId =
            p.rootSessionId ?? (ownTreeOnly(ctx, call.actor) ? call.actor.sessionId : undefined);
          return { projectIds: [], ...(sessionId ? { sessionIds: [sessionId] } : {}) };
        },
        handler: (p, call) =>
          costSummary(ctx, ledger, {
            range: p.range,
            groupBy: p.groupBy,
            // Agents see only their own tree (the scope above checked rootSessionId); the
            // assistant sees everything.
            subtreeOf:
              p.rootSessionId ?? (ownTreeOnly(ctx, call.actor) ? call.actor.sessionId : null),
          }),
      }),

      defineMethod('usage.stats', {
        handler: (p, call) => {
          humansOrAll(ctx, call.actor);
          return callLog.stats(p.range);
        },
      }),

      defineMethod('usage.calls', {
        handler: (p, call) => {
          humansOrAll(ctx, call.actor);
          return {
            calls: callLog.list({
              ...(p.sessionId ? { sessionId: p.sessionId } : {}),
              ...(p.runId ? { runId: p.runId } : {}),
              limit: p.limit,
            }),
          };
        },
      }),

      defineMethod('cost.raiseDaily', {
        handler: (p, call) => ledger.raiseToday(p.addUsd, call.actor),
      }),

      defineMethod('budget.raise', {
        handler: (p, call) => {
          if (call.actor.kind === 'agent') throw forbidden('予算を増やせるのは人間だけです');
          return ctx.service('budget').raise(p.budgetId, p.addUsd, call.actor);
        },
      }),
    );

    const returns = new BudgetReturns(ctx);
    return {
      start() {
        const pruned = callLog.prune();
        if (pruned > 0) ctx.log.info('old LLM calls pruned', { rows: pruned });
        const rows = backfillLedgerFromRuns(ctx);
        const sessions = recomputeSessionCosts(ctx);
        if (rows > 0 || sessions > 0) ctx.log.info('usage ledger backfilled', { rows, sessions });
        ctx.onClose(watchSpendFailures(ctx, ledger));
        // A daily limit changed in the settings may give today room again.
        ctx.onClose(
          ctx.bus.subscribe({ types: ['settings.updated'] }, (e) => {
            if (e.type === 'settings.updated' && e.payload.changes.some(isLimitChange)) {
              ledger.resolveDailyNotices(e.actor);
            }
          }),
        );
        returns.start();
      },
    };
  },
});
