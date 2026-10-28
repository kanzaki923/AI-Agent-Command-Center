import { z } from 'zod';
import {
  Actor,
  ApprovalId,
  ArtifactId,
  BudgetId,
  ErrorInfo,
  GrantId,
  IntegrationId,
  MessageId,
  ProjectId,
  RunId,
  SessionId,
  TaskId,
  Timestamp,
  WorkspaceId,
} from './common';

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

/** Logical unit of work: a repository plus settings and permissions. */
export const Project = z.object({
  id: ProjectId,
  name: z.string().min(1),
  description: z.string().nullable(),
  /** Absolute path of the main git repository on this machine (null for chat-only projects). */
  repoPath: z.string().nullable(),
  /** Branch integrations target, e.g. "main". */
  defaultBranch: z.string().nullable(),
  /** Default model for new sessions in this project. */
  defaultModel: z.string().nullable(),
  /** Shell command that verifies the project (e.g. "pnpm test"); run after integration merges. */
  testCommand: z.string().nullable().default(null),
  /** Git identity for commits made by the daemon; null uses "AI Agent Command Center <acc@localhost>". */
  commitAuthor: z
    .object({ name: z.string().min(1), email: z.string().min(1) })
    .nullable()
    .default(null),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  archivedAt: Timestamp.nullable(),
});
export type Project = z.infer<typeof Project>;

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/** `main`: the project's own repository checkout (registered lazily, never removed). */
export const WorkspaceKind = z.enum(['worktree', 'directory', 'main']);
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;
export const WorkspaceStatus = z.enum(['creating', 'ready', 'removing', 'removed', 'error']);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatus>;

