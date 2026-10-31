/**
 * T5 Cost: the usage ledger, summaries, budgets (spec 20261029 §1.10, §2.2, §3.8).
 * Schemas are fixed by the Core track; T5 implements them.
 */
import { z } from 'zod';
import { BudgetId, SessionId, Timestamp } from '../common';
import { BudgetAllocation, CostSource } from '../domain';
import { type MethodDef, params } from '../method';

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** What a ledger row is for: an LLM call, an agent runtime, the auto mode classifier, or a correction. */
export const LedgerComponent = z.enum(['llm', 'agent', 'classifier', 'adjust']);
export type LedgerComponent = z.infer<typeof LedgerComponent>;

export const CostRange = z.union([
  z.enum(['today', '7d', '30d']),
  z.object({ from: Timestamp, to: Timestamp }),
]);
export type CostRange = z.infer<typeof CostRange>;

export const CostGroupBy = z.enum(['day', 'project', 'root', 'model']);
export type CostGroupBy = z.infer<typeof CostGroupBy>;

export const CostSummary = z.object({
  totalUsd: z.number(),
  /** Some of the total is an estimate. */
  estimated: z.boolean(),
  rows: z.array(
    z.object({ key: z.string(), label: z.string(), usd: z.number(), estimated: z.boolean() }),
  ),
  daily: z.object({ limitUsd: z.number().nullable(), usedTodayUsd: z.number() }),
});
export type CostSummary = z.infer<typeof CostSummary>;

/** Who made an LLM call the daemon logged: the assistant, a supervisor, or a conversation. */
export const LlmCallRole = z.enum(['assistant', 'supervisor', 'chat']);
export type LlmCallRole = z.infer<typeof LlmCallRole>;

/**
 * One model call the daemon made (a chat, a supervisor, the assistant), as logged for later
 * analysis of cost and prompt caching. Agents (Claude Code) make their own calls: not here.
 */
export const LlmCall = z.object({
  id: z.int(),
  ts: Timestamp,
  runId: z.string().nullable(),
  sessionId: z.string().nullable(),
  rootSessionId: z.string().nullable(),
  role: LlmCallRole,
  /** 0 for the first call of a run (a tool loop makes several). */
  turn: z.int(),
  model: z.string(),
  provider: z.string(),
  status: z.enum(['ok', 'error', 'cancelled']),
  errorCode: z.string().nullable(),
  finishReason: z.string().nullable(),
  durationMs: z.int(),
  /** Until the first text or reasoning arrived; null when none did. */
  firstTokenMs: z.int().nullable(),
  /** All input, the cached part included. */
  inputTokens: z.int(),
  cacheReadTokens: z.int(),
  cacheWriteTokens: z.int(),
  outputTokens: z.int(),
  costUsd: z.number(),
  costSource: CostSource,
  /** Messages and tools sent. */
  messages: z.int(),
  tools: z.int(),
  /**
   * The part a prompt cache can hold for the next call: tools, the leading system messages and
   * the history up to the first later system message (`prefixMessages` messages). Short hashes.
   */
  toolsHash: z.string(),
  systemHash: z.string(),
  prefixMessages: z.int(),
  prefixHash: z.string(),
  /**
   * Whether this call starts with the previous call's cacheable part (same session and
   * model): false means the prompt itself changed in front (a cache miss of our making).
   * null for the first call of a session.
   */
  prefixContinues: z.boolean().nullable(),
  /** Since the previous call of the session (caches expire after a few minutes). */
  gapMs: z.int().nullable(),
});
export type LlmCall = z.infer<typeof LlmCall>;

/** Usage of one model in a range: spend from the ledger, calls from the call log. */
export const UsageStatsRow = z.object({
  model: z.string(),
  usd: z.number(),
  estimated: z.boolean(),
  inputTokens: z.int(),
  outputTokens: z.int(),
  /** Calls the daemon made (agents not counted), and how many failed. */
  calls: z.int(),
  failedCalls: z.int(),
  /** Calls whose cacheable part changed in front (prefixContinues false). */
  prefixBreaks: z.int(),
  /**
   * The prompt cache over the logged calls: their input, and the parts read from and written
   * to the cache. null without logged calls (an agent's model, or use before the log began).
   */
  cache: z
    .object({ inputTokens: z.int(), readTokens: z.int(), writeTokens: z.int() })
    .nullable(),
});
export type UsageStatsRow = z.infer<typeof UsageStatsRow>;

