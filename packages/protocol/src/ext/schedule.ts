/**
 * T6 Schedules: recurring work attached to a session (spec 20261029 §1.9, §2.2, §3.11).
 * Schemas are fixed by the Core track; T6 implements them.
 */
import { z } from 'zod';
import { Actor, ScheduleId, SessionId, Timestamp } from '../common';
import { WorkspaceSpec } from '../domain';
import { type MethodDef, Ok, params } from '../method';

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** Five-field cron expression, e.g. "0 9 * * 1-5". */
const CronExpr = z.string().min(9).max(200);
/** IANA time zone, e.g. "Asia/Tokyo". */
const TimeZone = z.string().min(1).max(100);

export const ScheduleTrigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cron'), expr: CronExpr, tz: TimeZone }),
  z.object({ kind: z.literal('once'), at: Timestamp }),
]);
export type ScheduleTrigger = z.infer<typeof ScheduleTrigger>;

/** Trigger as accepted by the API: a cron trigger without `tz` uses settings.limits.timezone. */
export const ScheduleTriggerInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cron'), expr: CronExpr, tz: TimeZone.optional() }),
  z.object({ kind: z.literal('once'), at: Timestamp }),
]);
export type ScheduleTriggerInput = z.infer<typeof ScheduleTriggerInput>;

export const ScheduleRunSpec = z.object({
  mode: z.enum(['chat', 'agent']),
  workspace: WorkspaceSpec,
  model: z.string().nullable(),
  /** Budget per firing (USD). */
  budgetUsd: z.number().positive(),
  /** The fired child may lead children of its own. Only humans may set it. */
  supervise: z.boolean(),
  /** Attach the previous firing's main output to the request. */
  includePrevious: z.boolean(),
});
export type ScheduleRunSpec = z.infer<typeof ScheduleRunSpec>;

export const DEFAULT_SCHEDULE_RUN: ScheduleRunSpec = {
  mode: 'agent',
  workspace: { kind: 'none' },
  model: null,
  budgetUsd: 1,
  supervise: false,
  includePrevious: true,
};

export const ScheduleCatchUp = z.enum(['latest', 'skip']);
export type ScheduleCatchUp = z.infer<typeof ScheduleCatchUp>;

export const ScheduleOutcome = z.enum(['started', 'skipped_overlap', 'missed', 'failed_to_start']);
export type ScheduleOutcome = z.infer<typeof ScheduleOutcome>;

export const ScheduleLastRun = z.object({
  scheduledFor: Timestamp,
  firedAt: Timestamp,
  sessionId: SessionId.nullable(),
  outcome: ScheduleOutcome,
  error: z.string().nullable(),
});
export type ScheduleLastRun = z.infer<typeof ScheduleLastRun>;

export const Schedule = z.object({
  id: ScheduleId,
  /** Owner session; every firing becomes a child of it. */
  sessionId: SessionId,
  title: z.string(),
  /** The request sent on every firing. */
  prompt: z.string(),
  trigger: ScheduleTrigger,
  run: ScheduleRunSpec,
  catchUp: ScheduleCatchUp,
  /** A missed firing still runs at startup when it is at most this late. */
  maxLatenessMin: z.int().nonnegative(),
  enabled: z.boolean(),
  nextRunAt: Timestamp.nullable(),
  lastRun: ScheduleLastRun.nullable(),
  expiresAt: Timestamp.nullable(),
  createdBy: Actor,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Schedule = z.infer<typeof Schedule>;

export const scheduleDomain = {
  ScheduleTrigger,
  ScheduleTriggerInput,
  ScheduleRunSpec,
  DEFAULT_SCHEDULE_RUN,
  ScheduleCatchUp,
  ScheduleOutcome,
  ScheduleLastRun,
  Schedule,
} as const;

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

const RunInput = params({
  mode: z.enum(['chat', 'agent']).optional(),
  workspace: WorkspaceSpec.optional(),
  model: z.string().min(1).nullable().optional(),
  budgetUsd: z.number().positive().max(1000).optional(),
  supervise: z.boolean().optional(),
  includePrevious: z.boolean().optional(),
});

const scheduleFields = {
  title: z.string().min(1).max(80).optional(),
  trigger: ScheduleTriggerInput,
  run: RunInput.optional(),
  catchUp: ScheduleCatchUp.optional().describe('latest (default): run the latest missed firing'),
  maxLatenessMin: z.int().min(0).max(10_080).optional().describe('Default 720 (12 hours)'),
  enabled: z.boolean().optional(),
  expiresAt: Timestamp.optional(),
};

export const scheduleMethods = {
  'schedule.create': {
    params: params({
      sessionId: SessionId.describe('Owner session (the firings become its children)'),
      prompt: z.string().min(1).max(50_000),
      ...scheduleFields,
    }),
    result: Schedule,
    description:
      'Repeat a request on a schedule (cron with a time zone, or once). Each firing starts a new child of the owner session with the prompt as its goal.',
    mutates: true,
  },
  'schedule.list': {
    params: params({
      sessionId: SessionId.optional(),
      rootSessionId: SessionId.optional(),
      enabled: z.boolean().optional(),
    }),
    result: z.object({ items: z.array(Schedule) }),
    description: 'List schedules, soonest next run first.',
  },
  'schedule.get': {
    params: params({ scheduleId: ScheduleId }),
    result: Schedule,
    description: 'Get a schedule.',
  },
  'schedule.update': {
    params: params({
      scheduleId: ScheduleId,
      prompt: z.string().min(1).max(50_000).optional(),
      ...scheduleFields,
      trigger: ScheduleTriggerInput.optional(),
      expiresAt: Timestamp.nullable().optional(),
    }),
    result: Schedule,
    description: 'Change a schedule (only the given fields).',
    mutates: true,
  },
  'schedule.delete': {
    params: params({ scheduleId: ScheduleId }),
    result: Ok,
    description: 'Delete a schedule. Sessions it already started are kept.',
    mutates: true,
  },
  'schedule.runNow': {
    params: params({ scheduleId: ScheduleId }),
    result: z.object({ sessionId: SessionId }),
    description: 'Fire a schedule once now (its regular times are unchanged).',
    mutates: true,
  },
  'schedule.preview': {
    params: params({ trigger: ScheduleTriggerInput, count: z.int().min(1).max(10).default(5) }),
    result: z.object({ times: z.array(Timestamp) }),
    description: 'The next times a trigger would fire (to check a cron expression).',
  },
} as const satisfies Record<string, MethodDef>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const scheduleEvents = {
  'schedule.created': z.object({ schedule: Schedule }),
  'schedule.updated': z.object({ schedule: Schedule, changes: z.array(z.string()) }),
  'schedule.deleted': z.object({ scheduleId: ScheduleId }),
  'schedule.fired': z.object({
    scheduleId: ScheduleId,
    sessionId: SessionId.nullable(),
    scheduledFor: Timestamp,
    outcome: ScheduleOutcome,
  }),
} as const;
