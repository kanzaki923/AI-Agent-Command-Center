import { z } from 'zod';
import {
  Actor,
  ApprovalId,
  ArtifactId,
  BudgetId,
  ErrorInfo,
  GrantId,
  IntegrationId,
  AttentionId,
  MessageId,
  PermissionRuleId,
  ProjectId,
  RunId,
  ScheduleId,
  SessionId,
  TaskId,
  Timestamp,
  WorkspaceId,
} from './common';

// ---------------------------------------------------------------------------
// Permission profile (tool permissions of coding agents)
// ---------------------------------------------------------------------------

/**
 * How much a project lets its coding agents do without asking (architecture.md §2.10).
 * Hard rules (no pushing, nothing outside the worktree, no credentials, ...) apply to every
 * profile; the profile decides the gray zone:
 * - `autonomous` (おまかせ, default): everything that stays inside the worktree runs without
 *   asking; what cannot be decided is denied with a reason, never asked. Zero approvals.
 * - `standard` (標準): like autonomous, but new dependencies, reads outside the worktree and
 *   unknown tools ask a human.
 * - `careful` (慎重): only reads, edits and read-only commands run without asking; integration
 *   tests started by agents wait for a human too.
 */
export const PermissionProfile = z.enum(['careful', 'standard', 'autonomous']);
export type PermissionProfile = z.infer<typeof PermissionProfile>;

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

/** Logical unit of work: a repository plus settings and permissions. */
export const Project = z.object({
  id: ProjectId,
  name: z.string().min(1),
  description: z.string().nullable(),
  /** Absolute path of the main git repository on this machine (null for projects without code). */
  repoPath: z.string().nullable(),
  /**
   * Absolute path of an ordinary folder (no git needed) the project's agents may read, e.g.
   * documents to work from. Null when the project has none.
   */
  folderPath: z.string().nullable().default(null),
  /** Branch integrations target, e.g. "main" (meaningful only with repoPath). */
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
  /** Tool permission profile of the project's agents; null follows `settings.defaultPermissionProfile`. */
  permissionProfile: PermissionProfile.nullable().default(null),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  archivedAt: Timestamp.nullable(),
});
export type Project = z.infer<typeof Project>;

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/**
 * `worktree`: a git worktree of a code project. `directory`: a folder of the user's (no git
 * operations). `main`: the project's own repository checkout (registered lazily, never
 * removed). `scratch`: a daemon-managed folder `<ACC_HOME>/scratch/<sessionId>` for agents
 * that need no particular place to work.
 */
export const WorkspaceKind = z.enum(['worktree', 'directory', 'main', 'scratch']);
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;
export const WorkspaceStatus = z.enum(['creating', 'ready', 'removing', 'removed', 'error']);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatus>;

/** File-system environment where agents work (usually a git worktree). */
export const Workspace = z.object({
  id: WorkspaceId,
  /** Null for workspaces outside any project (scratch folders, plain folders). */
  projectId: ProjectId.nullable(),
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

/**
 * Where a spawned agent works (`session.spawn`, schedules): `none` (a daemon-managed scratch
 * folder), `folder` (a folder of the user's, read and written in place) or `worktree` (a git
 * worktree of a code project).
 */
export const WorkspaceSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('folder'), path: z.string().min(1).max(4000) }),
  z.object({
    kind: z.literal('worktree'),
    projectId: ProjectId,
    baseRef: z.string().min(1).optional(),
  }),
]);
export type WorkspaceSpec = z.infer<typeof WorkspaceSpec>;

export const CostSource = z.enum(['reported', 'estimated', 'unknown']);
export type CostSource = z.infer<typeof CostSource>;

// ---------------------------------------------------------------------------
// Session & Message
// ---------------------------------------------------------------------------

/**
 * `chat`: plain LLM chat via the LLM gateway. `agent`: coding agent backed by an Agent Runtime.
 * "Orchestrator" is NOT a session kind: it is a Run kind enabled by capability grants.
 */
export const SessionKind = z.enum(['chat', 'agent']);
export type SessionKind = z.infer<typeof SessionKind>;

