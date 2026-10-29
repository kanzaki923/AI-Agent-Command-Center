import { stubMethod } from '../api/registry';
import type { LedgerEntry, LedgerService } from '../contracts';
import type { DaemonContext } from '../core/context';
import { defineModule } from '../module';
import { backfillLedgerFromRuns, recomputeSessionCosts } from './backfill';
import { LedgerStore, dayOf, fromMicro } from './ledger';

export { LedgerStore, dayOf, fromMicro, toMicro, weakestSource, type LedgerRow } from './ledger';
export { backfillLedgerFromRuns, recomputeSessionCosts } from './backfill';

/**
 * Placeholder of the ledger (T5, architecture.md §2.17) until the Cost track lands: live
 * usage is not recorded yet (the startup backfill adds ended runs), today's total is read
 * from the table, and the daily limit is not enforced.
 */
export class StubLedger implements LedgerService {
  private readonly store: LedgerStore;

  constructor(private readonly ctx: DaemonContext) {
    this.store = new LedgerStore(ctx.db);
  }

  record(_entry: LedgerEntry): void {}

  usedToday(): number {
    const day = dayOf(this.ctx.clock.iso(), this.ctx.settings.get().limits.timezone);
    return fromMicro(this.store.dayTotalMicro(day));
  }

  assertDailyLeft(): void {}
}

/** Usage ledger, cost summaries and budget changes (T5, spec 20261029 §1.10, §3.8). */
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
  ],
  register(ctx) {
    ctx.provide('ledger', new StubLedger(ctx));
    ctx.methods.register(stubMethod('cost.summary'), stubMethod('budget.raise'));
    return {
      start() {
        const rows = backfillLedgerFromRuns(ctx);
        const sessions = recomputeSessionCosts(ctx);
        if (rows > 0 || sessions > 0) ctx.log.info('usage ledger backfilled', { rows, sessions });
      },
    };
  },
});
