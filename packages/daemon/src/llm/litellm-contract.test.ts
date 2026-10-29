/**
 * Contract test against a REAL LiteLLM Proxy (opt-in), whose upstream is our fake Anthropic
 * API (runtime/claude/contract/fakeAnthropic.ts). Both LLM paths go through it:
 *
 * 1. the daemon's LLM gateway (OpenAI-compatible `/chat/completions` SSE → LiteLLM translates
 *    to Anthropic `/v1/messages`), used by chat and orchestrator runs;
 * 2. the Claude Agent SDK runtime (the real bundled CLI with ANTHROPIC_BASE_URL = LiteLLM,
 *    Anthropic-native `/v1/messages`).
 *
 * Zero cost: LiteLLM listens on 127.0.0.1 with a dummy master key, every model's api_base is
 * the fake, its environment is an allowlist (no ANTHROPIC_* / *_API_KEY of this machine) and
 * egress goes to a refusing proxy that records attempts (asserted empty).
 *
 * Skipped unless ACC_LITELLM_BIN points at a `litellm` executable (docs/persistent/
 * development.md §6). Findings: docs/snapshot/20261029_litellm-contract.md.
 */
import type { Run } from '@acc/protocol';
import { Settings } from '@acc/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../core/log';
import type { FakeReply, FakeRequest } from '../runtime/claude/contract/fakeAnthropic';
import { classifierReply, isClassifierRequest } from '../runtime/claude/contract/autoMode';
import {
  type CliSandbox,
  createCliSandbox,
  locateBundledCli,
} from '../runtime/claude/contract/harness';
import {
  LITELLM_MASTER_KEY,
  type LiteLlmProxy,
  liteLlmTiktokenCache,
  locateLiteLlm,
  startLiteLlm,
} from '../runtime/claude/contract/litellmProxy';
import { type ScenarioResult, loadRealSdk, runScenario } from '../runtime/claude/contract/runner';
import { taskGetTool } from '../runtime/claude/contract/scenarios';
import type { ClaudeSdkModule } from '../runtime/claude/runtime';
import { ToolGate } from '../runtime/gate';
import { HUMAN, type TestDaemonNoServer, createTestDaemon } from '../testing';
import { type TempRepo, createTempRepo, isolateGitConfig } from '../workspace/git-fixture';
import { LlmGateway } from './gateway';
import { OpenAiCompatibleProvider } from './openai';
import { type ChatRequest, LlmError, type LlmStreamEvent } from './types';

const bin = locateLiteLlm();
const cli = bin ? locateBundledCli() : null;

/** Upstream (fake) model names, as LiteLLM sends them without the provider prefix. */
const UPSTREAM = { sonnet: 'claude-sonnet-4-5', flaky: 'claude-haiku-4-5' } as const;

let sb: CliSandbox;
let ll: LiteLlmProxy;
const cleanups: (() => unknown)[] = [];

beforeAll(async () => {
  if (!bin) return;
  const restoreGit = isolateGitConfig();
  cleanups.push(restoreGit);
  sb = await createCliSandbox({ keepBodies: true });
  cleanups.push(() => sb.cleanup());
  ll = await startLiteLlm({
    bin,
    tiktokenCacheDir: liteLlmTiktokenCache(),
    upstream: sb.api.url,
    egressProxy: sb.proxy.url,
    models: [
      { name: 'claude-sonnet-4-5', model: 'anthropic/claude-sonnet-4-5' },
      { name: 'team-sonnet', model: 'anthropic/claude-sonnet-4-5' },
      { name: 'claude-sonnet-4-6', model: 'anthropic/claude-sonnet-4-6' },
      {
        name: 'think-sonnet',
        model: 'anthropic/claude-sonnet-4-5',
        params: { thinking: { type: 'enabled', budget_tokens: 1024 } },
      },
      // Its own deployment, so LiteLLM's cooldown after an error does not hit the others.
      { name: 'flaky-sonnet', model: `anthropic/${UPSTREAM.flaky}` },
    ],
  });
  cleanups.push(() => ll.stop());
}, 180_000);

