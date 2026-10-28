import type { Clock } from '../core/clock';
import type { Db } from '../core/db';
import type { Migration } from '../core/migrations';
import type { UsageBaselineStore } from './claude/runtime';
import type { UsageTotals } from './claude/normalize';

/**
 * Runtime-owned persistent state:
 * - `runtime_sessions`: the runtime's own session id per (our session, runtime), used to resume
 *   the conversation on the next run. Keyed by runtime because a run may override the
 *   session's runtime, and one runtime's id means nothing to another.
 * - `runtime_usage_baselines`: the SDK's cumulative usage per runtime session, so a resumed
 *   run reports only its own usage (the SDK's totals continue across resumes).
 */
export const runtimeMigrations: Migration[] = [
  {
    id: 'runtime/0001_state',
    sql: `
CREATE TABLE runtime_sessions (
  session_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, runtime)
);

CREATE TABLE runtime_usage_baselines (
  runtime TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (runtime, runtime_session_id)
);
`,
  },
];

export class RuntimeSessionStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  get(sessionId: string, runtime: string): string | null {
    const row = this.db.get<{ runtime_session_id: string }>(
      'SELECT runtime_session_id FROM runtime_sessions WHERE session_id = ? AND runtime = ?',
      [sessionId, runtime],
    );
    return row?.runtime_session_id ?? null;
  }

  set(sessionId: string, runtime: string, runtimeSessionId: string): void {
    this.db.run(
      `INSERT INTO runtime_sessions (session_id, runtime, runtime_session_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (session_id, runtime)
       DO UPDATE SET runtime_session_id = excluded.runtime_session_id, updated_at = excluded.updated_at`,
      [sessionId, runtime, runtimeSessionId, this.clock.iso()],
    );
  }
}

export class DbBaselineStore implements UsageBaselineStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly runtime: string,
  ) {}

  get(runtimeSessionId: string): UsageTotals | undefined {
    const row = this.db.get<{ input_tokens: number; output_tokens: number; cost_usd: number }>(
      `SELECT input_tokens, output_tokens, cost_usd FROM runtime_usage_baselines
       WHERE runtime = ? AND runtime_session_id = ?`,
      [this.runtime, runtimeSessionId],
    );
    return row
      ? { inputTokens: row.input_tokens, outputTokens: row.output_tokens, costUsd: row.cost_usd }
      : undefined;
  }

  set(runtimeSessionId: string, t: UsageTotals): void {
    this.db.run(
      `INSERT INTO runtime_usage_baselines
         (runtime, runtime_session_id, input_tokens, output_tokens, cost_usd, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (runtime, runtime_session_id) DO UPDATE SET
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         cost_usd = excluded.cost_usd, updated_at = excluded.updated_at`,
      [this.runtime, runtimeSessionId, t.inputTokens, t.outputTokens, t.costUsd, this.clock.iso()],
    );
  }
}
