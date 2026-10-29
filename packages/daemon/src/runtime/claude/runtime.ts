import type {
  CanUseTool,
  HookCallback,
  Options,
  PermissionResult,
  SDKUserMessage,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import type { Settings } from '@acc/protocol';
import type { AgentEvent, AgentRunInput, AgentRuntime } from '../../contracts';
import type { Logger } from '../../core/log';
import { AsyncQueue, abortError } from '../async';
import { buildChildEnv, envKeys, resolveModelRouting } from '../env';
import { GATE_NOTES, type GateResult, ToolGate, askReason } from '../gate';
import { DISALLOWED_AGENT_TOOLS } from '../tools';
import { ACC_MCP_SERVER, type McpSdk, accMcpServer } from './mcp';
import type { ClaudeCodeLocation } from './locate';
import { ClaudeMessageNormalizer, type UsageTotals, ZERO_TOTALS } from './normalize';
import type { ModelPrice } from '../../llm/pricing';
import { budgetExceeded } from '../../core/errors';

/** The part of the SDK's `Query` we use. */
export interface QueryLike extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  close(): void;
  /** Leave auto mode when its classifier cannot answer (optional for test doubles). */
  setPermissionMode?(mode: 'default'): Promise<unknown>;
}

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => QueryLike;

/** What `import('@anthropic-ai/claude-agent-sdk')` must provide. Injected in tests. */
export interface ClaudeSdkModule {
  query: QueryFn;
  /** For the in-process "acc" MCP server (optional so older test doubles still load). */
  tool?: McpSdk['tool'];
  createSdkMcpServer?: McpSdk['createSdkMcpServer'];
}

/** Remembers the SDK's cumulative usage per SDK session so resumed runs report deltas. */
export interface UsageBaselineStore {
  get(runtimeSessionId: string): UsageTotals | undefined;
  set(runtimeSessionId: string, totals: UsageTotals): void;
}

export class MemoryBaselineStore implements UsageBaselineStore {
  private readonly map = new Map<string, UsageTotals>();
  get(id: string): UsageTotals | undefined {
    return this.map.get(id);
  }
  set(id: string, totals: UsageTotals): void {
    this.map.set(id, totals);
  }
}

export interface ClaudeRuntimeOptions {
  /** Current settings (LiteLLM routing). Read at the start of every run. */
  settings: () => Settings;
  /** Defaults to a lazy `import('@anthropic-ai/claude-agent-sdk')`. */
  loadSdk?: () => Promise<ClaudeSdkModule>;
  /** Parent environment the child env is filtered from. Default: process.env. */
  parentEnv?: NodeJS.ProcessEnv;
  /** e.g. "acc/0.1.0". */
  clientApp?: string;
  pathToClaudeCodeExecutable?: string;
  /**
   * Finds the Claude Code CLI when `pathToClaudeCodeExecutable` is not given (`locate.ts`).
   * Called per run, so installing Claude Code takes effect without a restart. Without it the
   * SDK resolves its bundled binary itself (fails inside the single-file daemon bundle).
   */
  locateExecutable?: () => ClaudeCodeLocation;
  baselines?: UsageBaselineStore;
  log?: Logger;
  /** How long to wait for the CLI to exit after interrupt() / the result before close(). Default 5s. */
  interruptGraceMs?: number;
  /**
   * Fail the run when the CLI sends nothing for this long (time spent waiting for a human
   * approval does not count). Streaming sends events continuously, so silence this long
   * means a hung CLI or connection. Default 10 minutes.
   */
  idleTimeoutMs?: number;
  /**
   * Prices for live cost estimates (the LLM module's price book). Without it only the result's
   * final cost is reported.
   */
  pricing?: (model: string | null) => ModelPrice | null;
}

export const CLAUDE_RUNTIME_ID = 'claude-agent-sdk';

/** Tool uses the CLI's auto mode allows without a classifier request (no classifier cost). */
const CLASSIFIER_FREE: ReadonlySet<string> = new Set(['read', 'edit', 'command_readonly']);
const STDERR_TAIL_LINES = 20;

