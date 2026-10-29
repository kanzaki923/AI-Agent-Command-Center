/**
 * Cross-module service contracts.
 *
 * Modules are built in parallel, so the seams between them are fixed here first.
 * Each interface is implemented by exactly one module and looked up with
 * `ctx.service(name)` at call time. Change a contract only together with every
 * implementer and caller.
 */
import type {
  Actor,
  Approval,
  ApprovalKind,
  Attention,
  AttentionChoice,
  AttentionKind,
  AttentionRefs,
  BudgetAllocation,
  BudgetSubject,
  ContentPart,
  CostSource,
  InboxItem,
  InboxItemKind,
  InboxItemRefs,
  LedgerComponent,
  MethodName,
  Params,
  Result,
  Run,
  RunKind,
  RunPermission,
  RunTrigger,
  ScheduleOutcome,
  SendDelivery,
  Session,
  StreamingMessage,
  Usage,
  Workspace,
} from '@acc/protocol';
import type { ToolDecisionRecord, ToolGate } from './runtime/gate';
import type { PermissionRuleService } from './runtime/rules';

// ---------------------------------------------------------------------------
// runs (implemented by src/runs)
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
  kind: ApprovalKind;
  title: string;
  detail?: string | null;
  /** Kind-specific data, e.g. `ToolApprovalPayload` (`{ toolName, input, risk }`) for tool_use. */
  payload?: unknown;
}

export type ApprovalDecision =
  { decision: 'approved'; note?: string | null } | { decision: 'rejected'; note?: string | null };

/**
 * Handed to a RunExecutor while its run is `running`. Everything an executor does that
 * other clients should see goes through here, so status, events and persistence stay
 * consistent no matter which executor runs.
 */
export interface RunController {
  readonly run: Run;
  /** Aborted on run.cancel, daemon shutdown, or budget exhaustion. */
  readonly signal: AbortSignal;
  /** The actor this run acts as when it calls the Control API (`ctx.call(actor, ...)`). */
  readonly actor: Extract<Actor, { kind: 'agent' }>;
  /**
   * Stream a fragment of an in-progress assistant message (ephemeral, not persisted).
   * `kind` defaults to "text"; "reasoning" is for model thinking shown separately.
   */
  emitDelta(messageId: string, text: string, kind?: 'text' | 'reasoning'): void;
  /** Persist a message of this run's session (emits message.created). */
  appendMessage(input: {
    role: 'assistant' | 'tool' | 'system';
    content: ContentPart[];
    id?: string;
    model?: string | null;
  }): void;
  /** Record a tool call / result (emits tool.called / tool.result). */
  toolCalled(call: { toolCallId: string; name: string; input: unknown }): void;
  toolResult(result: {
    toolCallId: string;
    name: string;
    output: unknown;
    isError?: boolean;
  }): void;
  /**
   * Ask for a decision. Moves the run to `awaiting_approval` until resolved, then back to
   * `running`. Rejects with an AbortError if the run is cancelled while waiting.
   */
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
  /**
   * Add usage (tokens / cost) to the run and record the cost as spend on the run's budget
   * (for runtimes that only report cost afterwards). Stops the run when the budget is used up.
   * `phase: 'estimate'` is counted now and replaced by the next `final` report (the
   * difference is booked as an `adjust` ledger row); `component: 'classifier'` is the auto
   * mode classifier's cost, outside that correction. See AgentEvent `usage`.
   */
  reportUsage(delta: Partial<Usage>, opts?: UsageReportOptions): void;
  /**
   * Reserve budget for one LLM call before making it (architecture.md §2.5). The amount is
   * `estimateUsd` (default `settings.llmCallReserveUsd`); a call whose reservation does not
   * fit is refused with `budget_exceeded`, so concurrent runs sharing a budget cannot
   * overshoot it. Without a budget the hold only reports usage.
   */
  reserveBudget(estimateUsd?: number): BudgetHold;
  /** Throw `budget_exceeded` when the run's budget has nothing left (no-op without a budget). */
  assertBudgetLeft(): void;
  /** Short "what is it doing now" line shown in Command Mode (e.g. "npm test を実行中"). */
  setActivity(text: string | null): void;
  /**
   * Record how a tool use was decided: `tool.decided` (unless routine) and the counts on
   * `Run.toolDecisions` (run.updated `["toolDecisions"]`, batched for routine decisions).
   */
  recordToolDecision(d: ToolDecisionRecord): void;
  /** How this run decides tool uses (run.updated `["permission"]`). */
  setPermission(p: RunPermission): void;
}

