import type { HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk';
import { Settings } from '@acc/protocol';
import type { AgentEvent, AgentRunInput, AgentTool, ApprovalDecision } from '../../../contracts';
import {
  ClaudeAgentSdkRuntime,
  type ClaudeRuntimeOptions,
  type ClaudeSdkModule,
  type QueryLike,
} from '../runtime';
import { type CliSandbox, createCliSandbox } from './harness';
import type { FakeAnthropicOptions } from './fakeAnthropic';
import type { Scenario } from './scenarios';

/** Dummy credential for the fake API (never a real key). */
export const DUMMY_TOKEN = 'sk-acc-contract-dummy';

/** What the CLI asked through the SDK, recorded by the tee. */
export interface SdkCallLog {
  /** `canUseTool` calls the CLI made (tool name, input, result we returned). */
  canUseTool: { toolName: string; input: unknown; result: unknown; blockedPath?: string }[];
  /** PreToolUse hook calls the CLI made (tool name, input, output we returned). */
  preToolUse: { toolName: string; input: unknown; output: unknown }[];
}

/**
 * The real SDK module with a tee: every raw message, `canUseTool` call and PreToolUse hook
 * call is recorded, everything else passes through unchanged.
 */
export function recordingSdk(
  real: ClaudeSdkModule,
  sink: {
    messages: unknown[];
    calls: SdkCallLog;
    options: Options[];
    /** Tools whose PreToolUse hook answer is replaced by a deny (to observe the CLI on deny). */
    forceHookDeny?: readonly string[];
    /** Rewrites the runtime's options before the CLI starts (probes, e.g. another permissionMode). */
    overrideOptions?: (o: Options) => Options;
  },
): ClaudeSdkModule {
  return {
    ...real,
    query: (params) => {
      const given: Options = { ...params.options };
      const options: Options = sink.overrideOptions ? sink.overrideOptions(given) : given;
      const cut = options.canUseTool;
      if (cut) {
        options.canUseTool = async (toolName, input, o) => {
          const result = await cut(toolName, input, o);
          sink.calls.canUseTool.push({
            toolName,
            input,
            result,
            ...(o.blockedPath ? { blockedPath: o.blockedPath } : {}),
          });
          return result;
        };
      }
      const pre = options.hooks?.PreToolUse;
      if (pre) {
        options.hooks = {
          ...options.hooks,
          PreToolUse: pre.map((m): HookCallbackMatcher => ({
            ...m,
            hooks: m.hooks.map((h) => async (input, id, o) => {
              const rec = input as { tool_name?: string; tool_input?: unknown };
              const output = sink.forceHookDeny?.includes(rec.tool_name ?? '')
                ? {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse' as const,
                      permissionDecision: 'deny' as const,
                      permissionDecisionReason: 'Denied by the contract test.',
                    },
                  }
                : await h(input, id, o);
              sink.calls.preToolUse.push({
                toolName: rec.tool_name ?? '?',
                input: rec.tool_input,
                output,
              });
              return output;
            }),
          })),
        };
      }
      sink.options.push(options);
      const q = real.query({ ...params, options });
      const tee: QueryLike = {
        interrupt: () => q.interrupt(),
        close: () => q.close(),
        async *[Symbol.asyncIterator]() {
          for await (const m of q) {
            sink.messages.push(m);
            yield m;
          }
        },
      };
      return tee;
    },
  };
}

export interface RunScenarioOptions {
  prompt: string;
  model?: string;
  resumeSessionId?: string | null;
  tools?: AgentTool[];
  /** Answers approvals (default: approve everything). `signal` aborts with the run. */
  decide?: (
    req: { toolName: string; input: unknown },
    signal: AbortSignal,
  ) => Promise<ApprovalDecision>;
  /** Abort the run when this returns true for an event. */
  abortOn?: (ev: AgentEvent) => boolean;
  /** Abort the run this long after it started. */
  abortAfterMs?: number;
  /** Abort the run this long after the first approval was requested (it is then pending). */
  abortAfterAskMs?: number;
  runtime?: ClaudeRuntimeOptions;
  /** See recordingSdk. */
  forceHookDeny?: string[];
  /** See recordingSdk. */
  overrideOptions?: (o: Options) => Options;
  /** Overall safety timeout (ms). Default 60s. */
  timeoutMs?: number;
}