/**
 * Auto mode classifier settings (inline settings: the CLI reads `autoMode` only from user,
 * managed and inline settings, never from the repository). `$defaults` keeps the built-in
 * rules; ours describe the environment and repeat the daemon's hard rules (the PreToolUse
 * hook enforces them first; this is the second line for what the text check cannot see).
 *
 * Keep it a constant with no per-run text (no worktree path, task, project or run id): the
 * CLI's own classifier request starts with this text, and an identical prefix lets every
 * worker share the provider's prompt cache (measured: ~33k tokens, $0.126 to write cold and
 * about $0.011 per judgement while warm, shared across CLI sessions; see
 * docs/snapshot/20261029_auto-mode-cost.md). The CLI adds the cwd itself.
 */
export const AUTO_MODE_SETTINGS = {
  environment: [
    '$defaults',
    'You are an unattended worker agent of AI Agent Command Center. You work in an isolated git worktree (the current directory) that the daemon created for this task.',
    'Nobody answers questions during the run. The daemon commits the worktree when the run ends and integrates it into the protected branch only after a human approves. Pushing, publishing or changing remotes is never needed.',
    'Tests, builds, linters and installing dependencies from the manifest inside the worktree are the normal work of this agent.',
  ],
  hard_deny: [
    '$defaults',
    'Pushing to any remote, publishing packages or releases, changing git remotes, or switching / deleting branches.',
    'Writing outside the current worktree, or changing .git metadata, git config or hooks.',
    'Reading or sending credentials (~/.ssh, ~/.aws, ~/.claude, gh auth, tokens) or the AI Agent Command Center data directory.',
    'Starting other coding agents, or calling the AI Agent Command Center Control API directly.',
    'Starting processes that outlive the command (background jobs, services, containers) or changing system settings.',
  ],
  classifyAllShell: true,
};
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

class IdleTimeoutError extends Error {}

/** The gate's current mode (a call, so a check after a change is not narrowed away). */
function gateMode(gate: ToolGate): 'classifier' | 'rules' {
  return gate.mode;
}

/** " 10 分" / " 30 秒" (for Japanese messages). */
function formatDuration(ms: number): string {
  return ms >= 60_000 ? ` ${Math.round(ms / 60_000)} 分` : ` ${Math.round(ms / 1000)} 秒`;
}

/**
 * Coding agent backed by @anthropic-ai/claude-agent-sdk (spawns the bundled Claude Code CLI).
 *
 * Fixed choices (verified against the real CLI: docs/snapshot/20261029_agent-sdk-real-cli.md,
 * docs/snapshot/20261029_auto-mode.md):
 * - `settingSources: []`: the user's / repository's settings files (hooks, allow rules) never
 *   apply. Consequence: the repository's CLAUDE.md is not loaded (TODO: opt-in per project).
 * - Tool permissions are enforced by a `PreToolUse` hook running the run's gate (gate.ts) for
 *   EVERY tool use: the CLI auto-approves many tools without calling `canUseTool` (read-only
 *   Bash such as `git status`, Monitor, CronCreate, EnterWorktree, ...), and a hook is the one
 *   place that sees them all. The hook denies (hard rules, with the reason), asks (the CLI then
 *   calls `canUseTool`, which gets the same answer and our approval flow), or stays out of
 *   the way when the gate allows.
 * - `permissionMode: 'auto'` when the gate may use Claude Code's auto mode (the server review,
 *   or the CLI's own classifier with the user's Claude login or a classifier model LiteLLM
 *   serves), else `'default'`. In auto mode
 *   the hook returns nothing for the gray zone so the classifier decides; the run falls back
 *   to the rules when the CLI starts without auto mode or the classifier cannot answer.
 * - `disallowedTools`: tools that make no sense unattended (AskUserQuestion, plan mode,
 *   scheduling, own worktrees) are removed from the model's tool list.
 * - `env` replaces the child's whole environment: built from an allowlist (env.ts).
 * - The prompt is an AsyncIterable so `interrupt()` works; one turn per run.
 */