/** How a usage report is booked (RunController.reportUsage). */
export interface UsageReportOptions {
  /** Default `final`. */
  phase?: 'estimate' | 'final';
  /** Default: from the run kind (agent / llm). */
  component?: 'classifier';
}

/** Budget held for one LLM call (RunController.reserveBudget). Settle or cancel it once. */
export interface BudgetHold {
  /** USD reserved (0 when the run has no budget). */
  readonly amountUsd: number;
  /** Report the call's usage on the run and settle its cost against the reservation. */
  settle(usage: Partial<Usage>): void;
  /** Free the reservation without spending (the call failed before it reported usage). */
  cancel(): void;
}

/**
 * Executes one run. Resolve when the run's work is done (the run becomes `completed`);
 * throw to fail it. Executors never set terminal statuses themselves.
 */
export type RunExecutor = (ctl: RunController) => Promise<void>;

export interface StartRunInput {
  sessionId: string;
  kind: RunKind;
  createdBy: Actor;
  taskId?: string | null;
  projectId?: string | null;
  workspaceId?: string | null;
  parentRunId?: string | null;
  retryOfRunId?: string | null;
  model?: string | null;
  runtime?: string | null;
  budgetId?: string | null;
  triggerMessageId?: string | null;
  /** What started the run (default 'user'). */
  trigger?: RunTrigger;
}

export interface RunsService {
  /** Register the executor for a run kind ('chat' | 'agent' | 'orchestrator'). */
  registerExecutor(kind: RunKind, executor: RunExecutor): void;
  /** Create a run and queue it; starts as soon as a concurrency slot (and workspace lock) is free. */
  start(input: StartRunInput): Run;
  cancel(runId: string, actor: Actor, reason?: string): Run;
  /** Resolves when the run reaches a terminal status. */
  waitForEnd(runId: string, signal?: AbortSignal): Promise<Run>;
  resolveApproval(approvalId: string, decision: ApprovalDecision, actor: Actor): Approval;
  /**
   * While a run blocks waiting on other runs (task.wait / integration.wait), its execution
   * slot goes to queued runs — otherwise an orchestrator could wait forever on workers that
   * never get a slot. Call the returned function when the wait ends; the run then counts
   * again (briefly over the limit if the slot was used meanwhile).
   */
  lendSlot(runId: string): () => void;
  /** Start queued runs that can start now (after a lock was freed outside the runs module). */
  pump(): void;
}

// ---------------------------------------------------------------------------
// budget (implemented by src/policy)
// ---------------------------------------------------------------------------

export interface BudgetReservation {
  readonly id: string;
  readonly budgetId: string;
  readonly amountUsd: number;
}

export interface BudgetService {
  get(budgetId: string): BudgetAllocation;
  /** Create a root allocation (human/system only — enforced by the caller's method). */
  createRoot(input: { subject: BudgetSubject; limitUsd: number; actor: Actor }): BudgetAllocation;
  /** Carve a child allocation out of the parent's unallocated amount. Throws budget_exceeded. */
  allocate(input: {
    parentId: string;
    subject: BudgetSubject;
    limitUsd: number;
    actor: Actor;
  }): BudgetAllocation;
  /** Return a child's unused amount to its parent and close it. */
  release(budgetId: string, actor: Actor): BudgetAllocation;
  /** Reserve before an LLM call. Throws budget_exceeded when it does not fit. */
  reserve(budgetId: string, amountUsd: number): BudgetReservation;
  /** Turn a reservation into spend (actual may differ from reserved; excess is freed). */
  settle(reservation: BudgetReservation, actualUsd: number): void;
  /** Free a reservation without spending (e.g. the call failed before any usage). */
  cancelReservation(reservation: BudgetReservation): void;
  /** Record spend that had no reservation (e.g. a runtime that reports cost afterwards). */
  recordSpend(budgetId: string, amountUsd: number): void;
  /** Correct recorded spend by a signed amount (an estimate replaced by the final figure). */
  adjustSpend(budgetId: string, deltaUsd: number): void;
  /**
   * Raise a budget's limit. A child is topped up from its parent (an ancestor without enough
   * free is raised too). Humans / system only.
   */
  raise(budgetId: string, addUsd: number, actor: Actor): BudgetAllocation;
  /** Set a limit: raising as `raise`; lowering returns the difference to the parent. Humans only. */
  setLimit(budgetId: string, limitUsd: number, actor: Actor): BudgetAllocation;
  /**
   * What the budget can still spend: its own free amount, capped by any ancestor that is
   * over its limit (a child's overrun is carried up to the root). `limitedBy` is the budget
   * that set the cap.
   */
  available(budgetId: string): { freeUsd: number; limitedBy: string };
  /**
   * A released child budget carved again from its parent (same limit, capped by what the
   * parent has free) for a retry or a resume. Null when nothing is free or it had no parent.
   */
  reallocate(budgetId: string, actor: Actor): BudgetAllocation | null;
}

