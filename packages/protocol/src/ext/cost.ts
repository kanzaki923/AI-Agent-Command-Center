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

export const BudgetThresholdPct = z.union([z.literal(50), z.literal(80), z.literal(100)]);

export const costDomain = {
  LedgerComponent,
  CostRange,
  CostGroupBy,
  CostSummary,
  BudgetThresholdPct,
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
      'Spend so far, grouped by day, project, session tree or model, with the daily limit. Agents see only their own tree.',
  },
  'budget.raise': {
    params: params({ budgetId: BudgetId, addUsd: z.number().positive().max(10_000) }),
    result: BudgetAllocation,
    description:
      "Raise a budget's limit (a child budget is topped up from its parent). Humans only.",
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