export class ClaudeAgentSdkRuntime implements AgentRuntime {
  readonly id = CLAUDE_RUNTIME_ID;
  readonly displayName = 'Claude Code (Agent SDK)';
  private sdk: Promise<ClaudeSdkModule> | null = null;
  private readonly baselines: UsageBaselineStore;

  constructor(private readonly opts: ClaudeRuntimeOptions) {
    this.baselines = opts.baselines ?? new MemoryBaselineStore();
  }

  private load(): Promise<ClaudeSdkModule> {
    if (!this.sdk) {
      const loader =
        this.opts.loadSdk ??
        (async (): Promise<ClaudeSdkModule> => await import('@anthropic-ai/claude-agent-sdk'));
      this.sdk = loader().then((m) => {
        if (typeof m?.query !== 'function') throw new Error('query() is not exported');
        return m;
      });
      // A failed load is retried on the next call (e.g. after the user installs it).
      this.sdk.catch(() => {
        this.sdk = null;
      });
    }
    return this.sdk;
  }

  /** Explicit path, else the locator's answer; `null` lets the SDK resolve it itself. */
  private executable(): ClaudeCodeLocation | null {
    if (this.opts.pathToClaudeCodeExecutable) {
      return { ok: true, path: this.opts.pathToClaudeCodeExecutable, source: 'env' };
    }
    return this.opts.locateExecutable?.() ?? null;
  }