// ---------------------------------------------------------------------------
// workspaces (implemented by src/workspace)
// ---------------------------------------------------------------------------

export interface WorkspaceLock {
  readonly workspaceId: string;
  readonly runId: string;
  release(): void;
}

export interface WorkspacesService {
  /** Create a git worktree for a project on a fresh branch from `baseRef` (default: project default branch). */
  createWorktree(input: {
    projectId: string;
    branch?: string;
    baseRef?: string;
    label?: string;
    /** Task the workspace is created for (stored as Workspace.taskId). */
    taskId?: string | null;
    actor: Actor;
  }): Promise<Workspace>;
  get(workspaceId: string): Workspace;
  /** Exclusive write lock for a run. Throws `conflict` if another run holds it. */
  acquire(workspaceId: string, runId: string): WorkspaceLock;
  isLocked(workspaceId: string): boolean;
  /** Commit everything in the worktree (no-op if clean). Returns the new commit sha or null. */
  commitAll(workspaceId: string, message: string, actor: Actor): Promise<string | null>;
  /**
   * Unified diff + stats of the workspace (including uncommitted and untracked changes)
   * against the merge-base with `baseRef` (default: the workspace's own baseRef).
   */
  diff(
    workspaceId: string,
    baseRef?: string,
  ): Promise<{
    patch: string;
    files: { path: string; status: string; additions: number; deletions: number }[];
  }>;
}

// ---------------------------------------------------------------------------
// runtimes (implemented by src/runtime)
// ---------------------------------------------------------------------------

/** Normalized event stream every coding-agent runtime produces. */
export type AgentEvent =
  | { type: 'text_delta'; messageId: string; text: string }
  | { type: 'message'; messageId: string; role: 'assistant'; content: ContentPart[] }
  | { type: 'tool_call'; toolCallId: string; name: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; name: string; output: unknown; isError?: boolean }
  | { type: 'activity'; text: string | null }
  /**
   * Usage of one model call. `estimate`: counted while the call runs (from token counts and a
   * price table); `final`: the runtime's own figure, which replaces the estimates (absent =
   * final, as before the ledger).
   */
  | {
      type: 'usage';
      usage: Partial<Usage>;
      phase?: 'estimate' | 'final';
      /** `classifier`: the auto mode classifier's own requests (not in the runtime's totals). */
      component?: 'classifier';
    }
  | { type: 'session'; runtimeSessionId: string }
  /**
   * How the runtime itself decided a tool use (Claude Code: the auto mode classifier's
   * denials, `tool_result_meta`). Runtimes hand these to their gate; executors ignore them.
   */
  | {
      type: 'tool_decision';
      toolCallId: string;
      toolName: string;
      decision: 'allowed' | 'denied';
      /** classifier / runtime (the CLI's mode), hook / human (our own answers, ignored). */
      source: 'classifier' | 'runtime' | 'hook' | 'human';
      reason?: string | null;
      /** The classifier could not answer at all (not a judgement). */
      classifierUnavailable?: boolean;
      /** For `source: classifier`: the server review or the CLI's own classifier, when known. */
      judge?: 'server' | 'client';
    };

