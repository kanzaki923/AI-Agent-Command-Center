/**
 * Contract test: our ClaudeAgentSdkRuntime with the REAL Agent SDK and the REAL Claude Code
 * CLI bundled with it, against a local fake Anthropic API (contract/fakeAnthropic.ts). No
 * network, no credentials, no cost; the CLI's home, config dir and temp dir are a sandbox, and
 * an egress proxy refuses (and records) any attempt to reach another host.
 *
 * Skipped when the SDK's platform binary is not installed, or with ACC_SKIP_SDK_CONTRACT=1.
 * Findings: docs/snapshot/20261029_agent-sdk-real-cli.md.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../contracts';
import { DISALLOWED_AGENT_TOOLS } from '../tools';
import {
  type ClassifierVerdict,
  FAKE_BLOCK_CATEGORY,
  FAKE_SERVER_EXPLANATION,
  type ServerVerdict,
  classifierReply,
  isClassifierRequest,
  safeguardResults,
} from './contract/autoMode';
import {
  type CliSandbox,
  childCliProcesses,
  createCliSandbox,
  locateBundledCli,
} from './contract/harness';
import { type ScenarioResult, loadRealSdk, playScenario, runScenario } from './contract/runner';
import {
  type Scenario,
  type ScenarioName,
  TASK_ID,
  scenarios,
  taskGetTool,
} from './contract/scenarios';
import { AUTO_MODE_SETTINGS, MemoryBaselineStore, type ClaudeSdkModule } from './runtime';
import { GATE_NOTES, type ToolDecisionRecord, ToolGate } from '../gate';
import { builtinPrice } from '../../llm/pricing';

const cli = process.env.ACC_SKIP_SDK_CONTRACT ? null : locateBundledCli();
const TIMEOUT = 60_000;

let real: ClaudeSdkModule;
const sandboxes: CliSandbox[] = [];

beforeAll(async () => {
  if (cli) real = await loadRealSdk();
});

afterAll(async () => {
  await Promise.all(sandboxes.map((s) => s.cleanup()));
});

async function play(
  name: ScenarioName,
  extra?: Parameters<typeof playScenario>[3],
  run?: Parameters<typeof playScenario>[4],
) {
  const { sb, result } = await playScenario(scenarios[name], cli!.path, real, extra, run);
  sandboxes.push(sb);
  // Isolation: nothing but the fake API was contacted.
  expect(sb.proxy.attempts).toEqual([]);
  return { sb, r: result };
}

type Raw = Record<string, unknown> & { type?: string; subtype?: string };
const raw = (r: ScenarioResult) => r.messages as Raw[];
const init = (r: ScenarioResult) =>
  raw(r).find((m) => m.type === 'system' && m.subtype === 'init') as
    (Raw & { tools: string[]; mcp_servers: { name: string; status: string }[] }) | undefined;
const resultMsg = (r: ScenarioResult) => raw(r).find((m) => m.type === 'result');
const toolResults = (r: ScenarioResult) =>
  raw(r)
    .filter((m) => m.type === 'user')
    .flatMap((m) => {
      const content = (m.message as { content?: unknown })?.content;
      return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
    })
    .filter((b) => b.type === 'tool_result')
    .map((b) => ({ isError: b.is_error === true, text: JSON.stringify(b.content) }));
const usage = (r: ScenarioResult) =>
  r.events.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage');
const hooked = (r: ScenarioResult) => r.calls.preToolUse.map((c) => c.toolName);
const asked = (r: ScenarioResult) => r.asked.map((a) => a.toolName);

describe.skipIf(!cli).concurrent('Claude Agent SDK contract (real CLI, fake API)', () => {
  it(
    'streams text, reports an estimated cost and registers the expected tools',
    { timeout: TIMEOUT },
    async () => {
      const { sb, r } = await play('text');
      expect(r.error).toBeNull();
      const deltas = r.events.filter((e) => e.type === 'text_delta').map((e) => e.text);
      expect(deltas.length).toBeGreaterThan(1);
      const message = r.events.find((e) => e.type === 'message');
      expect(message).toMatchObject({
        content: [
          { type: 'reasoning', text: '挨拶を返します。' },
          { type: 'text', text: deltas.join('') },
        ],
      });
      expect(usage(r)).toEqual([
        {
          type: 'usage',
          phase: 'final',
          usage: {
            inputTokens: 2000,
            outputTokens: 30,
            costUsd: expect.any(Number) as number,
            costSource: 'estimated',
          },
        },
      ]);
      expect(resultMsg(r)).toMatchObject({ subtype: 'success', terminal_reason: 'completed' });

      const tools = init(r)!.tools;
      // Search tools are registered (item 2 of the public check) and the unattended-run
      // misfits are gone (disallowedTools).
      expect(tools).toEqual(
        expect.arrayContaining(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']),
      );
      for (const t of DISALLOWED_AGENT_TOOLS) expect(tools).not.toContain(t);

      // What the CLI sent: our token as a bearer, the SDK user agent with our client app.
      const main = sb.api.mainRequests[0]!;
      expect(main.path).toBe('/v1/messages?beta=true');
      expect(main.headers.authorization).toBe('<redacted>');
      expect(main.headers['x-api-key']).toBeUndefined();
      expect(main.headers['user-agent']).toMatch(/agent-sdk\/.*client-app\/acc\/contract/);
      expect(sb.api.requests.every((q) => q.path.startsWith('/v1/messages'))).toBe(true);
    },
  );

  it(
    'marks the cost unknown for a model the CLI has no price for (gateway alias)',
    { timeout: TIMEOUT },
    async () => {
      const { sb, r } = await play('textAlias');
      expect(usage(r)[0]?.usage.costSource).toBe('unknown');
      const mu = (resultMsg(r)?.modelUsage ?? {}) as Record<string, { costBasis?: string }>;
      expect(mu['team-sonnet']?.costBasis).toBe('unknown');
      // An alias is treated as the newest model family (adaptive thinking): item 7.
      expect(sb.api.mainRequests[0]!.summary.thinking).toMatchObject({ type: 'adaptive' });
    },
  );

  it(
    'runs the PreToolUse hook for auto-approved tools without asking (edits inside)',
    { timeout: TIMEOUT },
    async () => {
      const { sb, r } = await play('editInside');
      expect(r.error).toBeNull();
      expect(hooked(r)).toEqual(['Read', 'Edit']);
      expect(asked(r)).toEqual([]);
      expect(readFileSync(join(sb.repo, 'README.md'), 'utf8')).toContain('hello, world');
    },
  );

  it(
    'lets allowlisted read-only commands through and forces a prompt for the rest',
    { timeout: TIMEOUT },
    async () => {
      const [ro, forced, approved] = await Promise.all([
        play('bashReadOnly'),
        play('bashForcedAsk'),
        play('bashApproved'),
      ]);
      // `git status`: the CLI auto-approves it and our allowlist agrees; no prompt.
      expect(hooked(ro.r)).toEqual(['Bash']);
      expect(ro.r.calls.canUseTool).toEqual([]);
      expect(asked(ro.r)).toEqual([]);
      expect(toolResults(ro.r)[0]).toMatchObject({ isError: false });
      // `git -c ... log`: the CLI would auto-approve it; the hook's "ask" reaches canUseTool.
      expect(forced.r.calls.canUseTool.map((c) => c.toolName)).toEqual(['Bash']);
      expect(asked(forced.r)).toEqual(['Bash']);
      expect(toolResults(forced.r)[0]).toMatchObject({ isError: true });
      // A writing command: asked, approved, executed.
      expect(asked(approved.r)).toEqual(['Bash']);
      expect(existsSync(join(approved.sb.repo, 'out.txt'))).toBe(true);
    },
  );

  it(
    'denies editing .git (a hard rule) and asks before reading outside the workspace',
    { timeout: TIMEOUT },
    async () => {
      const [git, outside] = await Promise.all([play('editGitConfig'), play('readOutside')]);
      expect(asked(git.r)).toEqual([]);
      // The Read of .git/config is fine; the Edit is refused with the reason.
      expect(toolResults(git.r).map((t) => t.isError)).toEqual([false, true]);
      expect(toolResults(git.r)[1]?.text).toContain('Git metadata');
      expect(readFileSync(join(git.sb.repo, '.git', 'config'), 'utf8')).not.toContain('fsmonitor');
      expect(asked(outside.r)).toEqual(['Read']);
      expect(toolResults(outside.r)[0]).toMatchObject({ isError: true });
    },
  );

  it(
    'searches with Grep / Glob inside the workspace without approval',
    { timeout: TIMEOUT },
    async () => {
      const { r } = await play('search');
      expect(hooked(r)).toEqual(['Grep', 'Glob']);
      expect(asked(r)).toEqual([]);
      expect(toolResults(r).map((t) => t.isError)).toEqual([false, false]);
    },
  );

  it('removes AskUserQuestion and honours a hook deny', { timeout: TIMEOUT }, async () => {
    const [ask, deny] = await Promise.all([play('askUser'), play('hookDeny')]);
    expect(asked(ask.r)).toEqual([]);
    expect(toolResults(ask.r)[0]).toMatchObject({ isError: true });
    expect(toolResults(ask.r)[0]!.text).toContain('No such tool available');

    expect(deny.r.calls.canUseTool).toEqual([]);
    expect(toolResults(deny.r)[0]).toMatchObject({ isError: true });
    expect(toolResults(deny.r)[0]!.text).toContain('Denied by the contract test.');
  });

  it('waits for sub-agents and checks their tool uses too', { timeout: TIMEOUT }, async () => {
    const { sb, r } = await play('subagent');
    expect(r.error).toBeNull();
    expect(hooked(r)).toEqual(['Agent', 'Bash']);
    expect(asked(r)).toEqual(['Bash']);
    // Main → sub-agent → sub-agent → main: no "async agent launched", no notification turn.
    expect(sb.api.mainRequests).toHaveLength(4);
    const results = r.events.filter((e) => e.type === 'tool_result').map((e) => e.name);
    expect(results).toEqual(['Bash', 'Agent']);
  });

  it('round-trips an in-process MCP tool through our tool', { timeout: TIMEOUT }, async () => {
    const calls: unknown[] = [];
    const sc: Scenario = scenarios.mcp;
    const sb = await createCliSandbox();
    sandboxes.push(sb);
    const { turns, run } = sc.setup(sb);
    sb.api.script(turns);
    const r = await runScenario(sb, cli!.path, real, { ...run, tools: [taskGetTool(calls)] });
    expect(r.error).toBeNull();
    expect(init(r)!.mcp_servers).toEqual([
      expect.objectContaining({ name: 'acc', status: 'connected' }),
    ]);
    expect(init(r)!.tools).toContain('mcp__acc__task_get');
    expect(calls).toEqual([{ taskId: TASK_ID }]);
    expect(asked(r)).toEqual([]);
    expect(toolResults(r)[0]!.text).toContain('デモのタスク');
  });

  it('fails clearly when the MCP tools did not register', { timeout: TIMEOUT }, async () => {
    const sb = await createCliSandbox({
      turns: [() => ({ content: [{ type: 'text', text: 'x' }] })],
    });
    sandboxes.push(sb);
    // A server without the tools we expect (as if registration silently failed).
    const broken: ClaudeSdkModule = {
      ...real,
      createSdkMcpServer: (o) => real.createSdkMcpServer!({ ...o, tools: [] }),
    };
    const r = await runScenario(sb, cli!.path, broken, { prompt: 'x', tools: [taskGetTool()] });
    expect(r.error).toContain('Control API のツールが Claude Code に登録されなかった');
    expect(r.error).toContain('mcp__acc__task_get');
  });

  it(
    'stops promptly on interrupt, abort during an approval, and a stalled stream',
    { timeout: TIMEOUT },
    async () => {
      const [stream, pending, stall] = await Promise.all([
        play('interruptStream'),
        play('abortPendingApproval'),
        play('stall'),
      ]);
      expect(stream.r.error).toBe('aborted by scenario');
      expect(stream.r.durationMs).toBeLessThan(10_000);
      // The interrupted turn ends with an error result; a fresh session's totals are zeroed.
      expect(resultMsg(stream.r)).toMatchObject({
        subtype: 'error_during_execution',
        terminal_reason: 'aborted_streaming',
        total_cost_usd: 0,
      });

      expect(asked(pending.r)).toEqual(['Bash']);
      expect(pending.r.error).toBe('aborted by scenario');
      expect(resultMsg(pending.r)).toMatchObject({ terminal_reason: 'aborted_tools' });
      // The completed API call before the approval is still accounted for.
      expect(usage(pending.r)).toHaveLength(1);

      expect(stall.r.error).toBe('Claude Code から 3 秒以上応答がないため停止しました');
      expect(stall.r.durationMs).toBeLessThan(15_000);
    },
  );

  it(
    'explains API errors and stops at the first rejected credential',
    { timeout: TIMEOUT },
    async () => {
      const [bad, auth] = await Promise.all([play('apiError'), play('authError')]);
      expect(bad.r.error).toMatch(
        /^モデルの呼び出しでエラーが発生しました: HTTP 400 \/ API Error: 400 bad request from fake/,
      );
      expect(resultMsg(bad.r)).toMatchObject({
        subtype: 'success',
        is_error: true,
        api_error_status: 400,
        terminal_reason: 'api_error',
      });

      // The CLI retries a 401 up to 10 times with backoff; we stop at the first retry.
      expect(auth.r.error).toBe(
        'Claude の認証に失敗しました。Claude Code へのログイン、または LiteLLM の URL / API キーを確認してください（HTTP 401）',
      );
      expect(auth.r.durationMs).toBeLessThan(15_000);
    },
  );

  it(
    'keeps resume deltas right across normal, failed and interrupted runs',
    { timeout: TIMEOUT },
    async () => {
      const sb = await createCliSandbox();
      sandboxes.push(sb);
      const baselines = new MemoryBaselineStore();
      const turn =
        (inTok: number, extra: object = {}) =>
        () => ({
          content: [{ type: 'text' as const, text: `入力 ${inTok}` }],
          usage: { input_tokens: inTok, output_tokens: 10 },
          ...extra,
        });
      const go = async (
        turns: Parameters<typeof sb.api.script>[0],
        o: Partial<Parameters<typeof runScenario>[3]> = {},
      ) => {
        sb.api.script(turns);
        return runScenario(sb, cli!.path, real, {
          prompt: 'x',
          runtime: { baselines } as never,
          ...o,
        });
      };
      const inputOf = (r: ScenarioResult) =>
        usage(r).reduce((n, e) => n + (e.usage.inputTokens ?? 0), 0);

      const r1 = await go([turn(1000)]);
      const sid = (r1.events.find((e) => e.type === 'session') as { runtimeSessionId: string })
        .runtimeSessionId;
      expect(inputOf(r1)).toBe(1000);
      // The CLI continues the session's totals on resume; we report only this run's part.
      const r2 = await go([turn(2000)], { resumeSessionId: sid });
      expect(resultMsg(r2)?.modelUsage).toMatchObject({
        'claude-sonnet-4-5': { inputTokens: 3000 },
      });
      expect(inputOf(r2)).toBe(2000);
      // Killed right after the result: the CLI had already saved the totals (no double count).
      const r3 = await go([turn(4000)], {
        resumeSessionId: sid,
        runtime: { baselines, interruptGraceMs: 0 } as never,
      });
      expect(inputOf(r3)).toBe(4000);
      const r4 = await go([turn(8000)], { resumeSessionId: sid });
      expect(inputOf(r4)).toBe(8000);
      // An API error result carries the old totals: nothing reported, baseline kept.
      const err = () => ({
        content: [],
        error: { status: 400, type: 'invalid_request_error', message: 'bad' },
      });
      const r5 = await go(
        Array.from({ length: 12 }, () => err),
        { resumeSessionId: sid },
      );
      expect(r5.error).toContain('HTTP 400');
      expect(inputOf(r5)).toBe(0);
      // Interrupted mid-stream: the CLI does not count the unfinished call.
      const r6 = await go([turn(16000, { hangAfterDeltas: 1 })], {
        resumeSessionId: sid,
        abortOn: (e) => e.type === 'text_delta',
      });
      expect(r6.error).toBe('aborted by scenario');
      expect(inputOf(r6)).toBe(0);
      const r7 = await go([turn(32000)], { resumeSessionId: sid });
      expect(inputOf(r7)).toBe(32000);
      expect(baselines.get(sid)).toMatchObject({ inputTokens: 1000 + 2000 + 4000 + 8000 + 32000 });
    },
  );

  /**
   * Spec 20261029 §7.2 Q1: `maxBudgetUsd` counts only the spend of this query() — also when it
   * resumes a session whose saved total is already above the cap — and is checked after each
   * API call (so a run can overshoot by its last call). We therefore pass "what this run may
   * still spend" (runs/usage.ts spendCapUsd) and stop on our own estimates as well.
   */
  it(
    'maxBudgetUsd caps the spend of this query only, also on resume (Q1)',
    { timeout: TIMEOUT },
    async () => {
      const sb = await createCliSandbox();
      sandboxes.push(sb);
      const baselines = new MemoryBaselineStore();
      const read = (inTok: number) => () => ({
        content: [
          {
            type: 'tool_use' as const,
            name: 'Read',
            input: { file_path: join(sb.repo, 'README.md') },
          },
        ],
        usage: { input_tokens: inTok, output_tokens: 10 },
      });
      const done = (inTok: number) => () => ({
        content: [{ type: 'text' as const, text: 'done' }],
        usage: { input_tokens: inTok, output_tokens: 10 },
      });
      // $0.03 per call (claude-sonnet-4-5, 10k input tokens): over $0.05 after the 2nd call.
      sb.api.script([read(10_000), read(10_000), read(10_000), done(10_000)]);
      const before = sb.api.mainRequests.length;
      const r1 = await runScenario(sb, cli!.path, real, {
        prompt: 'x',
        maxBudgetUsd: 0.05,
        runtime: { baselines } as never,
      });
      expect(sb.api.mainRequests.length - before).toBe(2);
      expect(resultMsg(r1)).toMatchObject({
        subtype: 'error_max_budget_usd',
        terminal_reason: 'budget_exhausted',
        errors: ['Reached maximum budget ($0.05)'],
      });
      expect(resultMsg(r1)?.total_cost_usd).toBeGreaterThan(0.05);
      expect(r1.error).toBe('予算の上限に達したため停止しました: Reached maximum budget ($0.05)');
      expect(r1.options[0]?.maxBudgetUsd).toBe(0.05);
      // The spend up to the cap is still reported.
      expect(usage(r1)).toHaveLength(1);

      // Resumed with the session's saved total ($0.06) above the same cap: not refused.
      const sid = (r1.events.find((e) => e.type === 'session') as { runtimeSessionId: string })
        .runtimeSessionId;
      sb.api.script([read(1000), done(1000)]);
      const b2 = sb.api.mainRequests.length;
      const r2 = await runScenario(sb, cli!.path, real, {
        prompt: 'y',
        maxBudgetUsd: 0.05,
        resumeSessionId: sid,
        runtime: { baselines } as never,
      });
      expect(r2.error).toBeNull();
      expect(sb.api.mainRequests.length - b2).toBe(2);
      expect(resultMsg(r2)).toMatchObject({ subtype: 'success' });
      expect(resultMsg(r2)?.total_cost_usd).toBeGreaterThan(0.06);
    },
  );

  it(
    'estimates every API call while the turn runs and the result replaces them',
    { timeout: TIMEOUT },
    async () => {
      const prices = (m: string | null) => builtinPrice(m ?? '');
      const { r } = await play('editInside', undefined, {
        runtime: { pricing: prices } as never,
      });
      expect(r.error).toBeNull();
      const all = usage(r);
      const estimates = all.filter((u) => u.phase === 'estimate');
      const final = all.filter((u) => u.phase === 'final');
      expect(final).toHaveLength(1);
      // One estimate or more per API call (3 calls), each call counted once.
      expect(estimates.length).toBeGreaterThanOrEqual(3);
      const sum = (k: 'inputTokens' | 'outputTokens' | 'costUsd') =>
        estimates.reduce((n, u) => n + (u.usage[k] ?? 0), 0);
      expect(sum('inputTokens')).toBe(final[0]!.usage.inputTokens);
      expect(sum('outputTokens')).toBe(final[0]!.usage.outputTokens);
      // Our table prices claude-sonnet-4-5 like the CLI does.
      expect(sum('costUsd')).toBeCloseTo(final[0]!.usage.costUsd!, 9);
      // The first estimate arrives before the first tool runs.
      const firstEstimate = r.events.findIndex((e) => e.type === 'usage');
      const firstResult = r.events.findIndex((e) => e.type === 'tool_result');
      expect(firstEstimate).toBeLessThan(firstResult);
    },
  );
});

