import { z } from 'zod';
import {
  ApprovalId,
  ArtifactId,
  BudgetId,
  Cursor,
  GrantId,
  IntegrationId,
  Limit,
  MessageId,
  ProjectId,
  RunId,
  SessionId,
  SubscriptionId,
  TaskId,
  Timestamp,
  WorkspaceId,
  page,
} from './common';
import {
  Approval,
  ApprovalStatus,
  Artifact,
  ArtifactKind,
  BudgetAllocation,
  BudgetSubject,
  CapabilityGrant,
  ContentPart,
  DiffFileStat,
  DiffStats,
  GrantLifetime,
  GrantLimits,
  GrantScope,
  GrantSubject,
  Integration,
  IntegrationStatus,
  Message,
  ModelInfo,
  PermissionPattern,
  Project,
  Run,
  RunKind,
  RunStatus,
  Session,
  SessionKind,
  SettingsView,
  Task,
  TaskPriority,
  TaskStatus,
  Workspace,
  WorkspaceKind,
} from './domain';
import { Event, EventFilter } from './events';

/**
 * Control API contract. One entry per method; the daemon registers a handler per entry and
 * the dispatcher validates params/results against these schemas. Humans (UI/CLI) and LLMs
 * (orchestrators/workers) call the exact same methods.
 *
 * - `permission`: capability string checked for agent actors (defaults to the method name).
 * - `description`: English, LLM-facing. Also used to generate LLM tool definitions.
 * - `tool`: whether the method may be exposed as an LLM tool at all (still subject to grants).
 * - `mutates`: whether the method changes state.
 * - `longPoll`: the method blocks up to `params.timeoutMs`; clients extend their timeout.
 */
export interface MethodDef {
  params: z.ZodType;
  result: z.ZodType;
  description: string;
  permission?: string;
  tool?: boolean;
  mutates?: boolean;
  longPoll?: boolean;
}

export interface MethodSpec<
  N extends string = string,
  P extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
> {
  name: N;
  params: P;
  result: R;
  description: string;
  permission: string;
  tool: boolean;
  mutates: boolean;
  longPoll: boolean;
}

type Specs<T extends Record<string, MethodDef>> = {
  [K in keyof T & string]: MethodSpec<K, T[K]['params'], T[K]['result']>;
};

function defineApi<T extends Record<string, MethodDef>>(defs: T): Specs<T> {
  const out: Record<string, MethodSpec> = {};
  for (const [name, d] of Object.entries(defs)) {
    out[name] = {
      name,
      params: d.params,
      result: d.result,
      description: d.description,
      permission: d.permission ?? name,
      tool: d.tool ?? true,
      mutates: d.mutates ?? false,
      longPoll: d.longPoll ?? false,
    };
  }
  return out as Specs<T>;
}

const params = z.strictObject;
const empty = () => z.strictObject({});
const Ok = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------
// Shared param/result shapes
// ---------------------------------------------------------------------------

export const SessionSearchHit = z.object({
  sessionId: SessionId,
  sessionTitle: z.string(),
  messageId: MessageId,
  snippet: z.string(),
  createdAt: Timestamp,
});
export type SessionSearchHit = z.infer<typeof SessionSearchHit>;

export const WorkspaceDiff = z.object({
  workspaceId: WorkspaceId,
  baseRef: z.string().nullable(),
  patch: z.string(),
  stats: DiffStats,
  files: z.array(DiffFileStat),
});
export type WorkspaceDiff = z.infer<typeof WorkspaceDiff>;

export const SystemHealth = z.object({
  ok: z.literal(true),
  version: z.string(),
  protocolVersion: z.int(),
  uptimeMs: z.int().nonnegative(),
});

export const SystemInfo = z.object({
  version: z.string(),
  protocolVersion: z.int(),
  pid: z.int(),
  port: z.int(),
  startedAt: Timestamp,
  dataDir: z.string(),
  nodeVersion: z.string(),
  platform: z.string(),
  methods: z.array(z.string()).describe('Methods implemented by this daemon'),
  stats: z.object({
    projects: z.int(),
    sessions: z.int(),
    activeRuns: z.int(),
    lastEventSeq: z.int(),
  }),
});
export type SystemInfo = z.infer<typeof SystemInfo>;

const ContentInput = z.union([
  z.string().min(1).describe('Plain text'),
  z.array(ContentPart).min(1).describe('Structured content parts'),
]);

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