export interface AgentRunInput {
  runId: string;
  /** Working directory (the worktree). */
  cwd: string;
  /** Where the agent may write (its workspace; usually `cwd`). */
  writeRoot: string;
  /** Extra folders it may read (the project's folder / repository, attachments). */
  readRoots: string[];
  /**
   * Spend cap for this run in USD (min of the budget's free amount and what is left today),
   * passed to runtimes that can stop themselves (Claude: `maxBudgetUsd`). Null: no cap.
   */
  maxBudgetUsd: number | null;
  prompt: string;
  systemPrompt?: string;
  model?: string | null;
  /** Previous runtime session to resume, if the runtime supports it. */
  resumeSessionId?: string | null;
  signal: AbortSignal;
  /**
   * Ask a human about a tool use the gate could not decide. `category` / `reason` come from
   * the gate (shown on the approval card).
   */
  canUseTool(req: {
    toolName: string;
    input: unknown;
    title?: string;
    category?: string;
    reason?: string;
  }): Promise<ApprovalDecision>;
  /**
   * Decides tool uses (hard rules, remembered approvals, the profile, the classifier) and
   * records the decisions. Without one, runtimes use the careful profile and record nothing.
   */
  gate?: ToolGate;
  /**
   * Control API methods the run's grant allows (read-only for workers by default). Runtimes
   * that support custom tools expose them to the agent (Claude: in-process MCP server "acc").
   */
  tools?: AgentTool[];
}

/** A Control API method offered to an agent as a tool. */
export interface AgentTool {
  /** Control API method, e.g. "task.get" (params schema: `api[method].params`). */
  method: MethodName;
  description: string;
  /** Calls the method through the dispatcher as the run's agent actor (grants enforced there). */
  execute(input: unknown, opts: { signal: AbortSignal }): Promise<unknown>;
}

export interface AgentRuntime {
  readonly id: string;
  readonly displayName: string;
  /** False when prerequisites are missing (e.g. SDK not installed); the reason is user-facing Japanese. */
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
}

export interface RuntimesService {
  register(runtime: AgentRuntime): void;
  get(id: string): AgentRuntime;
  list(): AgentRuntime[];
  /** Runtime used when a session does not name one (settings, falling back to 'mock'). */
  defaultId(): string;
}

// ---------------------------------------------------------------------------
// Redesign services (spec 20261029 §3.1). Core fixes the contracts and ships no-op stubs;
// each track implements its own. architecture.md §2.13-§2.19.
// ---------------------------------------------------------------------------

/** inbox (src/inbox, T1): the only entry point that starts, injects or queues work. */
export interface InboxDeliverInput {
  kind: InboxItemKind;
  refs?: InboxItemRefs;
  actor: Actor;
  /** Messages to a busy agent: stop its current run (`superseded`) and start a new one now. */
  interrupt?: boolean;
  /** Model override of the run a message starts (session.send `model`). */
  model?: string | null;
}

export interface InboxDeliverResult {
  /** The stored item; null when nothing was stored. */
  item: InboxItem | null;
  /** started: a new run; injected: the running run takes it at its next step; queued: later. */
  delivery: SendDelivery;
  runId: string | null;
}

export interface InboxService {
  /** Decide whether the item starts a run, is injected at the next step, or waits (§3.2). */
  deliver(sessionId: string, input: InboxDeliverInput): InboxDeliverResult;
  /** Pending items to hand to a running run at a step boundary; marks them consumed by it. */
  drain(runId: string): InboxItem[];
}

/** Extra inputs of a spawn that only the daemon sets (schedules). */
export interface SpawnOptions {
  scheduleId?: string | null;
  /** Firing time, for the first message's `meta.schedule`. */
  scheduledFor?: string | null;
  trigger?: RunTrigger;
  /**
   * The child's budget as decided by the daemon (schedules, §3.11), instead of carving it from
   * the requester's run: `limitUsd` carved from `parentBudgetId` (an AI-made schedule: its
   * creator's budget), or a new root budget when null (a human-made schedule). Spawning fails
   * with budget_exceeded when it does not fit.
   */
  budget?: { parentBudgetId: string | null; limitUsd: number } | null;
  /**
   * The child may lead children of its own (a human-made schedule with `run.supervise`), an
   * exception to the delegation depth.
   */
  supervise?: boolean;
}

/** spawner (src/sessions/spawn.ts, T2): `session.spawn` and schedule firings. */
export interface SpawnerService {
  spawn(
    params: Params<'session.spawn'>,
    actor: Actor,
    opts?: SpawnOptions,
  ): Promise<Result<'session.spawn'>>;
}

/** outputs (src/outputs + integration/artifacts.ts, T3). */
export interface FinalizeResult {
  /** The outputs need a human's (or the requester's) decision before the work is done. */
  needsReview: boolean;
  artifactIds: string[];
}

