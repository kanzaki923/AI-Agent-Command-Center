import { z } from 'zod';
import {
  Actor,
  ErrorInfo,
  EventId,
  GrantId,
  MessageId,
  ProjectId,
  RunId,
  Seq,
  SessionId,
  TaskId,
  Timestamp,
  WorkspaceId,
} from './common';
import {
  Approval,
  Artifact,
  BudgetAllocation,
  CapabilityGrant,
  Integration,
  Message,
  Project,
  Run,
  RunStatus,
  Session,
  Task,
  Workspace,
} from './domain';

/**
 * Payload schema per event type. This map is the single source of truth for event types:
 * add a new event by adding an entry here (the union and helpers derive from it).
 *
 * Every event also carries refs (projectId/sessionId/runId/taskId) on the envelope so
 * consumers can filter without looking into payloads.
 */
export const eventPayloads = {
  'project.created': z.object({ project: Project }),
  'project.updated': z.object({ project: Project, changes: z.array(z.string()) }),

  'session.created': z.object({ session: Session }),
  'session.updated': z.object({ session: Session, changes: z.array(z.string()) }),
  'session.archived': z.object({ sessionId: SessionId, archived: z.boolean() }),

  'message.created': z.object({ message: Message }),

  'run.created': z.object({ run: Run }),
  'run.status_changed': z.object({
    runId: RunId,
    from: RunStatus,
    to: RunStatus,
    reason: z.string().nullable(),
  }),
  'run.completed': z.object({ run: Run }),
  'run.failed': z.object({ run: Run, error: ErrorInfo }),

  'tool.called': z.object({
    runId: RunId,
    toolCallId: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  'tool.result': z.object({
    runId: RunId,
    toolCallId: z.string(),
    name: z.string(),
    output: z.unknown(),
    isError: z.boolean(),
    durationMs: z.int().nonnegative().nullable(),
  }),

  'approval.requested': z.object({ approval: Approval }),
  'approval.resolved': z.object({ approval: Approval }),

  'task.created': z.object({ task: Task }),
  'task.updated': z.object({ task: Task, changes: z.array(z.string()) }),

  'workspace.created': z.object({ workspace: Workspace }),
  'workspace.updated': z.object({ workspace: Workspace, changes: z.array(z.string()) }),
  'workspace.removed': z.object({ workspaceId: WorkspaceId }),

  'artifact.created': z.object({ artifact: Artifact }),

  'integration.created': z.object({ integration: Integration }),
  'integration.updated': z.object({ integration: Integration, changes: z.array(z.string()) }),

  'grant.created': z.object({ grant: CapabilityGrant }),
  'grant.revoked': z.object({ grantId: GrantId, reason: z.string().nullable() }),

  'budget.updated': z.object({ budget: BudgetAllocation, reason: z.string().nullable() }),

  /** Free-form record of an orchestrator's judgement, shown in Timeline Mode. */
  'orchestrator.decision': z.object({
    decision: z.string().describe('What was decided, one line'),
    rationale: z.string().describe('Why'),
    refs: z
      .object({
        taskIds: z.array(TaskId).optional(),
        sessionIds: z.array(SessionId).optional(),
        runIds: z.array(RunId).optional(),
      })
      .optional(),
  }),

  'settings.updated': z.object({ changes: z.array(z.string()) }),
} as const;

export type EventPayloads = typeof eventPayloads;
export type EventType = keyof EventPayloads;
export const EVENT_TYPES = Object.keys(eventPayloads) as EventType[];
export const EventType = z.enum(EVENT_TYPES as [EventType, ...EventType[]]);

/** Envelope refs used for filtering. */
export const EventRefs = z.object({
  projectId: ProjectId.nullable(),
  sessionId: SessionId.nullable(),
  runId: RunId.nullable(),
  taskId: TaskId.nullable(),
});
export type EventRefs = z.infer<typeof EventRefs>;

const eventEnvelope = {
  seq: Seq,
  id: EventId,
  ts: Timestamp,
  actor: Actor,
  ...EventRefs.shape,
};

type EventSchemaFor<T extends EventType> = z.ZodObject<
  typeof eventEnvelope & { type: z.ZodLiteral<T>; payload: EventPayloads[T] }
>;

function eventSchema<T extends EventType>(type: T): EventSchemaFor<T> {
  return z.object({
    ...eventEnvelope,
    type: z.literal(type),
    payload: eventPayloads[type],
  });
}

const eventSchemas = EVENT_TYPES.map((t) => eventSchema(t));

/** Persisted event (discriminated by `type`). Typed as the hand-written `Event` union below. */
export const Event = z.discriminatedUnion(
  'type',
  eventSchemas as unknown as [EventSchemaFor<EventType>, ...EventSchemaFor<EventType>[]],
) as unknown as z.ZodType<Event>;

export type EventPayload<T extends EventType> = z.infer<EventPayloads[T]>;
export type EventOf<T extends EventType> = {
  seq: number;
  id: string;
  ts: string;
  actor: Actor;
  projectId: string | null;
  sessionId: string | null;
  runId: string | null;
  taskId: string | null;
  type: T;
  payload: EventPayload<T>;
};
/** Union of all persisted events. Narrow with `event.type`. */
export type Event = { [T in EventType]: EventOf<T> }[EventType];

/** Event filter shared by events.list, events.subscribe and the in-process bus. */
export const EventFilter = z.object({
  projectId: ProjectId.optional(),
  sessionId: SessionId.optional(),
  runId: RunId.optional(),
  taskId: TaskId.optional(),
  /** Event types or patterns like "run.*". */
  types: z.array(z.string().min(1)).optional(),
});
export type EventFilter = z.infer<typeof EventFilter>;

/**
 * Ephemeral streaming fragment (assistant text/reasoning). Never persisted; the final
 * content arrives as `message.created`. Ordered per message by `index`.
 */
export const Delta = z.object({
  runId: RunId,
  sessionId: SessionId,
  messageId: MessageId,
  kind: z.enum(['text', 'reasoning']).default('text'),
  text: z.string(),
  index: z.int().nonnegative(),
});
export type Delta = z.infer<typeof Delta>;
export type DeltaInput = z.input<typeof Delta>;