/**
 * Auto mode (`permissionMode: 'auto'`) behind our custom ANTHROPIC_BASE_URL, with the fake API
 * answering the CLI's own classifier requests (CLAUDE_CODE_AUTO_MODE_SERVER=0, the "client"
 * judge). These pin the CLI behaviour the layered policy relies on
 * (docs/snapshot/20261029_auto-mode.md).
 */
describe.skipIf(!cli).concurrent('Claude Agent SDK contract: auto mode', () => {
  /** A command the CLI does not auto-approve (not read-only) and that needs no network. */
  const nodeCommand = { command: 'node -e "process.exit(0)"', description: 'node' };

  async function auto(opts: {
    model: string;
    verdict: ClassifierVerdict;
    /** Our PreToolUse hook answer: 'pass' leaves the decision to the CLI (the classifier). */
    hook: 'pass' | 'deny';
  }) {
    const classifierModels: string[] = [];
    const sb = await createCliSandbox({
      intercept: (req) => {
        if (!isClassifierRequest(req)) return undefined;
        classifierModels.push(req.body.model ?? '');
        return classifierReply(req, opts.verdict);
      },
    });
    sandboxes.push(sb);
    sb.api.script([
      () => ({ content: [{ type: 'tool_use', name: 'Bash', input: nodeCommand }] }),
      () => ({ content: [{ type: 'text', text: 'done' }] }),
    ]);
    const r = await runScenario(sb, cli!.path, real, {
      prompt: 'node を動かして',
      model: opts.model,
      ...(opts.hook === 'deny' ? { forceHookDeny: ['Bash'] } : {}),
      overrideOptions: (o) => ({
        ...o,
        permissionMode: 'auto',
        // The gateway does not return safeguard results: skip the server review round trip.
        env: { ...o.env, CLAUDE_CODE_AUTO_MODE_SERVER: '0' },
        ...(opts.hook === 'pass' ? { hooks: {} } : {}),
      }),
    });
    expect(sb.proxy.attempts).toEqual([]);
    expect(r.error).toBeNull();
    return { r, classifierModels };
  }
  const denied = (r: ScenarioResult) =>
    raw(r).filter((m) => m.type === 'system' && m.subtype === 'permission_denied');

  it(
    'accepts auto mode for a gateway alias and returns a classifier block to the model',
    { timeout: TIMEOUT },
    async () => {
      const { r, classifierModels } = await auto({
        model: 'team-sonnet',
        verdict: 'block',
        hook: 'pass',
      });
      expect(init(r)?.permissionMode).toBe('auto');
      // Two stages, on the default classifier model (not the session's alias).
      expect(classifierModels).toEqual(['claude-sonnet-5', 'claude-sonnet-5']);
      expect(r.calls.canUseTool).toEqual([]);
      expect(denied(r)).toEqual([
        expect.objectContaining({ tool_name: 'Bash', decision_reason_type: 'classifier' }),
      ]);
      const [result] = toolResults(r);
      expect(result?.isError).toBe(true);
      expect(result?.text).toContain('auto mode classifier');
      // The severity-style answer (Sonnet 5) names a category, but the CLI passes on only a
      // generic reason; the `<block>` style passes on its `<reason>` (the probe saw both).
      expect(result?.text).toContain('Reason: Blocked by classifier');
      expect(result?.text).not.toContain(FAKE_BLOCK_CATEGORY);
    },
  );

  it('runs the command when the classifier allows it', { timeout: TIMEOUT }, async () => {
    const { r, classifierModels } = await auto({
      model: 'claude-sonnet-4-6',
      verdict: 'allow',
      hook: 'pass',
    });
    // A Sonnet 4.6 session classifies with Sonnet 4.6; one stage when it allows.
    expect(classifierModels).toEqual(['claude-sonnet-4-6']);
    expect(r.calls.canUseTool).toEqual([]);
    expect(denied(r)).toEqual([]);
    expect(toolResults(r)).toEqual([expect.objectContaining({ isError: false })]);
    const meta = raw(r).find((m) => m.type === 'user')?.tool_result_meta;
    expect(meta).toEqual([
      expect.objectContaining({
        permission_decision: expect.objectContaining({
          decision: 'accept',
          reason_type: 'classifier',
        }) as unknown,
      }),
    ]);
  });

  it('applies our PreToolUse deny before the classifier', { timeout: TIMEOUT }, async () => {
    const { r, classifierModels } = await auto({
      model: 'claude-sonnet-4-6',
      verdict: 'allow',
      hook: 'deny',
    });
    expect(classifierModels).toEqual([]);
    expect(hooked(r)).toEqual(['Bash']);
    expect(toolResults(r)[0]?.text).toContain('PreToolUse:Bash hook error');
  });

  it(
    'silently starts in default mode for a model auto mode does not support',
    {
      timeout: TIMEOUT,
    },
    async () => {
      const { r, classifierModels } = await auto({
        model: 'claude-sonnet-4-5',
        verdict: 'allow',
        hook: 'pass',
      });
      expect(init(r)?.permissionMode).toBe('default');
      expect(classifierModels).toEqual([]);
      expect(asked(r)).toEqual(['Bash']);
    },
  );
});