/**
 * What a session is up to, maintained by the daemon (`sessionState`, architecture.md §2.19).
 * `supervising`: no run of its own but descendants are working or queued. `stopped`: paused
 * (resumable), not terminal.
 */
export const SessionState = z.enum([
  'idle',
  'queued',
  'working',
  'supervising',
  'needs_you',
  'failed',
  'review',
  'done',
  'stopped',
]);
export type SessionState = z.infer<typeof SessionState>;
/** Derivation precedence: the first state whose condition holds wins. */
export const SESSION_STATE_PRECEDENCE = [
  'needs_you',
  'failed',
  'working',
  'supervising',
  'queued',
  'review',
  'stopped',
  'done',
  'idle',
] as const satisfies SessionState[];

export const ReviewBy = z.enum(['none', 'human']);
export type ReviewBy = z.infer<typeof ReviewBy>;

/** What a child session was asked to do (shown pinned as the request card). */
export const SessionBrief = z.object({
  goal: z.string(),
  doneWhen: z.array(z.string()).default([]),
  /** Session that asked (the parent); null when a human or a schedule asked. */
  fromSessionId: SessionId.nullable(),
  /** `human`: the outputs need a human's acceptance before the work counts as done. */
  reviewBy: ReviewBy.default('none'),
  givenAt: Timestamp,
});
export type SessionBrief = z.infer<typeof SessionBrief>;

/** Spend of a session (`ownUsd`) and of it plus its descendants (`treeUsd`), from the usage ledger. */
export const SessionCost = z.object({
  ownUsd: z.number(),
  treeUsd: z.number(),
  /** Weakest source among the ledger rows (`unknown` when nothing was recorded). */
  source: CostSource,
});
export type SessionCost = z.infer<typeof SessionCost>;
export const EMPTY_SESSION_COST: SessionCost = { ownUsd: 0, treeUsd: 0, source: 'unknown' };

/** `paused`: the session is not woken by its inbox (stopped by a human, or wake limit). */
export const Supervision = z.enum(['active', 'paused']);
export type Supervision = z.infer<typeof Supervision>;

const SessionObject = z.object({
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
  /**
   * Root of the session tree (a root is its own root). Rows written before the tree existed
   * read as their own root; the startup backfill fixes children.
   */
  rootSessionId: SessionId.optional(),
  /** Derived by the daemon; the only writer is the `sessionState` service. */
  state: SessionState.default('idle'),
  /** When `state` last changed (elapsed time is shown from it; no ETA). */
  stateSince: Timestamp.nullable().default(null),
  /** "What is it doing now" noun phrase (max 24 chars); only while a run is active. */
  now: z.string().nullable().default(null),
  /** Spend; the only writer is the usage ledger. */
  cost: SessionCost.default(EMPTY_SESSION_COST),
  /** The request a child was given (session.spawn / schedules). */
  brief: SessionBrief.nullable().default(null),
  /** Schedule whose firing created this session. */
  scheduleId: ScheduleId.nullable().default(null),
  supervision: Supervision.default('active'),
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
export const Session = SessionObject.transform((s) => ({
  ...s,
  rootSessionId: s.rootSessionId ?? s.id,
}));
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

/** One child's change in a supervisor's "status update" (the message that woke it). */
export const WakeItemView = z.object({
  sessionId: SessionId,
  title: z.string(),
  change: z.enum([
    'done',
    'failed',
    'review',
    'needs_you',
    'stopped',
    'answer',
    'budget',
    'resume',
  ]),
  artifactIds: z.array(ArtifactId).default([]),
});
export type WakeItemView = z.infer<typeof WakeItemView>;

/** Data for special rendering of a message; `content` stays the LLM-facing text. */
export const MessageMeta = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wake'), items: z.array(WakeItemView) }),
  z.object({ kind: z.literal('brief'), brief: SessionBrief }),
  z.object({ kind: z.literal('schedule'), scheduleId: ScheduleId, scheduledFor: Timestamp }),
  z.object({
    kind: z.literal('answer'),
    attentionId: AttentionId,
    choiceLabel: z.string().nullable(),
  }),
]);
export type MessageMeta = z.infer<typeof MessageMeta>;

/**
 * `queued`: a user message sent while the session was busy, not yet handed to a run;
 * `delivered` once a run received it (message.updated `["delivery"]`).
 */
