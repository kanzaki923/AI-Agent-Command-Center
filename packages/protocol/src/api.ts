import { z } from 'zod';
import {
  ApprovalId,
  ArtifactId,
  BudgetId,
  Cursor,
  ErrorInfo,
  GrantId,
  IntegrationId,
  Limit,
  MessageId,
  PermissionRuleId,
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
  ApprovalRemember,
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
  PermissionProfile,
  PermissionRule,
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

/** Task statuses `task.wait` treats as "settled" (nothing more happens without someone acting). */
export const SETTLED_TASK_STATUSES = [
  'review',
  'done',
  'failed',
  'cancelled',
  'blocked',
] as const satisfies TaskStatus[];

/** Compact view of a task for supervisors (what `task.wait` returns per task). */
export const TaskSnapshot = z.object({
  id: TaskId,
  title: z.string(),
  status: TaskStatus,
  statusReason: z.string().nullable(),
  assigneeSessionId: SessionId.nullable(),
  workspaceId: WorkspaceId.nullable(),
  branch: z.string().nullable().describe('Work branch of the task workspace'),
  run: z
    .object({
      id: RunId,
      status: RunStatus,
      activity: z.string().nullable().describe('What the worker is doing right now'),
      error: ErrorInfo.nullable(),
    })
    .nullable()
    .describe('Latest run on the task'),
  pendingApprovals: z.int().nonnegative().describe('Approvals waiting for a human'),
  diff: DiffStats.nullable().describe('Stats of the latest diff artifact'),
  resultSummary: z.string().nullable(),
  updatedAt: Timestamp,
});
export type TaskSnapshot = z.infer<typeof TaskSnapshot>;

/** Integration statuses `integration.wait` returns on. */
export const SETTLED_INTEGRATION_STATUSES = [
  'awaiting_approval',
  'conflict',
  'failed',
  'applied',
  'rejected',
  'cancelled',
] as const satisfies IntegrationStatus[];

/** Result of `project.inspectRepo`: whether a folder can become a project, and suggestions. */
export const RepoInspection = z.object({
  ok: z.boolean().describe('True when the path is the root of a git repository'),
  /** User-facing (Japanese) reason when not ok. */
  reason: z.string().nullable(),
  /** Root of the repository containing the path (also set when the path is a subfolder). */
  repoRoot: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  currentBranch: z.string().nullable(),
  isDirty: z.boolean().nullable(),
  suggestedName: z.string().nullable(),
  suggestedTestCommand: z.string().nullable(),
  /** Project already registered for this repository, if any. */
  existingProjectId: ProjectId.nullable(),
});
export type RepoInspection = z.infer<typeof RepoInspection>;

export const SystemHealth = z.object({
  ok: z.literal(true),
  /** Identifies the process as this daemon (launchers check it together with `pid`). */
  service: z.literal('acc-daemon'),
  pid: z.int(),
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

const CommitAuthor = params({
  name: z.string().min(1).max(200),
  email: z.string().min(1).max(200),
}).describe('Git identity for commits made by the daemon');

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
  'system.shutdown': {
    params: params({
      force: z
        .boolean()
        .default(false)
        .describe('Stop even when runs are active (they become interrupted)'),
    }),
    result: z.object({
      ok: z.literal(true),
      pid: z.int(),
      activeRuns: z.int().nonnegative().describe('Runs that will be interrupted'),
    }),
    description:
      'Stop the daemon process after replying. Humans only. Refused with conflict while runs are active unless force is true.',
    tool: false,
    mutates: true,
  },
  'system.setupDemo': {
    params: params({
      name: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase letters, digits and "-"')
        .default('auth-demo')
        .describe('Folder name under <ACC_HOME>/demo'),
    }),
    result: z.object({
      project: Project,
      session: Session,
      grant: CapabilityGrant,
      repoPath: z.string(),
      created: z.boolean().describe('False when everything already existed'),
    }),
    description:
      'Prepare demo mode (idempotent): a small local git repository with tests, a project for it and an orchestrator chat session using the offline mock/orchestrator model.',
    tool: false,
    mutates: true,
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
      defaultRuntime: z.string().min(1).nullable().optional(),
      maxConcurrentRuns: z.int().min(1).max(64).optional(),
      maxDelegationDepth: z.int().min(0).max(4).optional(),
      autoResumeOrchestrators: z.boolean().optional(),
      llmCallReserveUsd: z.number().min(0).max(100).optional(),
      defaultPermissionProfile: PermissionProfile.optional(),
      autoMode: params({
        enabled: z.boolean().optional(),
        classifierModel: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe('LiteLLM model name of a Claude model (Sonnet 4.6 or later); null clears it'),
      }).optional(),
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
      testCommand: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe('Shell command that verifies the project, e.g. "pnpm test"'),
      commitAuthor: CommitAuthor.optional(),
      permissionProfile: PermissionProfile.optional().describe(
        "Agents' tool permissions; omitted follows the global default",
      ),
    }),
    result: Project,
    description: 'Create a project (a repository plus settings).',
    mutates: true,
  },
  'project.inspectRepo': {
    params: params({
      path: z.string().min(1).max(4000).describe('Absolute path of a local folder'),
    }),
    result: RepoInspection,
    description:
      'Check whether a local folder is the root of a git repository and suggest project settings (name, default branch, test command). Read-only: creates nothing.',
    tool: false,
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
      testCommand: z.string().min(1).max(2000).nullable().optional(),
      commitAuthor: CommitAuthor.nullable().optional(),
      permissionProfile: PermissionProfile.nullable()
        .optional()
        .describe('null follows the global default. Humans only'),
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
    result: z.object({
      sessionId: SessionId,
      runId: RunId,
      workspaceId: WorkspaceId,
      budgetId: BudgetId.nullable().default(null).describe('Budget carved for the worker'),
    }),
    description:
      'Start a worker (a coding agent) for a ready task: creates a git worktree, a worker session and an agent run, and marks the task running. Returns immediately; the task moves to "review" when the worker finishes (its changes are committed and recorded as a diff) or to "failed". Supervise with task.wait.',
    mutates: true,
  },
  'task.retry': {
    params: params({
      taskId: TaskId,
      feedback: z
        .string()
        .max(50_000)
        .optional()
        .describe('What to fix, shown to the worker as review feedback'),
      integrationId: IntegrationId.optional().describe(
        'A failed integration of this task: its error, test command and the tail of the test output are added to the feedback',
      ),
      model: z.string().min(1).optional(),
      runtime: z.string().min(1).optional(),
    }),
    result: z.object({
      sessionId: SessionId,
      runId: RunId,
      workspaceId: WorkspaceId,
      budgetId: BudgetId.nullable().default(null),
    }),
    description:
      'Send a task back to its original worker: a new run in the same worker session and worktree (the branch is kept and the runtime resumes its conversation) whose prompt adds the feedback. Use it when the task broke the integration tests, after a review, or to resume a task interrupted by a daemon restart (statusReason "interrupted"). Works for tasks in review, failed, ready or blocked by a human; the task becomes running again.',
    mutates: true,
  },
  'task.wait': {
    params: params({
      taskIds: z.array(TaskId).min(1).max(100),
      timeoutMs: z.int().min(0).max(600_000).default(60_000),
      until: z
        .enum(['settled', 'review_or_terminal', 'terminal'])
        .default('settled')
        .describe(
          'Which statuses count as reached. settled: review, done, failed, cancelled or blocked (default). review_or_terminal: review, done, failed or cancelled. terminal: done, failed or cancelled.',
        ),
      mode: z
        .enum(['any', 'all'])
        .default('any')
        .describe('Return when ANY listed task is reached (default) or only when ALL are'),
    }),
    result: z.object({
      reached: z.array(TaskId).describe('Listed tasks that are in a reached status'),
      tasks: z.array(TaskSnapshot).describe('Compact current state of every listed task'),
      timedOut: z.boolean().describe('True when the condition was not met before the timeout'),
    }),
    description:
      'Block until ANY (or, with mode "all", every) listed task is settled (review/done/failed/cancelled/blocked) or the timeout elapses, then return a compact snapshot of all listed tasks. Use this instead of polling. With mode "any", pass only the tasks you are still waiting for.',
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
      label: z
        .string()
        .max(200)
        .optional()
        .describe('Short label used in the generated branch name'),
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
      remember: ApprovalRemember.default('once').describe(
        'Approving a tool use: also allow matching uses for the rest of the run, the task or the project (humans only)',
      ),
    }),
    result: Approval,
    description: 'Approve or reject a pending approval.',
    mutates: true,
  },

  // ---- permission rules (remembered tool approvals) ----
  'permissionRule.list': {
    params: params({
      projectId: ProjectId,
      includeRevoked: z.boolean().default(false),
    }),
    result: z.object({ items: z.array(PermissionRule) }),
    description: 'List remembered tool approvals of a project, newest first.',
  },
  'permissionRule.revoke': {
    params: params({ ruleId: PermissionRuleId }),
    result: PermissionRule,
    description: 'Revoke a remembered tool approval (matching uses are decided as before).',
    mutates: true,
  },

  // ---- artifact ----
  'artifact.list': {
    params: params({
      projectId: ProjectId.optional(),
      sessionId: SessionId.optional(),
      runId: RunId.optional(),
      taskId: TaskId.optional(),
      workspaceId: WorkspaceId.optional(),
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
      taskIds: z
        .array(TaskId)
        .min(1)
        .optional()
        .describe('Tasks to integrate, in merge order (each must have a workspace)'),
      workspaceIds: z
        .array(WorkspaceId)
        .min(1)
        .optional()
        .describe('Workspaces to integrate, in merge order (alternative to taskIds)'),
      title: z.string().max(300).optional(),
      targetRef: z
        .string()
        .min(1)
        .optional()
        .describe("Target branch; defaults to the project's default branch"),
    }),
    result: Integration,
    description:
      'Create an integration branch (in its own worktree) from the target branch for several tasks or workspaces. Pass taskIds or workspaceIds. Then call integration.run.',
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
    description:
      "Merge the sources in order (git merge --no-ff) and run the project's test command. Returns immediately; follow integration.updated events. Ends in awaiting_approval, conflict or failed.",
    mutates: true,
  },
  'integration.wait': {
    params: params({
      integrationId: IntegrationId,
      timeoutMs: z.int().min(0).max(600_000).default(60_000),
    }),
    result: z.object({
      integration: Integration,
      timedOut: z
        .boolean()
        .describe('True when it was still pending/running/verifying at the timeout'),
    }),
    description:
      'Block until an integration settles (awaiting_approval, conflict, failed, applied, rejected or cancelled) or the timeout elapses. Call after integration.run instead of polling integration.get.',
    longPoll: true,
  },
  'integration.resolveWithAgent': {
    params: params({
      integrationId: IntegrationId,
      instructions: z
        .string()
        .max(20_000)
        .optional()
        .describe('Extra guidance for the integrator agent'),
      model: z.string().min(1).optional(),
      runtime: z.string().min(1).optional(),
    }),
    result: z.object({
      integration: Integration,
      sessionId: SessionId.nullable().describe(
        'Integrator session; null when the merge no longer conflicted and the integration resumed directly',
      ),
      runId: RunId.nullable(),
    }),
    description:
      'For an integration in "conflict": re-create the conflicting merge in the integration worktree and start an integrator agent that resolves it with both sides\' task goals as context. When the agent finishes, its resolution is committed as the merge commit and the integration resumes (remaining merges, then the test command). Returns immediately with the integration "running"; follow it with integration.wait. If the conflict is not resolved, the integration returns to "conflict".',
    mutates: true,
  },
  'integration.approve': {
    params: params({ integrationId: IntegrationId, note: z.string().max(5000).optional() }),
    result: Integration,
    description:
      'Approve an integration and fast-forward the target branch to it. Humans only: agents are always refused.',
    tool: false,
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

  'session.grantOrchestration': {
    params: params({
      sessionId: SessionId,
      projectId: ProjectId.optional().describe("Project to orchestrate; defaults to the session's"),
      maxWorkers: z.int().min(1).max(16).default(2),
      lifetime: GrantLifetime.default('run').describe(
        'run: only the next run of the session; session: until revoked or expiresAt',
      ),
      budgetUsd: z
        .number()
        .positive()
        .optional()
        .describe("Root budget for the session's runs; workers get slices of it"),
      expiresAt: Timestamp.optional(),
    }),
    result: z.object({ grant: CapabilityGrant, budget: BudgetAllocation.nullable() }),
    description:
      'Turn a chat session into an orchestrator for a project: grants the orchestrator preset (tasks, workers, supervision, integration without approve) limited to that project, maxWorkers and depth 1. Humans only.',
    tool: false,
    mutates: true,
  },

  // ---- orchestrator ----
  'orchestrator.recordDecision': {
    params: params({
      decision: z.string().min(1).max(300).describe('What you decided, one line'),
      rationale: z.string().min(1).max(4000).describe('Why, briefly'),
      taskIds: z.array(TaskId).max(100).optional(),
    }),
    result: Ok,
    description:
      'Record a planning/supervision decision with its rationale (shown to the human in the timeline). Call it when you decompose work, start workers, decide to integrate, or stop.',
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