/** File-system environment where agents work (usually a git worktree). */
export const Workspace = z.object({
  id: WorkspaceId,
  projectId: ProjectId,
  kind: WorkspaceKind,
  status: WorkspaceStatus,
  path: z.string(),
  branch: z.string().nullable(),
  /** Ref the worktree was created from; diffs are computed against it. */
  baseRef: z.string().nullable(),
  taskId: TaskId.nullable(),
  /** Run currently holding the write lock (one writer per workspace). */
  lockedByRunId: RunId.nullable(),
  error: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Workspace = z.infer<typeof Workspace>;

// ---------------------------------------------------------------------------
// Session & Message
// ---------------------------------------------------------------------------

/**
 * `chat`: plain LLM chat via the LLM gateway. `agent`: coding agent backed by an Agent Runtime.
 * "Orchestrator" is NOT a session kind: it is a Run kind enabled by capability grants.
 */
export const SessionKind = z.enum(['chat', 'agent']);
export type SessionKind = z.infer<typeof SessionKind>;

export const Session = z.object({
  id: SessionId,
  projectId: ProjectId.nullable(),
  kind: SessionKind,
  title: z.string(),
  model: z.string().nullable(),
  /** Agent runtime id for `agent` sessions, e.g. "claude-agent-sdk" | "mock". */
  runtime: z.string().nullable(),
  systemPrompt: z.string().nullable(),
  workspaceId: WorkspaceId.nullable(),
  taskId: TaskId.nullable(),
  /** Session that spawned this one (e.g. orchestrator -> worker). */
  parentSessionId: SessionId.nullable(),
  /** Run currently executing in this session, if any. */
  activeRunId: RunId.nullable(),
  /** The agent runtime's own session id from the latest run (used to resume the conversation). */
  runtimeSessionId: z.string().nullable().optional(),
  pinned: z.boolean(),
  createdBy: Actor,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** Last message or run activity; drives "recent" ordering. */
  lastActivityAt: Timestamp,
  archivedAt: Timestamp.nullable(),
});
export type Session = z.infer<typeof Session>;

export const TextPart = z.object({ type: z.literal('text'), text: z.string() });
export const ReasoningPart = z.object({ type: z.literal('reasoning'), text: z.string() });
export const ToolCallPart = z.object({
  type: z.literal('tool_call'),
  toolCallId: z.string(),
  name: z.string(),
  input: z.unknown(),
});
export const ToolResultPart = z.object({
  type: z.literal('tool_result'),
  toolCallId: z.string(),
  name: z.string().optional(),
  output: z.unknown(),
  isError: z.boolean().default(false),
});
export const ContentPart = z.discriminatedUnion('type', [
  TextPart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
]);
export type ContentPart = z.infer<typeof ContentPart>;
export type TextPart = z.infer<typeof TextPart>;
export type ToolCallPart = z.infer<typeof ToolCallPart>;
export type ToolResultPart = z.infer<typeof ToolResultPart>;

export const MessageRole = z.enum(['user', 'assistant', 'system', 'tool']);
export type MessageRole = z.infer<typeof MessageRole>;

export const Message = z.object({
  id: MessageId,
  sessionId: SessionId,
  runId: RunId.nullable(),
  role: MessageRole,
  content: z.array(ContentPart),
  /** Who wrote it. A `user` message may come from a human or from an orchestrating agent. */
  author: Actor,
  model: z.string().nullable(),
  createdAt: Timestamp,
});
export type Message = z.infer<typeof Message>;

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export const TaskStatus = z.enum([
  'pending', // created, dependencies not yet satisfied or not scheduled
  'ready', // dependencies done, can be picked up
  'running', // a worker run is active
  'review', // work done, awaiting review/integration
  'done',
  'failed',
  'cancelled',
  'blocked', // needs human input or an external condition
]);
export type TaskStatus = z.infer<typeof TaskStatus>;
export const TERMINAL_TASK_STATUSES = [
  'done',
  'failed',
  'cancelled',
] as const satisfies TaskStatus[];

export const TaskPriority = z.enum(['urgent', 'high', 'normal', 'low']);
export type TaskPriority = z.infer<typeof TaskPriority>;

/** A goal with completion criteria and dependencies. Independent of sessions and runs. */
export const Task = z.object({
  id: TaskId,
  projectId: ProjectId,
  parentTaskId: TaskId.nullable(),
  title: z.string().min(1),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  status: TaskStatus,
  /** Why the task is in its status, e.g. "dependency_failed" for an auto-blocked task. */
  statusReason: z.string().nullable().default(null),
  priority: TaskPriority,
  dependsOn: z.array(TaskId),
  assigneeSessionId: SessionId.nullable(),
  workspaceId: WorkspaceId.nullable(),
  /** Short outcome summary written by the worker/reviewer. */
  resultSummary: z.string().nullable(),
  createdBy: Actor,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  completedAt: Timestamp.nullable(),
});
export type Task = z.infer<typeof Task>;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export const RunStatus = z.enum([
  'created',
  'queued',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type RunStatus = z.infer<typeof RunStatus>;
export const TERMINAL_RUN_STATUSES = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const satisfies RunStatus[];
/** Statuses that the daemon converts to `interrupted` on restart. */
export const RECOVERABLE_RUN_STATUSES = [
  'running',
  'queued',
  'awaiting_approval',
] as const satisfies RunStatus[];

export function isTerminalRunStatus(s: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(s);
}

/** `chat`: LLM gateway turn. `agent`: Agent Runtime turn. `orchestrator`: LLM driving the Control API. */
export const RunKind = z.enum(['chat', 'agent', 'orchestrator']);
export type RunKind = z.infer<typeof RunKind>;

export const CostSource = z.enum(['reported', 'estimated', 'unknown']);
export type CostSource = z.infer<typeof CostSource>;

export const Usage = z.object({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  /** USD. Meaningless when costSource is "unknown" (then 0). */
  costUsd: z.number().nonnegative(),
  costSource: CostSource,
});
export type Usage = z.infer<typeof Usage>;
export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  costSource: 'unknown',
};

/** One execution of an LLM/agent. Capabilities and budget are evaluated per run. */
export const Run = z.object({
  id: RunId,
  sessionId: SessionId,
  projectId: ProjectId.nullable(),
  taskId: TaskId.nullable(),
  kind: RunKind,
  status: RunStatus,
  /** Free-form reason for the latest status change (e.g. "daemon_restart"). */
  statusReason: z.string().nullable(),
  model: z.string().nullable(),
  runtime: z.string().nullable(),
  workspaceId: WorkspaceId.nullable(),
  parentRunId: RunId.nullable(),
  /** Run this one retries (attempt > 1). */
  retryOfRunId: RunId.nullable(),
  attempt: z.int().min(1),
  budgetId: BudgetId.nullable(),
  /** Message that triggered this run (e.g. the user message). */
  triggerMessageId: MessageId.nullable(),
  usage: Usage,
  error: ErrorInfo.nullable(),
  /**
   * Short "what is it doing now" line for Command Mode (e.g. "npm test を実行中").
   * Only meaningful while the run is active; cleared when it ends. Updates arrive as
   * `run.updated` with `changes: ["activity"]`.
   */
  activity: z.string().nullable().optional(),
  createdBy: Actor,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  startedAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
});
export type Run = z.infer<typeof Run>;

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

export const DiffFileStat = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'unknown']),
  additions: z.int().nonnegative(),
  deletions: z.int().nonnegative(),
  oldPath: z.string().optional(),
});
export type DiffFileStat = z.infer<typeof DiffFileStat>;