  async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.load();
      const exe = this.executable();
      if (exe && !exe.ok) return { ok: false, reason: exe.reason };
      return { ok: true };
    } catch (err) {
      this.opts.log?.warn('claude agent sdk unavailable', { error: (err as Error).message });
      return {
        ok: false,
        reason:
          'Claude Agent SDK を読み込めませんでした。`pnpm install` で依存関係（@anthropic-ai/claude-agent-sdk）をインストールしてください',
      };
    }
  }

  /** A decision the CLI made itself (classifier, mode) → the gate records it. */
  private reportDecision(gate: ToolGate, ev: Extract<AgentEvent, { type: 'tool_decision' }>): void {
    // Our own hook / approval answers are recorded where they were made.
    if (ev.source === 'hook' || ev.source === 'human') return;
    gate.report({
      toolCallId: ev.toolCallId,
      toolName: ev.toolName,
      decision: ev.decision,
      decidedBy: ev.source,
      ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
      ...(ev.classifierUnavailable ? { classifierUnavailable: true } : {}),
      ...(ev.judge ? { judge: ev.judge } : {}),
    });
  }

  async *run(input: AgentRunInput): AsyncGenerator<AgentEvent, void, undefined> {
    const { signal } = input;
    if (signal.aborted) throw abortError(signal);

    let sdk: ClaudeSdkModule;
    try {
      sdk = await this.load();
    } catch (err) {
      throw new Error('Claude Agent SDK を読み込めませんでした', { cause: err });
    }
    const exe = this.executable();
    if (exe && !exe.ok) throw new Error(exe.reason);

    const routing = resolveModelRouting(this.opts.settings(), input.model);
    const gate = input.gate ?? new ToolGate({ cwd: input.cwd, profile: 'careful' });
    // Auto mode only where it can judge (docs/snapshot/20261029_auto-mode.md):
    // - judge "server": Anthropic's API reviews the tool uses (`safeguards` on the normal
    //   request, no extra call). Passes through LiteLLM; where the upstream does not answer,
    //   the CLI falls back to its own classifier, and when that cannot answer either (no
    //   classifier model served) the run falls back to the rules below.
    // - judge "client": the CLI's own classifier request, to `classifierModel` or, when it is
    //   empty, the CLI's default (Claude Sonnet 5). Behind LiteLLM that name must be served;
    //   when it is not, the classifier cannot answer and the run falls back to the rules.
    if (gate.autoMode) gate.useClassifier();
    const auto = gate.mode === 'classifier';
    const serverJudge = auto && gate.autoMode?.judge === 'server';
    const env = buildChildEnv(this.opts.parentEnv ?? process.env, routing, {
      ...(this.opts.clientApp ? { clientApp: this.opts.clientApp } : {}),
    });
    if (auto) {
      // Server review is the CLI's default (the variable unset); "0" classifies in the CLI.
      if (!serverJudge) env.CLAUDE_CODE_AUTO_MODE_SERVER = '0';
      // Also for the server judge: the model of the CLI's fallback classifier.
      if (routing.kind === 'litellm' && gate.autoMode?.classifierModel) {
        env.CLAUDE_CODE_AUTO_MODE_MODEL = gate.autoMode.classifierModel;
      }
    }
    this.opts.log?.debug('starting claude agent', {
      runId: input.runId,
      routing: routing.kind,
      model: routing.model,
      resume: !!input.resumeSessionId,
      permissionGate: gate.mode,
      judge: auto ? gate.judge : null,
      envKeys: envKeys(env),
    });

    const prompt = new AsyncQueue<SDKUserMessage>();
    prompt.push({
      type: 'user',
      message: { role: 'user', content: input.prompt },
      parent_tool_use_id: null,
    });

    // Approvals the CLI is waiting on (a human may take hours; that is not a hung CLI).
    let approvalsPending = 0;
    const askHuman = async (
      toolName: string,
      toolInput: Record<string, unknown>,
      title: string | undefined,
      asked: GateResult,
    ): Promise<PermissionResult> => {
      approvalsPending += 1;
      try {
        const decision = await input.canUseTool({
          toolName,
          input: toolInput,
          ...(title ? { title } : {}),
          category: asked.policy.category,
          reason: askReason(asked),
        });
        if (decision.decision === 'approved') {
          return { behavior: 'allow', updatedInput: toolInput };
        }
        return {
          behavior: 'deny',
          message: decision.note
            ? `The user rejected this tool use: ${decision.note}`
            : 'The user rejected this tool use.',
        };
      } catch (_err) {
        // Cancelled while waiting (or the approval flow failed): stop the turn.
        return { behavior: 'deny', message: 'The run was cancelled.', interrupt: true };
      } finally {
        approvalsPending -= 1;
      }
    };

    /**
     * Called by the CLI for tools it does not auto-approve, for every hook "ask", and in auto
     * mode when the classifier blocked the same action repeatedly (a use the gate deferred).
     */
    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      let r = gate.check({
        toolName,
        input: toolInput,
        ...(options.toolUseID ? { toolUseId: options.toolUseID } : {}),
        ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
      });
      if (r.action === 'defer') {
        r = gate.escalate({
          toolName,
          input: toolInput,
          ...(options.toolUseID ? { toolUseId: options.toolUseID } : {}),
        });
      }
      if (r.action === 'allow') return { behavior: 'allow', updatedInput: toolInput };
      if (r.action === 'deny') return { behavior: 'deny', message: r.message ?? r.policy.reason };
      return askHuman(toolName, toolInput, options.title, r);
    };

    /**
     * Cost of the CLI's own classifier requests (judge "client"): not in the SDK's totals, so
     * booked separately, one estimated `classifierCostUsd` per tool use left to it (§3.8-8).
     */
    const classifierCosts: AgentEvent[] = [];
    const classifierCostUsd = this.opts.settings().autoMode.classifierCostUsd;

    /** Runs for every tool use (sub-agents' too), including the ones the CLI would auto-approve. */
    const preToolUse: HookCallback = async (hookInput, toolUseID): Promise<SyncHookJSONOutput> => {
      if (hookInput.hook_event_name !== 'PreToolUse') return {};
      const id = toolUseID ?? hookInput.tool_use_id;
      const r = gate.check({
        toolName: hookInput.tool_name,
        input: hookInput.tool_input,
        ...(id ? { toolUseId: id } : {}),
      });
      // The CLI allows reads, in-workspace edits and read-only commands without asking its
      // classifier (docs/snapshot/20261029_auto-mode-cost.md): only the rest costs a request.
      const judged = !CLASSIFIER_FREE.has(r.policy.category);
      if (r.action === 'defer' && judged && gate.mode === 'classifier' && gate.judge === 'client') {
        if (classifierCostUsd > 0) {
          classifierCosts.push({
            type: 'usage',
            component: 'classifier',
            usage: { costUsd: classifierCostUsd, costSource: 'estimated' },
          });
        }
      }
      // "defer": the classifier decides. "allow" without auto mode: leave it to the CLI, which
      // may still ask (canUseTool returns the same answer). In auto mode an explicit allow
      // skips the classifier, so the gate gives one only for our own tools and remembered
      // approvals while the classifier is in charge.
      // A run that started in auto mode answers allows explicitly even after falling back to
      // the rules: the CLI may still be in auto mode until setPermissionMode lands.
      if (r.action === 'defer' || (r.action === 'allow' && !auto)) return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: r.action,
          permissionDecisionReason:
            r.action === 'deny' ? (r.message ?? r.policy.reason) : r.policy.reason,
        },
      };
    };

    const stderrTail: string[] = [];
    const options: Options = {
      cwd: input.cwd,
      permissionMode: auto ? 'auto' : 'default',
      ...(auto ? { settings: { autoMode: AUTO_MODE_SETTINGS } } : {}),
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: true,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(input.systemPrompt ? { append: input.systemPrompt } : {}),
      },
      env,
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      disallowedTools: [...DISALLOWED_AGENT_TOOLS],
      stderr: (data: string) => {
        stderrTail.push(...data.split(/\r?\n/).filter(Boolean));
        if (stderrTail.length > STDERR_TAIL_LINES) {
          stderrTail.splice(0, stderrTail.length - STDERR_TAIL_LINES);
        }
      },
      ...(routing.model ? { model: routing.model } : {}),
      ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
      // Counts only this query()'s spend, also on resume (Q1, sdk-contract.test.ts).
      ...(input.maxBudgetUsd !== null && input.maxBudgetUsd > 0
        ? { maxBudgetUsd: input.maxBudgetUsd }
        : {}),
      ...(exe?.ok ? { pathToClaudeCodeExecutable: exe.path } : {}),
    };
    // Control API read access for the agent: an in-process MCP server "acc" with the tools
    // the run's grant allows (calls go through the dispatcher as the run's agent actor).
    const acc =
      sdk.tool && sdk.createSdkMcpServer
        ? accMcpServer(
            { tool: sdk.tool, createSdkMcpServer: sdk.createSdkMcpServer },
            input.tools,
            signal,
          )
        : null;
    if (acc) options.mcpServers = { [ACC_MCP_SERVER]: acc.server };

    const baseline =
      (input.resumeSessionId && this.baselines.get(input.resumeSessionId)) || ZERO_TOTALS;
    const norm = new ClaudeMessageNormalizer(input.cwd, baseline, {
      expectedTools: acc?.toolNames ?? [],
      serverJudge,
      ...(this.opts.pricing ? { price: this.opts.pricing } : {}),
    });
    const q = sdk.query({ prompt, options });

    const graceMs = this.opts.interruptGraceMs ?? 5000;
    const idleMs = this.opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    let graceTimer: NodeJS.Timeout | undefined;
    let forcedClose = false;
    const closeNow = () => {
      try {
        q.close();
      } catch {
        // already closed
      }
    };
    /** Force-close the CLI if it has not exited `graceMs` after we asked it to stop. */
    const closeLater = () => {
      if (graceTimer) return;
      graceTimer = setTimeout(() => {
        forcedClose = true;
        closeNow();
      }, graceMs);
    };
    /**
     * Stop the turn: interrupt first (the CLI ends the turn, usually with a result, and writes
     * its transcript), then end the input so it exits, and kill it only after the grace period.
     */
    const stop = () => {
      q.interrupt().catch(() => {});
      prompt.close();
      closeLater();
    };
    signal.addEventListener('abort', stop, { once: true });

    const it = q[Symbol.asyncIterator]();
    /** The next message, or IdleTimeoutError after `idleMs` of silence (approvals excepted). */
    const next = () =>
      new Promise<IteratorResult<unknown>>((resolve, reject) => {
        let timer: NodeJS.Timeout;
        const arm = () => {
          timer = setTimeout(() => {
            if (approvalsPending > 0) arm();
            else reject(new IdleTimeoutError());
          }, idleMs);
        };
        arm();
        it.next().then(
          (r) => {
            clearTimeout(timer);
            resolve(r);
          },
          (err: unknown) => {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      });

    let failure: Error | null = null;
    let fellBack = false;
    try {
      for (;;) {
        const r = await next();
        if (r.done) break;
        // After the result we only wait for the CLI to exit (it finishes writing the session
        // transcript, which resume depends on).
        if (norm.outcome) continue;
        const events = norm.push(r.value);
        // Auto mode requested but the CLI started without it (a model it does not support).
        if (gate.mode === 'classifier' && norm.permissionMode && norm.permissionMode !== 'auto') {
          gate.useRules(GATE_NOTES.unsupportedModel);
        }
        // The upstream does not do the server review: the CLI's own classifier judges now.
        if (norm.serverJudgeLost) gate.judgeLocally();
        // Once stopping, only the usage of the interrupted turn is still worth reporting.
        const stopping = signal.aborted || failure !== null;
        for (const ev of events) {
          if (ev.type === 'tool_decision') {
            this.reportDecision(gate, ev);
            continue;
          }
          if (!stopping || ev.type === 'usage') yield ev;
          if (ev.type === 'tool_result') gate.settle(ev.toolCallId);
        }
        // Money spent even when stopping.
        while (classifierCosts.length > 0) yield classifierCosts.shift()!;
        // The classifier failed (e.g. its model is not served): the rules decide from now on.
        if (auto && gateMode(gate) === 'rules' && !fellBack) {
          fellBack = true;
          if (norm.permissionMode === 'auto') q.setPermissionMode?.('default').catch(() => {});
        }
        if (norm.fatal && !failure) {
          failure = new Error(norm.fatal);
          stop();
          continue;
        }
        if (norm.outcome) {
          // The CLI has saved the session's totals in its transcript by now (observed: a resume
          // continues from them even when the CLI is killed right after the result).
          const totals = norm.baselineTotals;
          if (norm.sessionId && totals) this.baselines.set(norm.sessionId, totals);
          // One turn per run: end the input so the CLI exits after this result.
          prompt.close();
          closeLater();
        }
      }
      while (classifierCosts.length > 0) yield classifierCosts.shift()!;
      if (!signal.aborted) for (const ev of norm.finish()) yield ev;
    } catch (err) {
      if (signal.aborted) throw abortError(signal);
      if (err instanceof IdleTimeoutError) {
        stop();
        throw new Error(`Claude Code から${formatDuration(idleMs)}以上応答がないため停止しました`, {
          cause: err,
        });
      }
      // Errors while draining after a result (e.g. force-closed) do not change the outcome.
      if (!norm.outcome && !failure) {
        const tail = stderrTail.join('\n');
        this.opts.log?.warn('claude agent failed', {
          runId: input.runId,
          error: (err as Error).message,
        });
        throw new Error(
          `Claude Code が異常終了しました: ${(err as Error).message}${tail ? `\n${tail}` : ''}`,
          { cause: err },
        );
      }
    } finally {
      signal.removeEventListener('abort', stop);
      if (graceTimer) clearTimeout(graceTimer);
      prompt.close();
      closeNow();
    }

    if (forcedClose) {
      this.opts.log?.warn('claude agent did not exit in time; closed it', { runId: input.runId });
    }

    if (signal.aborted) throw abortError(signal);
    if (failure) throw failure;
    if (!norm.outcome) throw new Error('Claude Code が結果を返さずに終了しました');
    if (!norm.outcome.ok) {
      const { message, code } = norm.outcome;
      // The run's spend cap (maxBudgetUsd): the run manager stops it as budget_exhausted.
      if (code === 'budget_exceeded') throw budgetExceeded(message, { reason: 'max_budget_usd' });
      throw Object.assign(new Error(message), code ? { code } : {});
    }
  }
}
