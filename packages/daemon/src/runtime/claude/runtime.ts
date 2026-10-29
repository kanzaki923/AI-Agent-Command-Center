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
import { decideToolPermission } from '../policy';
import { DISALLOWED_AGENT_TOOLS } from '../tools';
import { ACC_MCP_SERVER, type McpSdk, accMcpServer } from './mcp';
import type { ClaudeCodeLocation } from './locate';
import { ClaudeMessageNormalizer, type UsageTotals, ZERO_TOTALS } from './normalize';

/** The part of the SDK's `Query` we use. */
export interface QueryLike extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  close(): void;
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
}

export const CLAUDE_RUNTIME_ID = 'claude-agent-sdk';
const STDERR_TAIL_LINES = 20;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

class IdleTimeoutError extends Error {}

/** " 10 分" / " 30 秒" (for Japanese messages). */
function formatDuration(ms: number): string {
  return ms >= 60_000 ? ` ${Math.round(ms / 60_000)} 分` : ` ${Math.round(ms / 1000)} 秒`;
}

/**
 * Coding agent backed by @anthropic-ai/claude-agent-sdk (spawns the bundled Claude Code CLI).
 *
 * Fixed choices (verified against the real CLI: docs/snapshot/20261029_agent-sdk-real-cli.md):
 * - `permissionMode: 'default'` and `settingSources: []`: the user's / repository's settings
 *   files (hooks, allow rules) never apply. Consequence: the repository's CLAUDE.md is not
 *   loaded (TODO: opt-in per project).
 * - Tool permissions are enforced by a `PreToolUse` hook running our policy for EVERY tool
 *   use: the CLI auto-approves many tools without calling `canUseTool` (read-only Bash such
 *   as `git status`, Monitor, CronCreate, EnterWorktree, ...), and a hook is the one place
 *   that sees them all. The hook denies, asks (the CLI then calls `canUseTool`, which runs the
 *   same policy and our approval flow), or stays out of the way when the policy allows.
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
    const env = buildChildEnv(this.opts.parentEnv ?? process.env, routing, {
      ...(this.opts.clientApp ? { clientApp: this.opts.clientApp } : {}),
    });
    this.opts.log?.debug('starting claude agent', {
      runId: input.runId,
      routing: routing.kind,
      model: routing.model,
      resume: !!input.resumeSessionId,
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
    ): Promise<PermissionResult> => {
      approvalsPending += 1;
      try {
        const decision = await input.canUseTool({
          toolName,
          input: toolInput,
          ...(title ? { title } : {}),
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

    const policyFor = (toolName: string, toolInput: unknown, blockedPath?: string) =>
      decideToolPermission({ toolName, input: toolInput, cwd: input.cwd, blockedPath });

    /** Called by the CLI for tools it does not auto-approve, and for every hook "ask". */
    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      const policy = policyFor(toolName, toolInput, options.blockedPath);
      if (policy.decision === 'allow') return { behavior: 'allow', updatedInput: toolInput };
      if (policy.decision === 'deny') return { behavior: 'deny', message: policy.reason };
      return askHuman(toolName, toolInput, options.title);
    };

    /** Runs for every tool use, including the ones the CLI would auto-approve. */
    const preToolUse: HookCallback = async (hookInput): Promise<SyncHookJSONOutput> => {
      if (hookInput.hook_event_name !== 'PreToolUse') return {};
      const policy = policyFor(hookInput.tool_name, hookInput.tool_input);
      // "allow": leave it to the CLI, which may still ask (canUseTool re-runs the policy).
      if (policy.decision === 'allow') return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: policy.decision,
          permissionDecisionReason: policy.reason,
        },
      };
    };

    const stderrTail: string[] = [];
    const options: Options = {
      cwd: input.cwd,
      permissionMode: 'default',
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
    try {
      for (;;) {
        const r = await next();
        if (r.done) break;
        // After the result we only wait for the CLI to exit (it finishes writing the session
        // transcript, which resume depends on).
        if (norm.outcome) continue;
        const events = norm.push(r.value);
        // Once stopping, only the usage of the interrupted turn is still worth reporting.
        const stopping = signal.aborted || failure !== null;
        for (const ev of events) if (!stopping || ev.type === 'usage') yield ev;
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
    if (!norm.outcome.ok) throw new Error(norm.outcome.message);
  }
}