export const MessageDelivery = z.enum(['delivered', 'queued']);
export type MessageDelivery = z.infer<typeof MessageDelivery>;

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
  delivery: MessageDelivery.default('delivered'),
  meta: MessageMeta.nullable().default(null),
  /** Cost of an assistant message (may be an estimate until the run settles). */
  usage: z.object({ costUsd: z.number(), source: CostSource }).nullable().default(null),
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
  'paused', // stopped by a human or a supervisor; resumable (not terminal)
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
  /** Null for work outside any project (e.g. a child spawned without one). */
  projectId: ProjectId.nullable(),
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
  /** Start the assignee automatically once dependencies are done (session.spawn `after`). */
  autoStart: z.boolean().default(true),
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

/** What started a run. */
export const RunTrigger = z.enum([
  'user',
  'wake',
  'spawn',
  'schedule',
  'resume',
  'retry',
  'system',
]);
export type RunTrigger = z.infer<typeof RunTrigger>;

/**
 * Status reasons (and error codes) of runs the daemon stops: `turn_limit` (too many model
 * calls), `loop_detected` (the same call or text repeated), `superseded` (interrupted by a
 * newer message), `stopped_by_user`, `daily_limit` (the daily spend limit was reached).
 */
export const RunStopReason = z.enum([
  'turn_limit',
  'loop_detected',
  'superseded',
  'stopped_by_user',
  'daily_limit',
]);
export type RunStopReason = z.infer<typeof RunStopReason>;

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

/**
 * Who decided a tool use: a daemon `rule` (hard rule or the profile's rule), a `remembered`
 * human approval, Claude Code's auto mode `classifier`, the agent `runtime` itself (e.g. the
 * CLI's built-in auto-approval of edits in its directory), or a `human` (an approval).
 */
export const ToolDecider = z.enum(['rule', 'remembered', 'classifier', 'runtime', 'human']);
export type ToolDecider = z.infer<typeof ToolDecider>;
export const ToolDecisionKind = z.enum(['allowed', 'denied', 'asked']);
export type ToolDecisionKind = z.infer<typeof ToolDecisionKind>;

/**
 * Where Claude Code's auto mode judges a tool use: `server` — Anthropic's API reviews the tool
 * uses of each reply (`safeguards`, no extra request; needs an Anthropic API upstream);
 * `client` — the CLI sends its own classifier request (a separate, billed model call).
 */
export const AutoModeJudge = z.enum(['server', 'client']);
export type AutoModeJudge = z.infer<typeof AutoModeJudge>;

/** How an agent run decides tool uses (resolved when it starts; `gate` may fall back later). */
export const RunPermission = z.object({
  profile: PermissionProfile,
  /** `classifier`: Claude Code auto mode decides the gray zone; `rules`: the daemon's rules. */
  gate: z.enum(['classifier', 'rules']),
  /** Japanese note on why this gate (e.g. why auto mode is not used); null when obvious. */
  note: z.string().nullable(),
  /**
   * With `gate: classifier`: where auto mode judges (the setting, until the CLI is seen
   * falling back from the server to its own classifier). Absent on older runs.
   */
  judge: AutoModeJudge.nullable().optional(),
});
export type RunPermission = z.infer<typeof RunPermission>;

/** Tool decisions of a run so far (shown as "自動許可 42 / 拒否 2 / 承認 0"). */
export const ToolDecisionCounts = z.object({
  allowed: z.int().nonnegative(),
  denied: z.int().nonnegative(),
  asked: z.int().nonnegative(),
});
export type ToolDecisionCounts = z.infer<typeof ToolDecisionCounts>;

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
  trigger: RunTrigger.default('user'),
  usage: Usage,
  error: ErrorInfo.nullable(),
  /**
   * Short "what is it doing now" line for Command Mode (e.g. "npm test を実行中").
   * Only meaningful while the run is active; cleared when it ends. Updates arrive as
   * `run.updated` with `changes: ["activity"]`.
   */
  activity: z.string().nullable().optional(),
  /** Agent runs: how tool uses are decided. Updates arrive as `run.updated` `["permission"]`. */
  permission: RunPermission.nullable().optional(),
  /** Agent runs: decision counts. Updates arrive as `run.updated` `["toolDecisions"]` (batched). */
  toolDecisions: ToolDecisionCounts.nullable().optional(),
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