export const DiffStats = z.object({
  files: z.int().nonnegative(),
  additions: z.int().nonnegative(),
  deletions: z.int().nonnegative(),
});
export type DiffStats = z.infer<typeof DiffStats>;

const artifactBase = {
  id: ArtifactId,
  projectId: ProjectId.nullable(),
  sessionId: SessionId.nullable(),
  runId: RunId.nullable(),
  taskId: TaskId.nullable(),
  workspaceId: WorkspaceId.nullable(),
  title: z.string(),
  createdBy: Actor,
  createdAt: Timestamp,
};

export const ArtifactKind = z.enum(['diff', 'commit', 'test_result', 'file', 'note']);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const DiffArtifactData = z.object({
  patch: z.string(),
  baseRef: z.string().nullable(),
  headRef: z.string().nullable(),
  stats: DiffStats,
  files: z.array(DiffFileStat),
});
export const CommitArtifactData = z.object({
  sha: z.string(),
  branch: z.string().nullable(),
  message: z.string(),
  stats: DiffStats.nullable(),
});
export const TestResultArtifactData = z.object({
  command: z.string(),
  passed: z.boolean(),
  exitCode: z.int().nullable(),
  durationMs: z.int().nonnegative().nullable(),
  summary: z.string(),
  /** Tail of the output; full logs are not stored here. */
  output: z.string().nullable(),
});
export const FileArtifactData = z.object({
  path: z.string(),
  mimeType: z.string().nullable(),
  content: z.string().nullable(),
});
export const NoteArtifactData = z.object({ text: z.string() });

export const Artifact = z.discriminatedUnion('kind', [
  z.object({ ...artifactBase, kind: z.literal('diff'), data: DiffArtifactData }),
  z.object({ ...artifactBase, kind: z.literal('commit'), data: CommitArtifactData }),
  z.object({ ...artifactBase, kind: z.literal('test_result'), data: TestResultArtifactData }),
  z.object({ ...artifactBase, kind: z.literal('file'), data: FileArtifactData }),
  z.object({ ...artifactBase, kind: z.literal('note'), data: NoteArtifactData }),
]);
export type Artifact = z.infer<typeof Artifact>;

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

export const IntegrationStatus = z.enum([
  'pending',
  'running', // merging task branches into the integration branch
  'verifying', // build/test after merge
  'awaiting_approval', // ready for human review
  'conflict', // a merge conflicted; the merge was aborted and nothing was lost
  'applied', // merged into the target branch
  'failed',
  'rejected',
  'cancelled',
]);
export type IntegrationStatus = z.infer<typeof IntegrationStatus>;

export const IntegrationStepKind = z.enum(['merge', 'verify', 'fix', 'apply', 'note']);
export type IntegrationStepKind = z.infer<typeof IntegrationStepKind>;
export const IntegrationStepStatus = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
]);