/** Use on one day of a range (agents included), for the chart of the days. */
export const UsageDay = z.object({
  /** YYYY-MM-DD in settings.limits.timezone. */
  day: z.string(),
  usd: z.number(),
  inputTokens: z.int(),
  outputTokens: z.int(),
  /** The day's spend per model (models that spent something), most first. */
  models: z.array(z.object({ model: z.string(), usd: z.number() })).default([]),
});
export type UsageDay = z.infer<typeof UsageDay>;

export const UsageStats = z.object({
  totalUsd: z.number(),
  estimated: z.boolean(),
  rows: z.array(UsageStatsRow),
  /** Every day of the range, oldest first, days without use at zero. */
  days: z.array(UsageDay),
});
export type UsageStats = z.infer<typeof UsageStats>;

export const BudgetThresholdPct = z.union([z.literal(50), z.literal(80), z.literal(100)]);

/** Today's spend against the daily limit (the setting plus any raise for today only). */
export const DailySpend = z.object({
  /** null: no daily limit. */
  limitUsd: z.number().nullable(),
  usedTodayUsd: z.number(),
  /** What `cost.raiseDaily` added for today (included in limitUsd). */
  raisedTodayUsd: z.number(),
  /** YYYY-MM-DD in settings.limits.timezone. */
  day: z.string(),
});
export type DailySpend = z.infer<typeof DailySpend>;

/**
 * Choice ids of the daemon's spend attentions (kind `budget`): the daily limit reached
 * (`cost.raiseDaily` +$10 for today, or open the settings) and the LiteLLM key's own budget
 * (nothing the app can raise; the item only tells).
 */
export const COST_ATTENTION_CHOICES = {
  daily: [
    { id: 'raise_today_10', label: '今日だけ +$10', tone: 'primary' },
    { id: 'open_settings', label: '設定', tone: 'neutral' },
  ],
  llmQuota: [],
} as const;

export const costDomain = {
  LedgerComponent,
  CostRange,
  CostGroupBy,
  CostSummary,
  BudgetThresholdPct,
  DailySpend,
  LlmCallRole,
  LlmCall,
  UsageStatsRow,
  UsageDay,
  UsageStats,
} as const;

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

export const costMethods = {
  'cost.summary': {
    params: params({
      range: CostRange.default('today'),
      groupBy: CostGroupBy.default('day'),
      rootSessionId: SessionId.optional().describe('Only this session tree'),
    }),
    result: CostSummary,
    description:
      'Spend so far, grouped by day, project, session tree or model, with the daily limit.',
  },
  'usage.stats': {
    params: params({ range: CostRange.default('30d') }),
    result: UsageStats,
    description:
      'Use per model in a range: spend, tokens (the part read from the prompt cache too) and model calls.',
    tool: false,
  },
  'usage.calls': {
    params: params({
      sessionId: SessionId.optional().describe('Only the calls of this session'),
      runId: z.string().optional(),
      limit: z.int().min(1).max(500).default(100),
    }),
    result: z.object({ calls: z.array(LlmCall) }),
    description:
      'The latest model calls the daemon made, newest first, with tokens, cache counts and what was cacheable.',
    tool: false,
  },
  'budget.raise': {
    params: params({ budgetId: BudgetId, addUsd: z.number().positive().max(10_000) }),
    result: BudgetAllocation,
    description:
      "Raise a budget's limit (a child budget is topped up from its parent). Humans only.",
    tool: false,
    mutates: true,
  },
  'cost.raiseDaily': {
    params: params({
      addUsd: z.number().positive().max(10_000).describe("Added to today's limit only"),
    }),
    result: DailySpend,
    description: "Raise today's spend limit (only for today; the setting stays). Humans only.",
    tool: false,
    mutates: true,
  },
  'session.setBudget': {
    params: params({
      sessionId: SessionId,
      limitUsd: z.number().positive().max(10_000).nullable().describe('null removes the budget'),
    }),
    result: z.object({ budget: BudgetAllocation.nullable() }),
    description: "Set (or remove) the budget of a session's tree. Humans only.",
    tool: false,
    mutates: true,
  },
} as const satisfies Record<string, MethodDef>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const costEvents = {
  /** At most once per second per session; also for every ancestor whose treeUsd changed. */
  'session.cost_updated': z.object({
    sessionId: SessionId,
    rootSessionId: SessionId,
    ownUsd: z.number(),
    treeUsd: z.number(),
    source: CostSource,
  }),
  'budget.threshold': z.object({
    budgetId: BudgetId,
    rootSessionId: SessionId.nullable(),
    pct: BudgetThresholdPct,
  }),
  'cost.limit_reached': z.object({
    scope: z.literal('daily'),
    usedUsd: z.number(),
    limitUsd: z.number(),
  }),
} as const;