/**
 * `output`: what the work produced (shown as 成果物). `evidence`: how it was checked or kept
 * (commits, test results).
 */
export const ArtifactRole = z.enum(['output', 'evidence']);
export type ArtifactRole = z.infer<typeof ArtifactRole>;

/**
 * How an artifact came to be: `published` by the agent (artifact.publish), the run's
 * `final_message`, files it wrote (`tracked_writes`), or the worktree diff (`workspace_diff`).
 */
export const ArtifactSource = z.enum([
  'published',
  'final_message',
  'tracked_writes',
  'workspace_diff',
]);
export type ArtifactSource = z.infer<typeof ArtifactSource>;

export const ArtifactReviewState = z.enum(['none', 'pending', 'accepted', 'rejected']);
export type ArtifactReviewState = z.infer<typeof ArtifactReviewState>;
export const ArtifactReview = z.object({
  state: ArtifactReviewState,
  by: Actor.nullable(),
  at: Timestamp.nullable(),
  note: z.string().nullable(),
});
export type ArtifactReview = z.infer<typeof ArtifactReview>;
const NO_REVIEW: ArtifactReview = { state: 'none', by: null, at: null, note: null };

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
  /** One line. */
  summary: z.string().nullable().default(null),
  review: ArtifactReview.default(NO_REVIEW),
};
const artifactDefaults = (role: ArtifactRole, source: ArtifactSource = 'published') => ({
  role: ArtifactRole.default(role),
  source: ArtifactSource.default(source),
});

/**
 * User-facing outputs: `document`, `data`, `link`, `files`, and `diff` (code changes).
 * Evidence: `commit`, `test_result`. Legacy (read only, shown as files / document): `file`, `note`.
 */
export const ArtifactKind = z.enum([
  'document',
  'data',
  'link',
  'files',
  'diff',
  'commit',
  'test_result',
  'file',
  'note',
]);
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
/** Text content (<= 1 MB, enforced by artifact.publish). */
export const DocumentArtifactData = z.object({
  format: z.enum(['markdown', 'text']),
  content: z.string(),
  /** Workspace-relative file it was published from, if any. */
  path: z.string().nullable(),
});
/** A table (<= 5,000 rows and 2 MB, enforced by artifact.publish). */
export const DataArtifactData = z.object({
  format: z.enum(['csv', 'json']),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.unknown())),
  path: z.string().nullable(),
});
export const LinkArtifactData = z.object({ url: z.string(), label: z.string().nullable() });
/** A set of files in the workspace; contents are read with artifact.read. */
export const FilesArtifactData = z.object({
  /** Base folder the paths are relative to (relative to the workspace). */
  root: z.string(),
  files: z.array(
    z.object({ path: z.string(), size: z.int().nonnegative(), mimeType: z.string().nullable() }),
  ),
});

