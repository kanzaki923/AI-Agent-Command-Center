import type {
  CanUseTool,
  Options,
  PermissionResult,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Settings } from '@acc/protocol';
import type { AgentEvent, AgentRunInput, AgentRuntime } from '../../contracts';
import type { Logger } from '../../core/log';
import { AsyncQueue, abortError } from '../async';
import { buildChildEnv, envKeys, resolveModelRouting } from '../env';
import { decideToolPermission } from '../policy';
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
  baselines?: UsageBaselineStore;
  log?: Logger;
  /** How long to wait for the CLI to stop after interrupt() before close(). Default 5s. */
  interruptGraceMs?: number;
}

export const CLAUDE_RUNTIME_ID = 'claude-agent-sdk';
const STDERR_TAIL_LINES = 20;

/**
 * Coding agent backed by @anthropic-ai/claude-agent-sdk (spawns the bundled Claude Code CLI).
 *
 * Fixed choices (docs/snapshot/20261029_claude-agent-sdk-research.md):
 * - `permissionMode: 'default'` explicitly (omitting it may enable the model-based "auto" mode).
 * - `settingSources: []`: the user's / repository's settings files (hooks, allow rules) never
 *   apply, so every tool permission goes through our policy and approval flow.
 *   Consequence: the repository's CLAUDE.md is not loaded (TODO: opt-in per project).
 * - `env` replaces the child's whole environment: built from an allowlist (env.ts).
 * - The prompt is an AsyncIterable so `interrupt()` works.
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

  async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.load();
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

    const stderrTail: string[] = [];
    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      const policy = decideToolPermission({
        toolName,
        input: toolInput,
        cwd: input.cwd,
        blockedPath: options.blockedPath,
      });
      if (policy.decision === 'allow') {
        return { behavior: 'allow', updatedInput: toolInput } satisfies PermissionResult;
      }
      try {
        const decision = await input.canUseTool({
          toolName,
          input: toolInput,
          ...(options.title ? { title: options.title } : {}),
        });
        if (decision.decision === 'approved') {
          return { behavior: 'allow', updatedInput: toolInput } satisfies PermissionResult;
        }
        return {
          behavior: 'deny',
          message: decision.note
            ? `The user rejected this tool use: ${decision.note}`
            : 'The user rejected this tool use.',
        } satisfies PermissionResult;
      } catch (_err) {
        // Cancelled while waiting (or the approval flow failed): stop the turn.
        return {
          behavior: 'deny',
          message: 'The run was cancelled.',
          interrupt: true,
        } satisfies PermissionResult;
      }
    };

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
      stderr: (data: string) => {
        stderrTail.push(...data.split(/\r?\n/).filter(Boolean));
        if (stderrTail.length > STDERR_TAIL_LINES) {
          stderrTail.splice(0, stderrTail.length - STDERR_TAIL_LINES);
        }
      },
      ...(routing.model ? { model: routing.model } : {}),
      ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
      ...(this.opts.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: this.opts.pathToClaudeCodeExecutable }
        : {}),
    };

    const baseline =
      (input.resumeSessionId && this.baselines.get(input.resumeSessionId)) || ZERO_TOTALS;
    const norm = new ClaudeMessageNormalizer(input.cwd, baseline);
    const q = sdk.query({ prompt, options });

    const graceMs = this.opts.interruptGraceMs ?? 5000;
    let graceTimer: NodeJS.Timeout | undefined;
    /** Force-close the CLI if it has not exited `graceMs` after we asked it to stop. */
    const closeLater = () => {
      if (graceTimer) return;
      graceTimer = setTimeout(() => {
        try {
          q.close();
        } catch {
          // already closed
        }
      }, graceMs);
    };
    const onAbort = () => {
      prompt.close();
      q.interrupt().catch(() => {});
      closeLater();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      for await (const msg of q) {
        if (signal.aborted) break;
        // After the result we only wait for the CLI to exit (it finishes writing the
        // session transcript, which resume depends on).
        if (norm.outcome) continue;
        for (const ev of norm.push(msg)) yield ev;
        if (norm.outcome) {
          // One turn per run: end the input so the CLI exits after this result.
          prompt.close();
          if (norm.sessionId) this.baselines.set(norm.sessionId, norm.usageTotals);
          closeLater();
        }
      }
      for (const ev of norm.finish()) yield ev;
    } catch (err) {
      if (signal.aborted) throw abortError(signal);
      // Errors while draining after a result (e.g. force-closed) do not change the outcome.
      if (!norm.outcome) {
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
      signal.removeEventListener('abort', onAbort);
      if (graceTimer) clearTimeout(graceTimer);
      prompt.close();
      try {
        q.close();
      } catch {
        // already closed
      }
    }

    if (signal.aborted) throw abortError(signal);
    if (!norm.outcome) throw new Error('Claude Code が結果を返さずに終了しました');
    if (!norm.outcome.ok) throw new Error(norm.outcome.message);
  }
}