/** One entry of the ordered integration log ("which task was merged in which order, where it conflicted"). */
export const IntegrationStep = z.object({
  index: z.int().nonnegative(),
  kind: IntegrationStepKind,
  status: IntegrationStepStatus,
  title: z.string(),
  taskId: TaskId.nullable(),
  artifactId: ArtifactId.nullable(),
  detail: z.string().nullable(),
  startedAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
  /** Source workspace of a merge step. */
  workspaceId: WorkspaceId.nullable().default(null),
  /** Source branch of a merge step. */
  branch: z.string().nullable().default(null),
  /** Files that conflicted (merge steps that failed with a conflict). */
  conflictFiles: z.array(z.string()).default([]),
});
export type IntegrationStep = z.infer<typeof IntegrationStep>;

export const Integration = z.object({
  id: IntegrationId,
  projectId: ProjectId,
  title: z.string(),
  status: IntegrationStatus,
  taskIds: z.array(TaskId),
  /** Source workspaces, in merge order. */
  workspaceIds: z.array(WorkspaceId).default([]),
  /** Integration branch, e.g. "acc/integration/<id>". */
  branch: z.string().nullable(),
  /** Target ref the result will be applied to. */
  targetRef: z.string().nullable(),
  workspaceId: WorkspaceId.nullable(),
  steps: z.array(IntegrationStep),
  /** Target commit the latest attempt started from. */
  baseSha: z.string().nullable().default(null),
  /** Integration branch head after the latest successful merge + verification. */
  headSha: z.string().nullable().default(null),
  approvalId: ApprovalId.nullable(),
  /** Who approved or rejected it, when, and why. */
  decidedBy: Actor.nullable().default(null),
  decidedAt: Timestamp.nullable().default(null),
  decisionNote: z.string().nullable().default(null),
  error: ErrorInfo.nullable(),
  createdBy: Actor,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Integration = z.infer<typeof Integration>;

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export const ApprovalKind = z.enum(['tool_use', 'integration', 'budget', 'grant', 'other']);
export type ApprovalKind = z.infer<typeof ApprovalKind>;
export const ApprovalStatus = z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/** A decision a human (or authorized agent) must make before work continues. */
export const Approval = z.object({
  id: ApprovalId,
  kind: ApprovalKind,
  status: ApprovalStatus,
  title: z.string(),
  detail: z.string().nullable(),
  /** Kind-specific data, e.g. `{ toolName, input }` for tool_use. */
  payload: z.unknown(),
  projectId: ProjectId.nullable(),
  sessionId: SessionId.nullable(),
  runId: RunId.nullable(),
  taskId: TaskId.nullable(),
  integrationId: IntegrationId.nullable(),
  requestedBy: Actor,
  resolvedBy: Actor.nullable(),
  resolutionNote: z.string().nullable(),
  createdAt: Timestamp,
  resolvedAt: Timestamp.nullable(),
});
export type Approval = z.infer<typeof Approval>;

// ---------------------------------------------------------------------------
// Capability Grant
// ---------------------------------------------------------------------------

/** Who the grant applies to. `run` grants expire with the run; `session` grants apply to every run of the session. */
export const GrantSubject = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run'), runId: RunId }),
  z.object({ kind: z.literal('session'), sessionId: SessionId }),
]);
export type GrantSubject = z.infer<typeof GrantSubject>;

export const GrantScope = z.object({
  /** Restrict to these projects. Omitted = all projects the parent grant allows. */
  projectIds: z.array(ProjectId).optional(),
});
export type GrantScope = z.infer<typeof GrantScope>;

export const GrantLimits = z.object({
  /** Max concurrently active worker runs this subject may spawn. */
  maxWorkers: z.int().nonnegative().optional(),
  /** Max delegation depth below this grant (0 = cannot delegate). */
  maxDepth: z.int().nonnegative().optional(),
});
export type GrantLimits = z.infer<typeof GrantLimits>;

export const GrantLifetime = z.enum(['run', 'session']);
export type GrantLifetime = z.infer<typeof GrantLifetime>;