afterAll(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
}, 60_000);

/** Reply of the flaky deployment (errors), when set. */
let flaky: FakeReply | null = null;
/** Routes every request: the flaky deployment first, then the test's own handler. */
function route(handler: (req: FakeRequest) => FakeReply | undefined): void {
  sb.api.configure({
    intercept: (req) => (req.body.model === UPSTREAM.flaky && flaky ? flaky : handler(req)),
  });
}
const apiError = (status: number, type: string): FakeReply => ({
  content: [],
  error: { status, type, message: `fake ${status}` },
});
const lastText = (req: FakeRequest) => {
  const c = req.body.messages?.at(-1)?.content;
  return typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? String((c[0] as { text?: unknown }).text)
      : '';
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------
// 1. The daemon's LLM gateway
// ---------------------------------------------------------------------------------------

describe.skipIf(!bin)('LLM gateway through a real LiteLLM (fake Anthropic upstream)', () => {
  const provider = (idleTimeoutMs?: number) =>
    new OpenAiCompatibleProvider({
      connection: () => ({ baseUrl: ll.url, apiKey: LITELLM_MASTER_KEY }),
      ...(idleTimeoutMs ? { idleTimeoutMs } : {}),
    });
  const req = (model: string, content: string): ChatRequest => ({
    model,
    messages: [{ role: 'user', content }],
  });
  async function collect(model: string, content: string, idleTimeoutMs?: number) {
    const events: LlmStreamEvent[] = [];
    for await (const e of provider(idleTimeoutMs).stream(
      req(model, content),
      new AbortController().signal,
    )) {
      events.push(e);
    }
    return events;
  }
  async function failure(model: string, content: string): Promise<LlmError> {
    const err = await collect(model, content).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    return err as LlmError;
  }

  it('streams text deltas, the finish reason and the cost LiteLLM computed', async () => {
    route((r) => {
      switch (lastText(r)) {
        case 'cache':
          return {
            content: [{ type: 'text', text: 'cached' }],
            usage: {
              input_tokens: 100,
              output_tokens: 10,
              cache_read_input_tokens: 5000,
              cache_creation_input_tokens: 2000,
            },
          };
        case 'long':
          return { content: [{ type: 'text', text: 'truncated' }], stopReason: 'max_tokens' };
        default:
          return {
            content: [{ type: 'text', text: 'こんにちは、LiteLLM 経由の返答です。' }],
            usage: { input_tokens: 1234, output_tokens: 56 },
          };
      }
    });
    const events = await collect('team-sonnet', 'hi');
    const texts = events.filter((e) => e.type === 'text');
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.map((e) => e.text).join('')).toBe('こんにちは、LiteLLM 経由の返答です。');
    // LiteLLM puts its own cost (its price table for the deployment's model) in the final
    // usage chunk; the x-litellm-response-cost header is not sent on a stream.
    expect(events.at(-2)).toEqual({
      type: 'usage',
      usage: {
        inputTokens: 1234,
        outputTokens: 56,
        costUsd: expect.closeTo((1234 * 3 + 56 * 15) / 1e6, 9) as number,
        costSource: 'reported',
      },
    });
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });

    // Cache reads / writes are included in prompt_tokens and priced in the cost.
    const cached = await collect('team-sonnet', 'cache');
    expect(cached.find((e) => e.type === 'usage')).toMatchObject({
      usage: {
        inputTokens: 7100,
        costUsd: expect.closeTo(0.00945, 9) as number,
        costSource: 'reported',
      },
    });
    expect((await collect('team-sonnet', 'long')).at(-1)).toEqual({
      type: 'finish',
      reason: 'length',
    });
    // What reached the upstream: the deployment's model, a default max_tokens from LiteLLM.
    const up = sb.api.bodies.at(-1)!;
    expect(up.body).toMatchObject({ model: UPSTREAM.sonnet, stream: true, max_tokens: 64000 });
    expect(up.headers['x-api-key']).toBe('<redacted>');
  });

  it('lists the models LiteLLM serves', async () => {
    const gw = new LlmGateway({
      connection: () => ({ baseUrl: ll.url, apiKey: LITELLM_MASTER_KEY }),
      log: silentLogger,
    });
    const list = await gw.listModels(true);
    expect(list.source).toBe('litellm');
    expect(list.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['team-sonnet', 'think-sonnet', 'claude-sonnet-4-6']),
    );
  });

  describe('an orchestrator run (Control API tools, budget)', () => {
    let d: TestDaemonNoServer;
    let repo: TempRepo;

    beforeAll(async () => {
      if (!bin) return;
      repo = await createTempRepo();
      d = await createTestDaemon();
      cleanups.push(
        () => repo.cleanup(),
        () => d.cleanup(),
      );
      await d.call(HUMAN, 'settings.update', {
        litellm: { baseUrl: ll.url, apiKey: LITELLM_MASTER_KEY },
      });
    });

    async function orchestrate(model: string): Promise<{ run: Run; spentUsd: number }> {
      const project = await d.call(HUMAN, 'project.create', {
        name: `p-${model}`,
        repoPath: repo.path,
        defaultBranch: 'main',
      });
      route((r) => {
        if (!Array.isArray(r.body.tools) || r.body.tools.length === 0) return undefined;
        const thinking = { type: 'thinking' as const, thinking: '状況を確認します。' };
        const withThinking = model === 'think-sonnet' ? [thinking] : [];
        return r.toolResults.length === 0
          ? {
              content: [
                ...withThinking,
                { type: 'tool_use', name: 'project__get', input: { projectId: project.id } },
              ],
            }
          : { content: [...withThinking, { type: 'text', text: '確認しました。' }] };
      });
      const s = await d.call(HUMAN, 'session.create', { projectId: project.id, model });
      const { budget } = await d.call(HUMAN, 'session.grantOrchestration', {
        sessionId: s.id,
        budgetUsd: 5,
      });
      const { runId } = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: '進めて' });
      const run = await d.ctx.service('runs').waitForEnd(runId);
      const spent = budget
        ? (await d.call(HUMAN, 'budget.get', { budgetId: budget.id })).budget
        : null;
      return { run, spentUsd: spent?.spentUsd ?? 0 };
    }

    it('round-trips a tool call with "__" names and charges the reported cost', async () => {
      const before = sb.api.bodies.length;
      const { run, spentUsd } = await orchestrate('team-sonnet');
      expect(run).toMatchObject({ status: 'completed', kind: 'orchestrator' });
      const [first, second] = sb.api.bodies.slice(before).map((b) => b.body);
      // Every Control API tool reached the upstream as an Anthropic tool with its schema.
      const tools = (first!.tools ?? []) as { name: string; input_schema?: { type?: string } }[];
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(['project__get', 'task__create', 'task__spawnWorker']),
      );
      expect(tools.every((t) => t.input_schema?.type === 'object')).toBe(true);
      // The tool result went back as an Anthropic tool_result for the same id.
      expect(JSON.stringify(second!.messages?.at(-1))).toContain('"type":"tool_result"');
      expect(run.usage.costSource).toBe('reported');
      expect(run.usage.costUsd).toBeGreaterThan(0);
      expect(spentUsd).toBeCloseTo(run.usage.costUsd, 6);
    });

    it('sends thinking blocks back with a tool-use turn (the real API requires it)', async () => {
      sb.api.configure({ strictThinking: true });
      try {
        const before = sb.api.bodies.length;
        const { run } = await orchestrate('think-sonnet');
        expect(run.error).toBeNull();
        expect(run.status).toBe('completed');
        const second = sb.api.bodies.slice(before)[1]!.body;
        expect(second.thinking).toMatchObject({ type: 'enabled' });
        const assistant = second.messages?.findLast((m) => m.role === 'assistant');
        expect(assistant?.content).toEqual([
          {
            type: 'thinking',
            thinking: '状況を確認します。',
            signature: expect.any(String) as string,
          },
          expect.objectContaining({ type: 'tool_use', name: 'project__get' }),
        ]);
      } finally {
        sb.api.configure({ strictThinking: false });
      }
    });
  });

  it('explains LiteLLM-shaped errors (unknown model, provider errors, cooldown)', async () => {
    route(() => ({ content: [{ type: 'text', text: 'ok' }] }));
    // A model LiteLLM does not serve: 400, not 404, and nothing reaches the upstream.
    const unknown = await failure('no-such-model', 'x');
    expect(unknown.code).toBe('llm_model_not_found');
    expect(unknown.status).toBe(400);
    expect(unknown.message).toContain('LiteLLM にモデル「no-such-model」がありません');

    // Provider errors: LiteLLM's wrapper is removed, the provider's message kept.
    flaky = apiError(400, 'invalid_request_error');
    const bad = await failure('flaky-sonnet', 'x');
    expect(bad).toMatchObject({ code: 'llm_http_error', status: 400 });
    expect(bad.message).toBe('LLM の呼び出しに失敗しました（HTTP 400）: fake 400');

    // Overloaded (529): LiteLLM retries (3 upstream calls) and answers 500.
    flaky = apiError(529, 'overloaded_error');
    const n = sb.api.requests.length;
    const overloaded = await failure('flaky-sonnet', 'x');
    expect(overloaded.status).toBe(500);
    expect(sb.api.requests.length - n).toBe(3);
    expect(overloaded.message).toContain('LiteLLM か上流のモデルでエラーが発生しました: fake 529');

    // An upstream 401 puts the deployment in cooldown: the next call is a 429 from LiteLLM.
    flaky = apiError(401, 'authentication_error');
    const auth = await failure('flaky-sonnet', 'x');
    expect(auth.status).toBe(401);
    expect(auth.message).toContain('上流の認証情報を確認してください: fake 401');
    const m = sb.api.requests.length;
    const cooldown = await failure('flaky-sonnet', 'x');
    expect(sb.api.requests.length).toBe(m);
    expect(cooldown.status).toBe(429);
    expect(cooldown.message).toContain('このモデルへの送信を数秒間止めています');
    flaky = null;
  }, 60_000);

  it('stops a stalled stream that LiteLLM keeps open', async () => {
    route(() => ({
      content: [{ type: 'text', text: '止まる返答です。続きは来ません。' }],
      hangAfterDeltas: 1,
    }));
    const started = Date.now();
    const err = await collect('team-sonnet', 'x', 2000).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'llm_timeout' });
    expect((err as Error).message).toContain('2 秒以上応答がない');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