export interface ScenarioResult {
  messages: unknown[];
  events: AgentEvent[];
  calls: SdkCallLog;
  /** The approvals our runtime asked the human for. */
  asked: { toolName: string; input: unknown }[];
  options: Options[];
  error: string | null;
  durationMs: number;
}

/** Runs our ClaudeAgentSdkRuntime once against the sandbox's fake API with the real CLI. */
export async function runScenario(
  sb: CliSandbox,
  cliPath: string,
  real: ClaudeSdkModule,
  o: RunScenarioOptions,
  runtime?: ClaudeAgentSdkRuntime,
): Promise<ScenarioResult> {
  const sink = {
    messages: [] as unknown[],
    calls: { canUseTool: [], preToolUse: [] } as SdkCallLog,
    options: [] as Options[],
    ...(o.forceHookDeny ? { forceHookDeny: o.forceHookDeny } : {}),
    ...(o.overrideOptions ? { overrideOptions: o.overrideOptions } : {}),
  };
  const rt =
    runtime ??
    new ClaudeAgentSdkRuntime({
      settings: () => Settings.parse({ litellm: { baseUrl: sb.api.url, apiKey: DUMMY_TOKEN } }),
      parentEnv: sb.parentEnv,
      pathToClaudeCodeExecutable: cliPath,
      clientApp: 'acc/contract',
      interruptGraceMs: 3000,
      ...o.runtime,
      loadSdk: async () => recordingSdk(real, sink),
    });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('scenario timeout')), o.timeoutMs ?? 60_000);
  const asked: ScenarioResult['asked'] = [];
  const input: AgentRunInput = {
    runId: 'run_contract',
    cwd: sb.repo,
    prompt: o.prompt,
    model: o.model ?? 'claude-sonnet-4-5',
    resumeSessionId: o.resumeSessionId ?? null,
    signal: ac.signal,
    ...(o.tools ? { tools: o.tools } : {}),
    canUseTool: async (req) => {
      asked.push({ toolName: req.toolName, input: req.input });
      if (o.abortAfterAskMs !== undefined && asked.length === 1) {
        setTimeout(() => ac.abort(new Error('aborted by scenario')), o.abortAfterAskMs);
      }
      return o.decide ? o.decide(req, ac.signal) : { decision: 'approved' };
    },
  };
  const events: AgentEvent[] = [];
  const started = Date.now();
  const abortTimer =
    o.abortAfterMs !== undefined
      ? setTimeout(() => ac.abort(new Error('aborted by scenario')), o.abortAfterMs)
      : undefined;
  let error: string | null = null;
  try {
    for await (const ev of rt.run(input)) {
      events.push(ev);
      if (o.abortOn?.(ev)) ac.abort(new Error('aborted by scenario'));
    }
  } catch (err) {
    error = (err as Error).message;
  } finally {
    clearTimeout(timer);
    clearTimeout(abortTimer);
  }
  return {
    messages: sink.messages,
    events,
    calls: sink.calls,
    asked,
    options: sink.options,
    error,
    durationMs: Date.now() - started,
  };
}

/** Loads the real SDK (the module the daemon uses). */
export async function loadRealSdk(): Promise<ClaudeSdkModule> {
  return await import('@anthropic-ai/claude-agent-sdk');
}

/** Creates a sandbox for the scenario, runs it once, and hands back both (caller cleans up). */
export async function playScenario(
  scenario: Scenario,
  cliPath: string,
  real: ClaudeSdkModule,
  api: FakeAnthropicOptions = {},
): Promise<{ sb: CliSandbox; result: ScenarioResult }> {
  const sb = await createCliSandbox({ ...scenario.api, ...api });
  try {
    const { turns, run } = scenario.setup(sb);
    sb.api.script(turns);
    return { sb, result: await runScenario(sb, cliPath, real, run) };
  } catch (err) {
    await sb.cleanup();
    throw err;
  }
}