export const Artifact = z.discriminatedUnion('kind', [
  z.object({
    ...artifactBase,
    ...artifactDefaults('output'),
    kind: z.literal('document'),
    data: DocumentArtifactData,
  }),
  z.object({
    ...artifactBase,
    ...artifactDefaults('output'),
    kind: z.literal('data'),
    data: DataArtifactData,
  }),
  z.object({
    ...artifactBase,
    ...artifactDefaults('output'),
    kind: z.literal('link'),
    data: LinkArtifactData,
  }),
  z.object({
    ...artifactBase,
    ...artifactDefaults('output'),
    kind: z.literal('files'),
    data: FilesArtifactData,
  }),
  z.object({
    ...artifactBase,
    ...artifactDefaults('output', 'workspace_diff'),
    kind: z.literal('diff'),
    data: DiffArtifactData,
  }),
  z.object({
    ...artifactBase,
    ...artifactDefaults('evidence'),
    kind: z.literal('commit'),
    data: CommitArtifactData,
  }),
  z.object({
    ...artifactBase,
    ...artifactDefaults('evidence'),
    kind: z.literal('test_result'),
    data: TestResultArtifactData,
  }),
  z.object({
    ...artifactBase,
    ...artifactDefaults('output'),
    kind: z.literal('file'),
    data: FileArtifactData,
  }),
  z.object({
    ...artifactBase,
    ...artifactDefaults('output'),
    kind: z.literal('note'),
    data: NoteArtifactData,
  }),
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
  /** Integrator agent run of the latest conflict resolution (integration.resolveWithAgent). */
  resolverRunId: RunId.nullable().optional(),
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

/** How dangerous a tool use looks (decided by the daemon, not the agent). */
export const ToolRisk = z.enum(['low', 'medium', 'high']);
export type ToolRisk = z.infer<typeof ToolRisk>;

/** `Approval.payload` of a `tool_use` approval. */
export const ToolApprovalPayload = z.object({
  toolName: z.string(),
  input: z.unknown(),
  risk: ToolRisk,
  /** Daemon category of the tool use (e.g. "deps_add", "outside_read", "build_test"). */
  category: z.string().optional(),
  /** Why it was not decided automatically (Japanese). */
  reason: z.string().optional(),
  /**
   * What `approval.respond({ remember })` would remember, shown before the human picks a
   * scope (e.g. "コマンド「node scripts/test.js」を許可"). Null: it cannot be remembered.
   */
  rememberAs: z.string().nullable().optional(),
});
export type ToolApprovalPayload = z.infer<typeof ToolApprovalPayload>;

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

/**
 * How long an approved tool use is remembered (`approval.respond` `remember`): `once` (only
 * this use), `run` (the rest of this run), `task` (every run of this task), `project` (the
 * project's agents from now on, until revoked). Remembered approvals never override hard rules.
 */
export const ApprovalRemember = z.enum(['once', 'run', 'task', 'project']);
export type ApprovalRemember = z.infer<typeof ApprovalRemember>;

/**
 * A remembered approval: tool uses that match it are allowed without asking again. Matching:
 * the same tool, and for commands every part of the command line has one of `commandKeys`
 * (program plus subcommand, e.g. "pnpm add", "curl"); for paths, under `pathPrefix`.
 */
export const PermissionRule = z.object({
  id: PermissionRuleId,
  projectId: ProjectId,
  scope: z.enum(['run', 'task', 'project']),
  runId: RunId.nullable(),
  taskId: TaskId.nullable(),
  toolName: z.string(),
  commandKeys: z.array(z.string()).nullable(),
  pathPrefix: z.string().nullable(),
  /** Japanese one-liner, e.g. "コマンド「pnpm add」を許可". */
  description: z.string(),
  approvalId: ApprovalId.nullable(),
  createdBy: Actor,
  createdAt: Timestamp,
  revokedAt: Timestamp.nullable(),
  revokedBy: Actor.nullable(),
});
export type PermissionRule = z.infer<typeof PermissionRule>;

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
  /** Max unfinished children (session.spawn). Absent: `maxWorkers` is read instead. */
  maxChildren: z.int().nonnegative().optional(),
  /** Max schedules this subject may own (schedule.create). Absent: 5. */
  maxSchedules: z.int().nonnegative().optional(),
  /** Max delegation depth below this grant (0 = cannot delegate). */
  maxDepth: z.int().nonnegative().optional(),
});
export type GrantLimits = z.infer<typeof GrantLimits>;

/**
 * `run`: until the subject run ends. `session`: until revoked or `expiresAt`. `work`: until
 * the session's tree has settled (no active run, open attention, unfinished task or pending
 * inbox item in it). A session-subject grant with `run` is evaluated as `work`. Daemon
 * restarts end none of them.
 */
export const GrantLifetime = z.enum(['run', 'session', 'work']);
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

