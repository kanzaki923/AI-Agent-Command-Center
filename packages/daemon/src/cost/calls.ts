import { createHash } from 'node:crypto';
import type {
  CostRange,
  CostSource,
  LlmCall,
  LlmCallRole,
  Usage,
  UsageDay,
  UsageStats,
  UsageStatsRow,
} from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import type { SqlValue } from '../core/db';
import type { ChatMessage, ToolSpec } from '../llm/types';
import { dayOf, fromMicro, toMicro } from './ledger';
import { rangeWhere } from './summary';

/** What a ledger row without a model (an agent on the CLI's own default) is listed as. */
export const UNKNOWN_MODEL = 'モデル不明';

/** Days the call log keeps (older rows are deleted at start). */
export const CALL_LOG_DAYS = 90;

/** What the tool loop knows about one model call. */
export interface LlmCallInput {
  runId: string | null;
  sessionId: string | null;
  role: LlmCallRole;
  turn: number;
  model: string;
  provider: string;
  status: LlmCall['status'];
  errorCode?: string | null;
  finishReason?: string | null;
  startedAt: number;
  endedAt: number;
  firstTokenAt?: number | null;
  usage: Partial<Usage> | null;
  /** What was sent: the shape of the prompt is logged, not its text. */
  messages: readonly ChatMessage[];
  tools: readonly ToolSpec[];
}

interface CallRow {
  id: number;
  ts: string;
  run_id: string | null;
  session_id: string | null;
  root_session_id: string | null;
  role: LlmCallRole;
  turn: number;
  model: string;
  provider: string;
  status: LlmCall['status'];
  error_code: string | null;
  finish_reason: string | null;
  duration_ms: number;
  first_token_ms: number | null;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_micro: number;
  cost_source: CostSource;
  messages: number;
  tools: number;
  tools_hash: string;
  system_hash: string;
  prefix_messages: number;
  prefix_hash: string;
  prefix_continues: number | null;
  gap_ms: number | null;
}

const short = (h: ReturnType<typeof createHash>) => h.digest('hex').slice(0, 16);

/**
 * Hashes of a prompt's shape: the tools, the leading system messages, and a chain over the
 * messages (`chain[k]` covers the tools and the first k messages), so a later call can tell
 * whether it starts with an earlier one.
 */
export function promptShape(messages: readonly ChatMessage[], tools: readonly ToolSpec[]) {
  const toolsHash = short(createHash('sha256').update(JSON.stringify(tools)));
  const system = createHash('sha256');
  let leading = 0;
  while (messages[leading]?.role === 'system') {
    system.update(JSON.stringify(messages[leading]));
    leading++;
  }
  // The history up to the first later system message stays the same in the next call (the
  // status that changes per run goes after it).
  let prefix = messages.findIndex((m, i) => i >= leading && m.role === 'system');
  if (prefix === -1) prefix = messages.length;
  const chain = [toolsHash];
  for (const m of messages) {
    chain.push(short(createHash('sha256').update(chain.at(-1)!).update(JSON.stringify(m))));
  }
  return { toolsHash, systemHash: short(system), prefixMessages: prefix, chain };
}

/**
 * The LLM call log (`ctx.service('callLog')`, table `llm_calls`): one row per model call the
 * daemon makes, for analysing cost and prompt caching afterwards. A cache that stops working
 * shows nowhere else but in these rows: `prefix_continues` false is a prompt that changed in
 * front (our bug), true with no cache reads is the provider's side (or an expired cache,
 * see `gap_ms`). Prompt texts are not logged, only their hashes.
 */
export class CallLog {
  constructor(private readonly ctx: DaemonContext) {}