export const api = defineApi({
  // ---- system ----
  'system.health': {
    params: empty(),
    result: SystemHealth,
    description: 'Check that the daemon is alive.',
  },
  'system.info': {
    params: empty(),
    result: SystemInfo,
    description: 'Daemon version, data directory, implemented methods and basic counters.',
  },

  // ---- settings / models ----
  'settings.get': {
    params: empty(),
    result: SettingsView,
    description: 'Get daemon settings. Secrets are masked.',
    tool: false,
  },
  'settings.update': {
    params: params({
      litellm: params({
        baseUrl: z.url().nullable().optional(),
        apiKey: z.string().min(1).nullable().optional().describe('null clears the key'),
      }).optional(),
      defaultModel: z.string().min(1).nullable().optional(),
      maxConcurrentRuns: z.int().min(1).max(64).optional(),
      maxDelegationDepth: z.int().min(0).max(4).optional(),
    }),
    result: SettingsView,
    description: 'Update daemon settings (persisted to config.json).',
    tool: false,
    mutates: true,
  },
  'models.list': {
    params: params({ refresh: z.boolean().optional() }),
    result: z.object({
      models: z.array(ModelInfo),
      source: z.enum(['litellm', 'config', 'mock']),
    }),
    description: 'List models available through the LLM gateway.',
  },

  // ---- project ----
  'project.create': {
    params: params({
      name: z.string().min(1).max(200),
      description: z.string().max(10_000).optional(),
      repoPath: z.string().min(1).optional().describe('Absolute path of a local git repository'),
      defaultBranch: z.string().min(1).optional(),
      defaultModel: z.string().min(1).optional(),
    }),
    result: Project,
    description: 'Create a project (a repository plus settings).',
    mutates: true,
  },
  'project.list': {
    params: params({ includeArchived: z.boolean().default(false) }),
    result: z.object({ items: z.array(Project) }),
    description: 'List projects.',
  },
  'project.get': {
    params: params({ projectId: ProjectId }),
    result: Project,
    description: 'Get a project.',
  },
  'project.update': {
    params: params({
      projectId: ProjectId,
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(10_000).nullable().optional(),
      repoPath: z.string().min(1).nullable().optional(),
      defaultBranch: z.string().min(1).nullable().optional(),
      defaultModel: z.string().min(1).nullable().optional(),
      archived: z.boolean().optional(),
    }),
    result: Project,
    description: 'Update a project. `archived: true` archives it.',
    mutates: true,
  },

  // ---- session ----
  'session.create': {
    params: params({
      projectId: ProjectId.optional(),
      kind: SessionKind.default('chat'),
      title: z.string().max(200).optional(),
      model: z.string().min(1).optional(),
      runtime: z.string().min(1).optional(),
      systemPrompt: z.string().max(100_000).optional(),
      workspaceId: WorkspaceId.optional(),
      taskId: TaskId.optional(),
      parentSessionId: SessionId.optional(),
    }),
    result: Session,
    description:
      'Create a session (a conversation). kind "chat" talks to an LLM; kind "agent" runs a coding agent in a workspace.',
    mutates: true,
  },
  'session.list': {
    params: params({
      projectId: ProjectId.optional(),
      kind: SessionKind.optional(),
      includeArchived: z.boolean().default(false),
      limit: Limit(200, 50),
      cursor: Cursor.optional(),
    }),
    result: page(Session),
    description: 'List sessions, most recently active first.',
  },
  'session.get': {
    params: params({ sessionId: SessionId }),
    result: Session,
    description: 'Get a session.',
  },
  'session.update': {
    params: params({
      sessionId: SessionId,
      title: z.string().max(200).optional(),
      model: z.string().min(1).nullable().optional(),
      systemPrompt: z.string().max(100_000).nullable().optional(),
      pinned: z.boolean().optional(),
      projectId: ProjectId.nullable().optional(),
      workspaceId: WorkspaceId.nullable().optional(),
    }),
    result: Session,
    description: 'Update session properties.',
    mutates: true,
  },
  'session.archive': {
    params: params({
      sessionId: SessionId,
      archived: z.boolean().default(true).describe('false restores the session'),
    }),
    result: Session,
    description: 'Archive (or unarchive) a session.',
    mutates: true,
  },
  'session.messages': {
    params: params({
      sessionId: SessionId,
      limit: Limit(500, 100),
      before: MessageId.optional().describe('Return messages older than this message'),
    }),
    result: z.object({
      items: z.array(Message).describe('Oldest first'),
      hasMore: z.boolean().describe('Older messages exist'),
    }),
    description: 'Read messages of a session (latest page by default, oldest first).',
  },
  'session.send': {
    params: params({
      sessionId: SessionId,
      content: ContentInput,
      model: z.string().min(1).optional().describe('Override the session model for this run'),
    }),
    result: z.object({ messageId: MessageId, runId: RunId }),
    description:
      'Send a user message to a session. Starts a run and returns immediately; follow progress via events or run.get.',
    mutates: true,
  },
  'session.search': {
    params: params({
      query: z.string().min(1).max(500),
      projectId: ProjectId.optional(),
      limit: Limit(100, 20),
    }),
    result: z.object({ items: z.array(SessionSearchHit) }),
    description: 'Full-text search over messages of all sessions.',
  },

  // ---- run ----
  'run.list': {
    params: params({
      sessionId: SessionId.optional(),
      taskId: TaskId.optional(),
      projectId: ProjectId.optional(),
      kind: RunKind.optional(),
      status: z.array(RunStatus).optional(),
      limit: Limit(200, 50),
      cursor: Cursor.optional(),
    }),
    result: page(Run),
    description: 'List runs, newest first.',
  },
  'run.get': {
    params: params({ runId: RunId }),
    result: Run,
    description: 'Get a run (status, usage, error).',
  },
  'run.cancel': {
    params: params({ runId: RunId, reason: z.string().max(1000).optional() }),
    result: Run,
    description: 'Cancel a run that has not finished.',
    mutates: true,
  },
  'run.retry': {
    params: params({ runId: RunId }),
    result: z.object({ runId: RunId }),
    description: 'Start a new attempt of a failed, cancelled or interrupted run.',
    mutates: true,
  },

  // ---- task ----
  'task.create': {
    params: params({
      projectId: ProjectId,
      title: z.string().min(1).max(300),
      description: z.string().max(50_000).default(''),
      acceptanceCriteria: z.array(z.string().min(1)).default([]),
      priority: TaskPriority.default('normal'),
      dependsOn: z.array(TaskId).default([]).describe('Tasks that must be done first'),
      parentTaskId: TaskId.optional(),
    }),
    result: Task,
    description:
      'Create a task (a goal with acceptance criteria). Tasks with unfinished dependencies stay pending.',
    mutates: true,
  },
  'task.list': {
    params: params({
      projectId: ProjectId.optional(),
      status: z.array(TaskStatus).optional(),
      parentTaskId: TaskId.optional(),
      assigneeSessionId: SessionId.optional(),
      limit: Limit(500, 100),
      cursor: Cursor.optional(),
    }),
    result: page(Task),
    description: 'List tasks.',
  },
  'task.get': {
    params: params({ taskId: TaskId }),
    result: Task,
    description: 'Get a task.',
  },
  'task.update': {
    params: params({
      taskId: TaskId,
      title: z.string().min(1).max(300).optional(),
      description: z.string().max(50_000).optional(),
      acceptanceCriteria: z.array(z.string().min(1)).optional(),
      priority: TaskPriority.optional(),
      dependsOn: z.array(TaskId).optional(),
      status: TaskStatus.optional(),
      assigneeSessionId: SessionId.nullable().optional(),
      resultSummary: z.string().max(20_000).nullable().optional(),
    }),
    result: Task,
    description: 'Update a task (including status transitions such as review -> done).',
    mutates: true,
  },
  'task.cancel': {
    params: params({ taskId: TaskId, reason: z.string().max(1000).optional() }),
    result: Task,
    description: 'Cancel a task and any of its active runs.',
    mutates: true,
  },
  'task.spawnWorker': {
    params: params({
      taskId: TaskId,
      instructions: z
        .string()
        .max(50_000)
        .optional()
        .describe('Extra instructions appended to the task description'),
      model: z.string().min(1).optional(),
      runtime: z.string().min(1).optional(),
      budgetUsd: z.number().positive().optional().describe('Budget carved from the caller'),
      permissions: z
        .array(PermissionPattern)
        .optional()
        .describe('Capabilities delegated to the worker (subset of the caller)'),
    }),
    result: z.object({ sessionId: SessionId, runId: RunId, workspaceId: WorkspaceId }),
    description:
      'Start a worker for a task: creates a git worktree, a worker session and a run. Returns immediately.',
    mutates: true,
  },
  'task.wait': {
    params: params({
      taskIds: z.array(TaskId).min(1).max(100),
      timeoutMs: z.int().min(0).max(600_000).default(60_000),
      until: z
        .enum(['terminal', 'review_or_terminal'])
        .default('review_or_terminal')
        .describe('Which statuses count as "reached"'),
    }),
    result: z.object({
      reached: z.array(Task).describe('Tasks that reached the requested state'),
      tasks: z.array(Task).describe('Current state of all requested tasks'),
      timedOut: z.boolean(),
    }),
    description:
      'Block until ANY of the given tasks reaches review/terminal state, or the timeout elapses. Use this instead of polling.',
    longPoll: true,
  },

  // ---- workspace ----
  'workspace.create': {
    params: params({
      projectId: ProjectId,
      kind: WorkspaceKind.default('worktree'),
      branch: z.string().min(1).optional().describe('Branch to create; generated if omitted'),
      baseRef: z.string().min(1).optional().describe("Defaults to the project's default branch"),
      taskId: TaskId.optional(),
    }),
    result: Workspace,
    description: 'Create an isolated workspace (git worktree) for a project.',
    mutates: true,
  },
  'workspace.list': {
    params: params({
      projectId: ProjectId.optional(),
      taskId: TaskId.optional(),
      includeRemoved: z.boolean().default(false),
    }),
    result: z.object({ items: z.array(Workspace) }),
    description: 'List workspaces.',
  },
  'workspace.get': {
    params: params({ workspaceId: WorkspaceId }),
    result: Workspace,
    description: 'Get a workspace.',
  },
  'workspace.remove': {
    params: params({
      workspaceId: WorkspaceId,
      force: z.boolean().default(false).describe('Remove even with uncommitted changes'),
    }),
    result: Ok,
    description: 'Remove a workspace (the branch is kept).',
    mutates: true,
  },
  'workspace.diff': {
    params: params({ workspaceId: WorkspaceId, baseRef: z.string().min(1).optional() }),
    result: WorkspaceDiff,
    description: 'Diff of the workspace against its base ref (including uncommitted changes).',
  },

  // ---- approval ----
  'approval.list': {
    params: params({
      status: z.array(ApprovalStatus).optional(),
      projectId: ProjectId.optional(),
      sessionId: SessionId.optional(),
      runId: RunId.optional(),
      limit: Limit(200, 50),
      cursor: Cursor.optional(),
    }),
    result: page(Approval),
    description: 'List approvals, newest first.',
  },
  'approval.respond': {
    params: params({
      approvalId: ApprovalId,
      decision: z.enum(['approve', 'reject']),
      note: z.string().max(5000).optional(),
    }),
    result: Approval,
    description: 'Approve or reject a pending approval.',
    mutates: true,
  },

  // ---- artifact ----
  'artifact.list': {
    params: params({
      projectId: ProjectId.optional(),
      sessionId: SessionId.optional(),
      runId: RunId.optional(),
      taskId: TaskId.optional(),
      kind: ArtifactKind.optional(),
      limit: Limit(200, 50),
      cursor: Cursor.optional(),
    }),
    result: page(Artifact),
    description: 'List artifacts (diffs, commits, test results, files, notes), newest first.',
  },
  'artifact.get': {
    params: params({ artifactId: ArtifactId }),
    result: Artifact,
    description: 'Get an artifact with its full data.',
  },

  // ---- integration ----
  'integration.create': {
    params: params({
      projectId: ProjectId,
      taskIds: z.array(TaskId).min(1).describe('Tasks to integrate, in merge order'),
      title: z.string().max(300).optional(),
      targetRef: z.string().min(1).optional(),
    }),
    result: Integration,
    description: 'Create an integration of several tasks into one integration branch.',
    mutates: true,
  },
  'integration.list': {
    params: params({
      projectId: ProjectId.optional(),
      status: z.array(IntegrationStatus).optional(),
      limit: Limit(200, 50),
      cursor: Cursor.optional(),
    }),
    result: page(Integration),
    description: 'List integrations, newest first.',
  },
  'integration.get': {
    params: params({ integrationId: IntegrationId }),
    result: Integration,
    description: 'Get an integration with its ordered step log.',
  },
  'integration.run': {
    params: params({ integrationId: IntegrationId }),
    result: Integration,
    description: 'Merge the tasks in order and run verification. Returns immediately.',
    mutates: true,
  },
  'integration.approve': {
    params: params({ integrationId: IntegrationId, note: z.string().max(5000).optional() }),
    result: Integration,
    description: 'Approve an integration and apply it to the target branch.',
    mutates: true,
  },
  'integration.reject': {
    params: params({ integrationId: IntegrationId, note: z.string().max(5000).optional() }),
    result: Integration,
    description: 'Reject an integration. Workspaces and branches are kept.',
    mutates: true,
  },

  // ---- grant ----
  'grant.create': {
    params: params({
      subject: GrantSubject,
      permissions: z.array(PermissionPattern).min(1),
      scope: GrantScope.default({}),
      limits: GrantLimits.default({}),
      lifetime: GrantLifetime.default('run'),
      expiresAt: Timestamp.optional(),
      parentGrantId: GrantId.optional().describe('Required when an agent delegates'),
      reason: z.string().max(2000).optional(),
    }),
    result: CapabilityGrant,
    description:
      'Grant capabilities to a run or session. Agents can only delegate a subset of their own grant.',
    mutates: true,
  },
  'grant.list': {
    params: params({
      runId: RunId.optional(),
      sessionId: SessionId.optional(),
      includeRevoked: z.boolean().default(false),
    }),
    result: z.object({ items: z.array(CapabilityGrant) }),
    description: 'List capability grants.',
  },
  'grant.revoke': {
    params: params({ grantId: GrantId, reason: z.string().max(2000).optional() }),
    result: CapabilityGrant,
    description: 'Revoke a grant (and every grant delegated from it).',
    mutates: true,
  },

  // ---- budget ----
  'budget.get': {
    params: params({ budgetId: BudgetId }),
    result: z.object({ budget: BudgetAllocation, children: z.array(BudgetAllocation) }),
    description: 'Get a budget node and its direct children.',
  },
  'budget.allocate': {
    params: params({
      parentId: BudgetId.nullable().describe('null creates a root budget (humans only)'),
      subject: BudgetSubject,
      limitUsd: z.number().positive(),
    }),
    result: BudgetAllocation,
    description: "Carve a child budget out of a parent's unallocated amount.",
    mutates: true,
  },
  'budget.release': {
    params: params({ budgetId: BudgetId }),
    result: BudgetAllocation,
    description: 'Release a budget: unused amount returns to the parent.',
    mutates: true,
  },

  // ---- events ----
  'events.list': {
    params: params({
      ...EventFilter.shape,
      since: z.int().nonnegative().optional().describe('Return events with seq > since'),
      limit: Limit(1000, 200),
    }),
    result: z.object({
      events: z.array(Event).describe('Ascending by seq'),
      lastSeq: z.int().describe('Seq of the last returned event, or `since` when empty'),
      hasMore: z.boolean(),
    }),
    description: 'Read the event log (ascending). Filter by refs and type patterns like "run.*".',
  },
  'events.subscribe': {
    params: params({
      ...EventFilter.shape,
      deltas: z.boolean().default(true).describe('Also push streaming deltas'),
    }),
    result: z.object({
      subscriptionId: SubscriptionId,
      lastSeq: z
        .int()
        .describe('Head of the event log at subscribe time; every later event is pushed live'),
    }),
    description: 'Subscribe this connection to live events (WebSocket only).',
    tool: false,
  },
  'events.unsubscribe': {
    params: params({ subscriptionId: SubscriptionId }),
    result: Ok,
    description: 'Cancel an event subscription.',
    tool: false,
  },
});

export type Api = typeof api;
export type MethodName = keyof Api;
export const METHOD_NAMES = Object.keys(api) as MethodName[];

/** Params as accepted on the wire (defaults optional). */
export type ParamsInput<M extends MethodName> = z.input<Api[M]['params']>;
/** Params after validation (defaults applied). */
export type Params<M extends MethodName> = z.output<Api[M]['params']>;
export type Result<M extends MethodName> = z.output<Api[M]['result']>;

export function isMethodName(name: string): name is MethodName {
  return Object.hasOwn(api, name);
}
