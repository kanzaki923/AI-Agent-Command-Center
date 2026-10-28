import { z } from 'zod';

/**
 * ID prefixes. IDs are `<prefix>_<26 lowercase base32 chars>` and sort by creation time
 * (48-bit ms timestamp + 80 random bits, monotonic within the same ms).
 */
export const ID_PREFIXES = {
  project: 'prj',
  workspace: 'wsp',
  session: 'ses',
  message: 'msg',
  task: 'tsk',
  run: 'run',
  artifact: 'art',
  integration: 'int',
  approval: 'apr',
  grant: 'grt',
  budget: 'bud',
  event: 'evt',
  subscription: 'sub',
  connection: 'con',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

export const ID_BODY_LENGTH = 26;

const idSchema = (kind: IdKind) => {
  const prefix = ID_PREFIXES[kind];
  return z
    .string()
    .regex(new RegExp(`^${prefix}_[0-9a-z]{${ID_BODY_LENGTH}}$`), {
      message: `Expected a ${kind} id like "${prefix}_..."`,
    })
    .describe(`${kind} id (prefix "${prefix}_")`);
};

export const ProjectId = idSchema('project');
export const WorkspaceId = idSchema('workspace');
export const SessionId = idSchema('session');
export const MessageId = idSchema('message');
export const TaskId = idSchema('task');
export const RunId = idSchema('run');
export const ArtifactId = idSchema('artifact');
export const IntegrationId = idSchema('integration');
export const ApprovalId = idSchema('approval');
export const GrantId = idSchema('grant');
export const BudgetId = idSchema('budget');
export const EventId = idSchema('event');
export const SubscriptionId = idSchema('subscription');

/** ISO-8601 UTC timestamp with milliseconds, e.g. `2026-01-01T00:00:00.000Z`. Sorts lexicographically. */
export const Timestamp = z.iso.datetime({ offset: false });
export type Timestamp = z.infer<typeof Timestamp>;

/** Monotonic event sequence number (1-based). */
export const Seq = z.int().nonnegative();

export const Limit = (max = 500, def = 50) =>
  z.int().min(1).max(max).default(def).describe(`Max items to return (1-${max}, default ${def})`);

/** Opaque pagination cursor returned as `nextCursor` by list methods. */
export const Cursor = z.string().min(1).describe('Opaque cursor from a previous `nextCursor`');

export const page = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z
      .string()
      .nullable()
      .describe('Pass as `cursor` to fetch the next page; null when done'),
  });

/**
 * Who performed an action. Every Control API call carries one; the dispatcher enforces
 * capabilities for `agent` actors.
 */
export const HumanActor = z.object({
  kind: z.literal('human'),
  /** Client label, e.g. "desktop", "cli". Informational only. */
  client: z.string().optional(),
});
export const AgentActor = z.object({
  kind: z.literal('agent'),
  sessionId: SessionId,
  runId: RunId,
});
export const SystemActor = z.object({
  kind: z.literal('system'),
  /** Daemon component, e.g. "recovery", "scheduler". */
  component: z.string().optional(),
});
export const Actor = z.discriminatedUnion('kind', [HumanActor, AgentActor, SystemActor]);
export type Actor = z.infer<typeof Actor>;
export type HumanActor = z.infer<typeof HumanActor>;
export type AgentActor = z.infer<typeof AgentActor>;
export type SystemActor = z.infer<typeof SystemActor>;

export const ErrorInfo = z.object({
  code: z.string(),
  message: z.string(),
});
export type ErrorInfo = z.infer<typeof ErrorInfo>;