/**
 * Permission patterns are dot-separated method names with `*` wildcards:
 * `"*"` (everything), `"task.*"` (all task methods), `"session.get"` (one method).
 */
export const PermissionPattern = z
  .string()
  .regex(/^(\*|[a-z][a-zA-Z]*(\.([a-z][a-zA-Z]*|\*))*)$/, 'Invalid permission pattern');

export const CapabilityGrant = z.object({
  id: GrantId,
  subject: GrantSubject,
  parentGrantId: GrantId.nullable(),
  permissions: z.array(PermissionPattern),
  scope: GrantScope,
  limits: GrantLimits,
  /** 0 for grants created by humans; parent.depth + 1 for delegated grants. */
  depth: z.int().nonnegative(),
  lifetime: GrantLifetime,
  expiresAt: Timestamp.nullable(),
  revokedAt: Timestamp.nullable(),
  reason: z.string().nullable(),
  grantedBy: Actor,
  createdAt: Timestamp,
});
export type CapabilityGrant = z.infer<typeof CapabilityGrant>;

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export const BudgetSubject = z.object({
  kind: z.enum(['global', 'project', 'session', 'run', 'task']),
  id: z.string().nullable(),
});
export type BudgetSubject = z.infer<typeof BudgetSubject>;

export const BudgetStatus = z.enum(['active', 'released']);

/**
 * Budget tree node. Invariant: allocatedUsd + reservedUsd + spentUsd <= limitUsd.
 * allocated = given to children, reserved = held by in-flight calls, spent = consumed.
 */
export const BudgetAllocation = z.object({
  id: BudgetId,
  parentId: BudgetId.nullable(),
  subject: BudgetSubject,
  status: BudgetStatus,
  limitUsd: z.number().nonnegative(),
  allocatedUsd: z.number().nonnegative(),
  reservedUsd: z.number().nonnegative(),
  spentUsd: z.number().nonnegative(),
  createdBy: Actor,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  releasedAt: Timestamp.nullable(),
});
export type BudgetAllocation = z.infer<typeof BudgetAllocation>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Persisted in `$ACC_HOME/config.json`. Never sent to clients as-is (see SettingsView). */
export const Settings = z.object({
  litellm: z
    .object({
      baseUrl: z.string().nullable().default(null),
      apiKey: z.string().nullable().default(null),
    })
    .default({ baseUrl: null, apiKey: null }),
  defaultModel: z.string().nullable().default(null),
  /** Agent runtime for sessions that do not name one (e.g. "claude-agent-sdk"); null = "mock". */
  defaultRuntime: z.string().min(1).nullable().default(null),
  /** Max runs in `running` state at once; the rest wait in `queued`. */
  maxConcurrentRuns: z.int().min(1).max(64).default(10),
  /** Max capability delegation depth (1 = orchestrator -> worker only). */
  maxDelegationDepth: z.int().min(0).max(4).default(1),
});
export type Settings = z.infer<typeof Settings>;

/** Settings as returned by the API: secrets masked. */
export const SettingsView = z.object({
  litellm: z.object({
    baseUrl: z.string().nullable(),
    hasApiKey: z.boolean(),
    /** e.g. "sk-…a1b2"; null when no key. */
    apiKeyMasked: z.string().nullable(),
  }),
  defaultModel: z.string().nullable(),
  defaultRuntime: z.string().nullable(),
  maxConcurrentRuns: z.int(),
  maxDelegationDepth: z.int(),
});
export type SettingsView = z.infer<typeof SettingsView>;

export const ModelInfo = z.object({
  id: z.string(),
  label: z.string().nullable(),
  provider: z.string().nullable(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

/** Contents of `$ACC_HOME/daemon.json`, written by the daemon on start. */
export const DaemonInfo = z.object({
  port: z.int(),
  token: z.string(),
  pid: z.int(),
  startedAt: Timestamp,
  version: z.string(),
});
export type DaemonInfo = z.infer<typeof DaemonInfo>;