/** IANA time zone of this machine ("UTC" when unknown). */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export const SupervisorSettings = z.object({
  /** Model calls one supervisor run may make (then it fails with turn_limit). */
  maxModelCallsPerRun: z.int().min(1).max(500).default(24),
  /** Wakes without a human message per hour (then supervision pauses). */
  maxWakesPerHour: z.int().min(1).max(1000).default(30),
  /** How long wake items are gathered before a supervisor is woken. */
  wakeDebounceMs: z.int().min(0).max(60_000).default(1500),
  /** Latest messages sent to a supervisor each run (plus the tree snapshot and the goal). */
  contextMessages: z.int().min(1).max(1000).default(40),
});
export type SupervisorSettings = z.infer<typeof SupervisorSettings>;

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
  /** Agent runs (with a workspace) at once. An older config's maxConcurrentRuns is read. */
  maxConcurrentAgents: z.int().min(1).max(64).default(10),
  /** LLM-only runs (chats, supervisors) at once, separate from agents. */
  maxConcurrentChats: z.int().min(1).max(64).default(16),
  /** Spend limits, enforced by the usage ledger. */
  limits: z
    .object({
      /** USD per day across everything; null = no limit. */
      dailyUsd: z.number().min(0).nullable().default(20),
      /** IANA time zone the day is counted in. */
      timezone: z.string().min(1).default(localTimeZone),
    })
    .default(() => ({ dailyUsd: 20, timezone: localTimeZone() })),
  /** Max capability delegation depth (1 = orchestrator -> worker only). */
  maxDelegationDepth: z.int().min(0).max(4).default(1),
  /**
   * After a daemon restart, start a new run for orchestrators that were interrupted mid-plan
   * (when their grant is still valid). They continue from the persisted task states.
   */
  autoResumeOrchestrators: z.boolean().default(true),
  /**
   * After a restart, resume interrupted supervisors and child agents (once per interruption).
   * An older config's autoResumeOrchestrators is read.
   */
  autoResume: z.boolean().default(true),
  supervisor: SupervisorSettings.default({
    maxModelCallsPerRun: 24,
    maxWakesPerHour: 30,
    wakeDebounceMs: 1500,
    contextMessages: 40,
  }),
  /**
   * USD reserved from a run's budget before each LLM call of chat / orchestrator runs and
   * settled with the actual cost afterwards. A call that cannot reserve this much is refused,
   * so concurrent runs sharing a budget cannot overshoot it (as long as a call costs less).
   */
  llmCallReserveUsd: z.number().min(0).max(100).default(0.25),
  /** Permission profile of projects that do not set one. */
  defaultPermissionProfile: PermissionProfile.default('autonomous'),
  /**
   * Claude Code auto mode (its safety classifier decides the gray zone) for the Claude runtime
   * in the autonomous and standard profiles. `judge: server` (default): Anthropic's API judges
   * (used with the user's Claude login and behind LiteLLM; the CLI falls back to its own
   * classifier when the upstream does not answer). `judge: client`: the CLI's own classifier
   * request, to `classifierModel` or, when it is null, the CLI's default (Claude Sonnet 5).
   * When auto mode cannot judge (e.g. LiteLLM does not serve that model), the daemon's rules
   * decide.
   */
  autoMode: z
    .object({
      enabled: z.boolean().default(true),
      judge: AutoModeJudge.default('server'),
      /** LiteLLM model name for the classifier (passed as CLAUDE_CODE_AUTO_MODE_MODEL). */
      classifierModel: z.string().min(1).nullable().default(null),
      /** Estimated cost of one client-side classifier call (recorded in the usage ledger). */
      classifierCostUsd: z.number().min(0).max(10).default(0.011),
    })
    .default({ enabled: true, judge: 'server', classifierModel: null, classifierCostUsd: 0.011 }),
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
  autoResumeOrchestrators: z.boolean().optional(),
  llmCallReserveUsd: z.number().optional(),
  defaultPermissionProfile: PermissionProfile.optional(),
  autoMode: z
    .object({
      enabled: z.boolean(),
      /** Absent from older daemons (they always used the CLI's own classifier). */
      judge: AutoModeJudge.optional(),
      classifierModel: z.string().nullable(),
      classifierCostUsd: z.number().optional(),
    })
    .optional(),
  /** The fields below are absent from older daemons. */
  maxConcurrentAgents: z.int().optional(),
  maxConcurrentChats: z.int().optional(),
  limits: z.object({ dailyUsd: z.number().nullable(), timezone: z.string() }).optional(),
  autoResume: z.boolean().optional(),
  supervisor: SupervisorSettings.optional(),
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