export interface OutputsService {
  /** Settle a child's outputs when its run ended (§3.4): published > diff > writes > final text. */
  finalize(run: Run): Promise<FinalizeResult>;
}

/** attention (src/attention, T4). */
export interface OpenAttentionInput {
  kind: AttentionKind;
  sessionId: string;
  /** One line, no ids or JSON. */
  title: string;
  detail?: string | null;
  /** Default: the kind's choices (ATTENTION_DEFAULT_CHOICES). */
  choices?: AttentionChoice[];
  allowText?: boolean;
  refs: AttentionRefs;
  actor: Actor;
}

export interface AttentionResolutionInput {
  choiceId?: string | null;
  text?: string | null;
  by: Actor;
}

export interface AttentionService {
  /** Open an item; an open item with the same refs is returned instead of a duplicate. */
  open(input: OpenAttentionInput): Attention | null;
  /**
   * Resolve every open item whose refs match all given refs (the cause went away), or only
   * those of the given kinds.
   */
  resolveWhere(
    refs: AttentionRefs,
    resolution: AttentionResolutionInput,
    kinds?: readonly AttentionKind[],
  ): Attention[];
  /**
   * Close one open item by id (for causes no ref names, e.g. the daily limit). Throws
   * conflict when it is no longer open.
   */
  close(
    attentionId: string,
    status: 'resolved' | 'dismissed',
    resolution: AttentionResolutionInput,
  ): Attention;
  /** Act on an item (attention.respond): routes to approval / retry / stop / review / budget. */
  respond(
    attentionId: string,
    input: { choiceId?: string | null; text?: string | null },
    actor: Actor,
  ): Promise<Attention>;
}

/** One row of the usage ledger (spec §1.10). */
export interface LedgerEntry {
  /** Default: now. */
  ts?: string;
  sessionId: string | null;
  runId: string | null;
  projectId?: string | null;
  model?: string | null;
  component: LedgerComponent;
  /** USD; negative only for `adjust`. */
  costUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  source: CostSource;
}

/** ledger (src/cost, T5): the only writer of Session.cost. */
export interface LedgerService {
  /** Record usage (inside the caller's transaction) and add it to Session.cost up the tree. */
  record(entry: LedgerEntry): void;
  /** USD recorded today (settings.limits.timezone). */
  usedToday(): number;
  /**
   * Throw budget_exceeded (`data.reason: 'daily_limit'`) when the daily limit is used up, and
   * notify once (`cost.limit_reached`, a `budget` attention on `sessionId`).
   */
  assertDailyLeft(sessionId?: string | null): void;
  /** USD left today (null: no daily limit). */
  dailyLeft(): number | null;
}

/** scheduler (src/schedules, T6). */
export interface SchedulerService {
  /** Re-arm the single timer for the nearest nextRunAt. */
  rearm(): void;
  fire(
    scheduleId: string,
    scheduledFor: string,
  ): Promise<{ sessionId: string | null; outcome: ScheduleOutcome }>;
}

/** sessionState (src/home, T7): the only writer of Session.state / stateSince / now. */
export interface SessionStateService {
  /** Re-derive the session's state (§3.7) and its ancestors'; returns the session. */
  recompute(sessionId: string): Session | null;
  /**
   * Whether the session's tree below it has settled (§1.8): no active run, open attention,
   * unfinished task or pending inbox item in the session or its descendants. Grants with
   * lifetime `work` end then.
   */
  isWorkSettled(sessionId: string): boolean;
}

/** streams (src/home/streams.ts, T7): text being streamed, for session.messages `streaming`. */
export interface StreamsService {
  append(runId: string, messageId: string, kind: 'text' | 'reasoning', text: string): void;
  snapshot(sessionId: string): StreamingMessage | null;
}

declare module './core/context' {
  interface Services {
    inbox: InboxService;
    spawner: SpawnerService;
    outputs: OutputsService;
    attention: AttentionService;
    ledger: LedgerService;
    scheduler: SchedulerService;
    sessionState: SessionStateService;
    streams: StreamsService;
    runs: RunsService;
    budget: BudgetService;
    workspaces: WorkspacesService;
    runtimes: RuntimesService;
    /** Remembered tool approvals (runtime module). */
    permissionRules: PermissionRuleService;
  }
}