/**
 * The production auto mode path: our runtime with an autonomous gate as the executor builds it
 * (the server review by default, or the CLI's own classifier), against the real CLI.
 */
describe.skipIf(!cli).concurrent('Claude Agent SDK contract: layered permissions', () => {
  async function production(opts: {
    /** The CLI's own classifier (requests without the main loop's tools). */
    verdict: ClassifierVerdict | 'error';
    commands: string[];
    judge: 'server' | 'client';
    /** What the fake API answers to `safeguards`; omitted: nothing (an upstream without it). */
    server?: ServerVerdict;
    classifierModel?: string | null;
  }) {
    const classifierRequests: string[] = [];
    const sb = await createCliSandbox({
      keepBodies: true,
      intercept: (req) => {
        if (!isClassifierRequest(req)) return undefined;
        classifierRequests.push(req.body.model ?? '');
        // LiteLLM without the classifier's model: a 400 for every classifier request.
        return opts.verdict === 'error'
          ? {
              content: [],
              error: { status: 400, type: 'invalid_request_error', message: 'Invalid model name' },
            }
          : classifierReply(req, opts.verdict);
      },
      ...(opts.server ? { safeguards: (_req, ids) => safeguardResults(ids, opts.server!) } : {}),
    });
    sandboxes.push(sb);
    sb.api.script([
      ...opts.commands.map((command) => () => ({
        content: [
          { type: 'tool_use' as const, name: 'Bash', input: { command, description: 'x' } },
        ],
      })),
      () => ({ content: [{ type: 'text' as const, text: 'done' }] }),
    ]);
    const decisions: ToolDecisionRecord[] = [];
    const gate = new ToolGate({
      cwd: sb.repo,
      profile: 'autonomous',
      autoMode: {
        classifierModel:
          opts.classifierModel === undefined ? 'claude-sonnet-4-6' : opts.classifierModel,
        judge: opts.judge,
      },
      record: (d) => decisions.push(d),
    });
    const r = await runScenario(sb, cli!.path, real, {
      prompt: 'テストを動かして',
      model: 'claude-sonnet-4-6',
      gate,
    });
    expect(sb.proxy.attempts).toEqual([]);
    expect(r.error).toBeNull();
    const safeguardsSent = sb.api.mainRequests.map((m) =>
      (m.summary.bodyKeys ?? []).includes('safeguards'),
    );
    return { sb, r, gate, decisions, classifierRequests, safeguardsSent };
  }
  const env = (r: ScenarioResult) => r.options[0]?.env ?? {};

  it(
    'lets the client classifier decide the gray zone and denies hard rules before it',
    { timeout: TIMEOUT },
    async () => {
      const { r, gate, decisions, classifierRequests, safeguardsSent } = await production({
        verdict: 'allow',
        judge: 'client',
        commands: ['node -e "process.exit(0)"', 'git push origin HEAD'],
      });
      expect(r.options[0]).toMatchObject({ permissionMode: 'auto' });
      expect(env(r)).toMatchObject({
        CLAUDE_CODE_AUTO_MODE_SERVER: '0',
        CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-sonnet-4-6',
      });
      expect(init(r)?.permissionMode).toBe('auto');
      expect(gate.permission).toEqual({
        profile: 'autonomous',
        gate: 'classifier',
        note: null,
        judge: 'client',
      });
      expect(classifierRequests).toEqual(['claude-sonnet-4-6']);
      expect(safeguardsSent.every((s) => !s)).toBe(true);
      expect(r.asked).toEqual([]);
      expect(toolResults(r).map((t) => t.isError)).toEqual([false, true]);
      expect(toolResults(r)[1]?.text).toContain('push');
      expect(decisions.map((d) => [d.toolName, d.decision, d.decidedBy, d.rule, d.judge])).toEqual([
        ['Bash', 'allowed', 'classifier', null, 'client'],
        ['Bash', 'denied', 'rule', 'publish_remote', undefined],
      ]);
    },
  );

  it(
    'lets the server review decide without a classifier request (the default)',
    { timeout: TIMEOUT },
    async () => {
      const { sb, r, gate, decisions, classifierRequests, safeguardsSent } = await production({
        verdict: 'block',
        judge: 'server',
        server: 'not_flagged',
        commands: ['node -e "process.exit(0)"', 'git push origin HEAD'],
      });
      // The server review is the CLI's default: the variable is not set at all.
      expect(env(r)).not.toHaveProperty('CLAUDE_CODE_AUTO_MODE_SERVER');
      expect(env(r)).toMatchObject({ CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-sonnet-4-6' });
      expect(safeguardsSent.every(Boolean)).toBe(true);
      expect(classifierRequests).toEqual([]);
      // The review request carries our inline auto mode rules, not only Anthropic's defaults
      // (it also carries the cwd, home, OS user name and git state: never log these bodies).
      const [review] = sb.api.bodies.find((b) => b.kind === 'main')!.body.safeguards as {
        type: string;
        classifier_context: Record<string, unknown>;
      }[];
      expect(review?.type).toBe('dangerous_tool_use');
      expect(review?.classifier_context).toMatchObject({
        permission_mode: 'auto',
        classify_all_shell: true,
        auto_mode: {
          environment: AUTO_MODE_SETTINGS.environment,
          hard_deny: AUTO_MODE_SETTINGS.hard_deny,
        },
      });
      expect(gate.permission).toEqual({
        profile: 'autonomous',
        gate: 'classifier',
        note: null,
        judge: 'server',
      });
      expect(toolResults(r).map((t) => t.isError)).toEqual([false, true]);
      expect(decisions.map((d) => [d.decision, d.decidedBy, d.rule, d.judge])).toEqual([
        ['allowed', 'classifier', null, 'server'],
        ['denied', 'rule', 'publish_remote', undefined],
      ]);
    },
  );

  it(
    'returns the server review’s block to the agent and records it as the server’s',
    { timeout: TIMEOUT },
    async () => {
      const { r, gate, decisions, classifierRequests } = await production({
        verdict: 'allow',
        judge: 'server',
        server: 'flagged',
        commands: ['node -e "process.exit(0)"'],
      });
      expect(classifierRequests).toEqual([]);
      expect(gate.permission.gate).toBe('classifier');
      expect(r.asked).toEqual([]);
      expect(toolResults(r)[0]).toMatchObject({ isError: true });
      expect(toolResults(r)[0]?.text).toContain(FAKE_SERVER_EXPLANATION);
      expect(decisions).toEqual([
        expect.objectContaining({
          decision: 'denied',
          decidedBy: 'classifier',
          judge: 'server',
          notable: true,
          reason: `自動の安全判定が拒否: ${FAKE_SERVER_EXPLANATION}`,
        }),
      ]);
    },
  );

  it(
    'falls back to the CLI’s classifier when the upstream does not do the server review',
    { timeout: TIMEOUT },
    async () => {
      for (const server of [undefined, 'unsupported'] as const) {
        const { gate, decisions, classifierRequests, safeguardsSent } = await production({
          verdict: 'allow',
          judge: 'server',
          ...(server ? { server } : {}),
          // A gateway name of its own: the fallback classifier uses it.
          classifierModel: 'team-classifier',
          commands: ['node -e "process.exit(0)"', 'node -e "process.exit(1)"'],
        });
        // Asked once, then the CLI stops sending `safeguards` for the session.
        expect(safeguardsSent.slice(0, 2)).toEqual([true, false]);
        expect(classifierRequests).toEqual(['team-classifier', 'team-classifier']);
        expect(gate.permission).toEqual({
          profile: 'autonomous',
          gate: 'classifier',
          note: GATE_NOTES.serverJudgeUnavailable,
          judge: 'client',
        });
        expect(decisions.map((d) => [d.decision, d.decidedBy, d.judge])).toEqual([
          ['allowed', 'classifier', 'client'],
          ['allowed', 'classifier', 'client'],
        ]);
      }
    },
  );

  it(
    'falls back to the rules when neither the server nor a classifier model can judge',
    { timeout: TIMEOUT },
    async () => {
      const { r, gate, decisions, classifierRequests } = await production({
        verdict: 'error',
        judge: 'server',
        classifierModel: null,
        commands: ['node -e "process.exit(0)"', 'node -e "process.exit(0)"'],
      });
      // Auto mode was tried (the server judge needs no classifier model) ...
      expect(r.options[0]).toMatchObject({ permissionMode: 'auto' });
      expect(env(r)).not.toHaveProperty('CLAUDE_CODE_AUTO_MODE_MODEL');
      // ... the CLI's fallback classifier got errors (a Sonnet 4.6 session uses Sonnet 4.6) ...
      expect(classifierRequests.length).toBeGreaterThan(0);
      // ... and the run went on under the rules, without asking anyone.
      expect(gate.permission).toEqual({
        profile: 'autonomous',
        gate: 'rules',
        note: GATE_NOTES.classifierUnavailable,
      });
      expect(r.asked).toEqual([]);
      expect(toolResults(r).map((t) => t.isError)).toEqual([true, false]);
      expect(decisions.map((d) => [d.decision, d.decidedBy, d.judge])).toEqual([
        ['denied', 'classifier', 'client'],
        ['allowed', 'rule', undefined],
      ]);
      expect(decisions[0]?.reason).toBe('安全判定を実行できなかったため拒否（判定の失敗）');
    },
  );

  it(
    'falls back to the rules when the classifier cannot answer',
    { timeout: TIMEOUT },
    async () => {
      const { r, gate, decisions } = await production({
        verdict: 'garbage',
        judge: 'client',
        commands: ['node -e "process.exit(0)"', 'node -e "process.exit(0)"'],
      });
      expect(gate.permission.gate).toBe('rules');
      expect(gate.permission.note).toBe(GATE_NOTES.classifierUnavailable);
      expect(r.asked).toEqual([]);
      // The first try was refused for want of a verdict; the retry ran under the rules.
      expect(toolResults(r).map((t) => t.isError)).toEqual([true, false]);
      expect(decisions.map((d) => [d.decision, d.decidedBy])).toEqual([
        ['denied', 'classifier'],
        ['allowed', 'rule'],
      ]);
    },
  );
});

describe.skipIf(!cli)('Claude Agent SDK contract: cleanup', () => {
  it('leaves no Claude Code process behind', { timeout: TIMEOUT }, async () => {
    // Runs after the concurrent suite above (vitest runs describe blocks in order).
    let left = childCliProcesses();
    for (let i = 0; i < 20 && left.length > 0; i++) {
      await new Promise((r) => setTimeout(r, 250));
      left = childCliProcesses();
    }
    expect(left).toEqual([]);
  });
});