// ---------------------------------------------------------------------------------------
// 2. The Claude Agent SDK runtime (real CLI) through LiteLLM's /v1/messages
// ---------------------------------------------------------------------------------------

describe.skipIf(!bin || !cli)(
  'Claude Agent SDK through a real LiteLLM (fake Anthropic upstream)',
  () => {
    let real: ClaudeSdkModule;
    beforeAll(async () => {
      if (bin && cli) real = await loadRealSdk();
    });

    const settings = () =>
      Settings.parse({ litellm: { baseUrl: ll.url, apiKey: LITELLM_MASTER_KEY } });
    async function play(
      o: Omit<Parameters<typeof runScenario>[3], 'runtime'> & {
        runtime?: Record<string, unknown>;
      },
    ): Promise<{ r: ScenarioResult; bodies: typeof sb.api.bodies }> {
      const before = sb.api.bodies.length;
      const r = await runScenario(sb, cli!.path, real, {
        ...o,
        runtime: { settings, ...o.runtime },
      });
      expect(sb.proxy.attempts).toEqual([]);
      return { r, bodies: sb.api.bodies.slice(before) };
    }
    type Raw = Record<string, unknown>;
    const raw = (r: ScenarioResult) => r.messages as Raw[];
    const toolResults = (r: ScenarioResult) =>
      raw(r)
        .filter((m) => m.type === 'user')
        .flatMap((m) => {
          const c = (m.message as { content?: unknown })?.content;
          return Array.isArray(c) ? (c as Raw[]) : [];
        })
        .filter((b) => b.type === 'tool_result');
    const usage = (r: ScenarioResult) =>
      r.events.filter((e) => e.type === 'usage').map((e) => (e as { usage: unknown }).usage);

    it('streams through /v1/messages with the CLI beta headers and thinking passed on', async () => {
      route(() => undefined);
      sb.api.script([
        () => ({
          content: [
            { type: 'thinking', thinking: '挨拶を返します。' },
            { type: 'text', text: 'こんにちは。' },
          ],
          usage: { input_tokens: 1200, output_tokens: 30, cache_read_input_tokens: 800 },
        }),
      ]);
      const { r, bodies } = await play({ prompt: 'こんにちは' });
      expect(r.error).toBeNull();
      expect(r.events.filter((e) => e.type === 'text_delta').length).toBeGreaterThan(0);
      expect(usage(r)).toEqual([
        expect.objectContaining({ inputTokens: 2000, outputTokens: 30, costSource: 'estimated' }),
      ]);
      const main = bodies.find((b) => b.kind === 'main')!;
      // LiteLLM re-sends the CLI's betas (sorted) with its own key as x-api-key.
      expect(main.headers['user-agent']).toMatch(/^litellm\//);
      expect(main.headers['x-api-key']).toBe('<redacted>');
      expect(main.headers['anthropic-beta']?.split(',')).toEqual(
        expect.arrayContaining(['claude-code-20250219', 'interleaved-thinking-2025-05-14']),
      );
      expect(main.body).toMatchObject({
        model: UPSTREAM.sonnet,
        thinking: { type: 'enabled' },
        context_management: expect.anything() as unknown,
        max_tokens: 32000,
      });
    });

    it('maps a gateway alias to its deployment (LiteLLM adapts thinking for it)', async () => {
      route(() => undefined);
      sb.api.script([() => ({ content: [{ type: 'text', text: '別名の返答です。' }] })]);
      const { r, bodies } = await play({ prompt: 'こんにちは', model: 'team-sonnet' });
      expect(r.error).toBeNull();
      // The CLI prices an alias as unknown; the upstream gets the deployment's model.
      expect(usage(r)[0]).toMatchObject({ costSource: 'unknown' });
      const main = bodies.find((b) => b.kind === 'main')!.body;
      expect(main.model).toBe(UPSTREAM.sonnet);
      // The CLI sends adaptive thinking + output_config for an alias; LiteLLM turned it into
      // what the deployment's model (Sonnet 4.5) accepts.
      expect(main.thinking).toMatchObject({ type: 'enabled' });
      expect(main.output_config).toBeUndefined();
    });

    it('finds an MCP tool with ToolSearch (tool_reference) and calls it', async () => {
      route(() => undefined);
      const calls: unknown[] = [];
      sb.api.script([
        () => ({
          content: [
            { type: 'tool_use', name: 'ToolSearch', input: { query: 'select:mcp__acc__task_get' } },
          ],
        }),
        () => ({
          content: [
            {
              type: 'tool_use',
              name: 'mcp__acc__task_get',
              input: { taskId: `tsk_${'a'.repeat(26)}` },
            },
          ],
        }),
        () => ({ content: [{ type: 'text', text: 'ok' }] }),
      ]);
      const { r, bodies } = await play({ prompt: 'タスクを見て', tools: [taskGetTool(calls)] });
      expect(r.error).toBeNull();
      expect(calls).toHaveLength(1);
      const mains = bodies.filter((b) => b.kind === 'main').map((b) => b.body);
      const deferred = (mains[1]!.tools ?? []) as { name: string; defer_loading?: boolean }[];
      expect(deferred).toContainEqual(
        expect.objectContaining({ name: 'mcp__acc__task_get', defer_loading: true }),
      );
      expect(JSON.stringify(mains[1]!.messages?.at(-1))).toContain(
        '{"type":"tool_reference","tool_name":"mcp__acc__task_get"}',
      );
    });

    it('runs auto mode with its classifier requests through LiteLLM', async () => {
      for (const verdict of ['allow', 'block'] as const) {
        route((req) => (isClassifierRequest(req) ? classifierReply(req, verdict) : undefined));
        sb.api.script([
          () => ({
            content: [
              {
                type: 'tool_use',
                name: 'Bash',
                input: { command: 'node -e "process.exit(0)"', description: 'x' },
              },
            ],
          }),
          () => ({ content: [{ type: 'text', text: 'done' }] }),
        ]);
        const gate = new ToolGate({
          cwd: sb.repo,
          profile: 'autonomous',
          // The CLI's own classifier request (the server review needs a real Anthropic upstream).
          autoMode: { classifierModel: 'claude-sonnet-4-6', judge: 'client' },
          record: () => {},
        });
        const { r, bodies } = await play({
          prompt: 'node を動かして',
          model: 'claude-sonnet-4-6',
          gate,
        });
        expect(r.error).toBeNull();
        expect(r.asked).toEqual([]);
        const init = raw(r).find((m) => m.type === 'system' && m.subtype === 'init');
        expect(init?.permissionMode).toBe('auto');
        const classifier = bodies.filter((b) => b.kind === 'intercepted').map((b) => b.body);
        expect(classifier.length).toBe(verdict === 'allow' ? 1 : 2);
        expect(classifier[0]).toMatchObject({
          model: 'claude-sonnet-4-6',
          stop_sequences: ['</block>'],
          max_tokens: 64,
        });
        expect(toolResults(r)[0]?.is_error === true).toBe(verdict === 'block');
      }
    });

    it('explains errors as LiteLLM reshapes them and stops a stalled stream', async () => {
      route(() => undefined);
      // An unknown model is a 400 from LiteLLM (no upstream call), not a model_not_found 404.
      const unknown = await play({ prompt: 'x', model: 'no-such-model' });
      expect(unknown.r.error).toMatch(/^LiteLLM にモデル「no-such-model」がありません。.*HTTP 400/);
      expect(unknown.bodies).toEqual([]);

      flaky = apiError(400, 'invalid_request_error');
      const bad = await play({ prompt: 'x', model: 'flaky-sonnet' });
      expect(bad.r.error).toBe(
        'モデルの呼び出しでエラーが発生しました: HTTP 400 / API Error: 400 fake 400',
      );

      sb.api.script([
        () => ({
          content: [{ type: 'text', text: '止まる返答です。続きは来ません。' }],
          hangAfterDeltas: 1,
        }),
      ]);
      const stall = await play({ prompt: 'x', runtime: { idleTimeoutMs: 3000 } });
      expect(stall.r.error).toBe('Claude Code から 3 秒以上応答がないため停止しました');

      // Credentials rejected upstream: LiteLLM passes the 401 on; we stop at the first retry.
      flaky = apiError(401, 'authentication_error');
      const auth = await play({ prompt: 'x', model: 'flaky-sonnet' });
      expect(auth.r.error).toContain('Claude の認証に失敗しました');
      expect(auth.r.durationMs).toBeLessThan(15_000);
      flaky = null;
      await sleep(0);
    }, 90_000);
  },
);