  record(input: LlmCallInput): void {
    const { ctx } = this;
    try {
      const shape = promptShape(input.messages, input.tools);
      const prev = input.sessionId ? this.lastOf(input.sessionId) : undefined;
      const continues =
        prev && prev.model === input.model && prev.prefix_messages <= input.messages.length
          ? shape.chain[prev.prefix_messages] === prev.prefix_hash
          : null;
      const ts = new Date(input.startedAt).toISOString();
      const session = input.sessionId ? ctx.repos.sessions.get(input.sessionId) : undefined;
      const u = input.usage ?? {};
      ctx.db.run(
        `INSERT INTO llm_calls (ts, day, run_id, session_id, root_session_id, role, turn, model,
           provider, status, error_code, finish_reason, duration_ms, first_token_ms,
           input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_micro,
           cost_source, messages, tools, tools_hash, system_hash, prefix_messages, prefix_hash,
           prefix_continues, gap_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ts,
          dayOf(ts, ctx.settings.get().limits.timezone),
          input.runId,
          input.sessionId,
          session?.rootSessionId ?? null,
          input.role,
          input.turn,
          input.model,
          input.provider,
          input.status,
          input.errorCode ?? null,
          input.finishReason ?? null,
          Math.max(0, Math.round(input.endedAt - input.startedAt)),
          input.firstTokenAt ? Math.max(0, Math.round(input.firstTokenAt - input.startedAt)) : null,
          Math.round(u.inputTokens ?? 0),
          Math.round(u.cacheReadTokens ?? 0),
          Math.round(u.cacheWriteTokens ?? 0),
          Math.round(u.outputTokens ?? 0),
          toMicro(u.costUsd ?? 0),
          u.costSource ?? 'unknown',
          input.messages.length,
          input.tools.length,
          shape.toolsHash,
          shape.systemHash,
          shape.prefixMessages,
          shape.chain[shape.prefixMessages]!,
          continues === null ? null : continues ? 1 : 0,
          prev ? Math.max(0, input.startedAt - Date.parse(prev.ts)) : null,
        ],
      );
    } catch (err) {
      // The log is for analysis: it never fails a call.
      ctx.log.warn('failed to log an LLM call', { err });
    }
  }

  private lastOf(sessionId: string): CallRow | undefined {
    return this.ctx.db.get<CallRow>(
      'SELECT * FROM llm_calls WHERE session_id = ? ORDER BY id DESC LIMIT 1',
      [sessionId],
    );
  }

  list(p: { sessionId?: string; runId?: string; limit: number }): LlmCall[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (p.sessionId) {
      where.push('session_id = ?');
      params.push(p.sessionId);
    }
    if (p.runId) {
      where.push('run_id = ?');
      params.push(p.runId);
    }
    params.push(p.limit);
    return this.ctx.db
      .all<CallRow>(
        `SELECT * FROM llm_calls ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY id DESC LIMIT ?`,
        params,
      )
      .map(toCall);
  }

  /**
   * Per model in a range: spend and tokens from the ledger (agents included), calls and the
   * prompt cache from this log (only calls it saw, so use from before it began does not
   * count as cache misses).
   */
  stats(range: CostRange): UsageStats {
    const { ctx } = this;
    const where = rangeWhere(range, ctx.clock.iso(), ctx.settings.get().limits.timezone);
    const spend = ctx.db.all<{
      model: string | null;
      micro: number;
      weak: number;
      input: number;
      output: number;
    }>(
      `SELECT model, SUM(cost_micro) AS micro,
              SUM(CASE WHEN source = 'reported' THEN 0 ELSE 1 END) AS weak,
              SUM(input_tokens) AS input, SUM(output_tokens) AS output
         FROM usage_ledger WHERE ${where.clause} GROUP BY model`,
      where.params,
    );
    const logged = new Map(
      ctx.db
        .all<{
          model: string;
          calls: number;
          failed: number;
          breaks: number;
          input: number;
          read: number;
          write: number;
        }>(
          `SELECT model, COUNT(*) AS calls,
                  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed,
                  SUM(CASE WHEN prefix_continues = 0 THEN 1 ELSE 0 END) AS breaks,
                  SUM(input_tokens) AS input, SUM(cache_read_tokens) AS read,
                  SUM(cache_write_tokens) AS write
             FROM llm_calls WHERE ${where.clause} GROUP BY model`,
          where.params,
        )
        .map((r) => [r.model, r]),
    );
    const fromLog = (model: string | null) => {
      const c = model ? logged.get(model) : undefined;
      if (model) logged.delete(model);
      return {
        calls: c?.calls ?? 0,
        failedCalls: c?.failed ?? 0,
        prefixBreaks: c?.breaks ?? 0,
        cache: c ? { inputTokens: c.input, readTokens: c.read, writeTokens: c.write } : null,
      };
    };
    const rows: UsageStatsRow[] = spend
      .filter((r) => r.micro !== 0 || r.input > 0 || r.output > 0)
      .map((r) => ({
        model: r.model ?? UNKNOWN_MODEL,
        usd: fromMicro(Math.max(0, r.micro)),
        estimated: r.weak > 0,
        inputTokens: Math.max(0, r.input),
        outputTokens: Math.max(0, r.output),
        ...fromLog(r.model),
      }));
    // Models whose calls all failed spent nothing but still show.
    for (const model of [...logged.keys()]) {
      rows.push({ model, usd: 0, estimated: false, inputTokens: 0, outputTokens: 0, ...fromLog(model) });
    }
    rows.sort((a, b) => b.usd - a.usd || b.inputTokens - a.inputTokens);
    return {
      totalUsd: rows.reduce((n, r) => n + r.usd, 0),
      estimated: rows.some((r) => r.estimated),
      rows,
      days: this.days(range, where),
    };
  }

  /**
   * Every day of the range with its spend and tokens (zero where nothing was used), and its
   * spend per model.
   */
  private days(range: CostRange, where: { clause: string; params: SqlValue[] }): UsageDay[] {
    const { ctx } = this;
    const tz = ctx.settings.get().limits.timezone;
    const used = new Map(
      ctx.db
        .all<{ day: string; micro: number; input: number; output: number }>(
          `SELECT day, SUM(cost_micro) AS micro, SUM(input_tokens) AS input,
                  SUM(output_tokens) AS output
             FROM usage_ledger WHERE ${where.clause} GROUP BY day`,
          where.params,
        )
        .map((r) => [r.day, r]),
    );
    const perModel = new Map<string, { model: string; usd: number }[]>();
    for (const r of ctx.db.all<{ day: string; model: string | null; micro: number }>(
      `SELECT day, model, SUM(cost_micro) AS micro
         FROM usage_ledger WHERE ${where.clause} GROUP BY day, model ORDER BY micro DESC`,
      where.params,
    )) {
      if (r.micro <= 0) continue;
      const list = perModel.get(r.day) ?? [];
      list.push({ model: r.model ?? UNKNOWN_MODEL, usd: fromMicro(r.micro) });
      perModel.set(r.day, list);
    }
    // The bounds as days: named ranges are already days, an explicit span is timestamps
    // (`to` exclusive). At most a year of days, counted back from the end.
    const [from, to] =
      typeof range === 'object'
        ? [dayOf(range.from, tz), dayOf(new Date(Date.parse(range.to) - 1).toISOString(), tz)]
        : (where.params as [string, string]);
    const end = Date.parse(to);
    const start = Math.max(Date.parse(from), end - 365 * 86_400_000);
    const out: UsageDay[] = [];
    for (let t = start; t <= end; t += 86_400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      const r = used.get(day);
      out.push({
        day,
        usd: fromMicro(Math.max(0, r?.micro ?? 0)),
        inputTokens: Math.max(0, r?.input ?? 0),
        outputTokens: Math.max(0, r?.output ?? 0),
        models: perModel.get(day) ?? [],
      });
    }
    return out;
  }

  /** Forget calls older than CALL_LOG_DAYS. */
  prune(): number {
    const cutoff = new Date(this.ctx.clock.now() - CALL_LOG_DAYS * 86_400_000).toISOString();
    return this.ctx.db.run('DELETE FROM llm_calls WHERE ts < ?', [cutoff]).changes;
  }
}

function toCall(r: CallRow): LlmCall {
  return {
    id: r.id,
    ts: r.ts,
    runId: r.run_id,
    sessionId: r.session_id,
    rootSessionId: r.root_session_id,
    role: r.role,
    turn: r.turn,
    model: r.model,
    provider: r.provider,
    status: r.status,
    errorCode: r.error_code,
    finishReason: r.finish_reason,
    durationMs: r.duration_ms,
    firstTokenMs: r.first_token_ms,
    inputTokens: r.input_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    outputTokens: r.output_tokens,
    costUsd: fromMicro(r.cost_micro),
    costSource: r.cost_source,
    messages: r.messages,
    tools: r.tools,
    toolsHash: r.tools_hash,
    systemHash: r.system_hash,
    prefixMessages: r.prefix_messages,
    prefixHash: r.prefix_hash,
    prefixContinues: r.prefix_continues === null ? null : r.prefix_continues === 1,
    gapMs: r.gap_ms,
  };
}
