import { Settings } from '@acc/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunInput, ApprovalDecision } from '../contracts';
import type { ClaudeCodeLocation } from './claude/locate';
import { ClaudeMessageNormalizer } from './claude/normalize';
import {
  ClaudeAgentSdkRuntime,
  type ClaudeSdkModule,
  MemoryBaselineStore,
  type QueryFn,
  type QueryLike,
} from './claude/runtime';

const CWD = process.cwd();
const SID = 'sdk-session-1';

// ---- recorded-style SDK messages -----------------------------------------------------

const init = { type: 'system', subtype: 'init', session_id: SID, model: 'claude-x', tools: [] };
const streamStart = (id: string) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  session_id: SID,
  event: { type: 'message_start', message: { id, usage: {} } },
});
const streamText = (text: string) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  session_id: SID,
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
});
const streamStop = {
  type: 'stream_event',
  parent_tool_use_id: null,
  session_id: SID,
  event: { type: 'message_stop' },
};
const assistant = (id: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  session_id: SID,
  message: { id, role: 'assistant', content },
  ...extra,
});
const toolResult = (id: string, content: unknown, isError = false) => ({
  type: 'user',
  parent_tool_use_id: null,
  session_id: SID,
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
  },
});
const result = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: SID,
  result: 'done',
  total_cost_usd: 0.012,
  usage: { input_tokens: 10, output_tokens: 5 },
  modelUsage: {
    'claude-x': {
      inputTokens: 100,
      outputTokens: 40,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 0,
      costUSD: 0.012,
    },
  },
  ...extra,
});

/** A typical turn: text, a tool use, its result, final text, result. */
const TURN: unknown[] = [
  init,
  streamStart('msg_1'),
  streamText('ファイルを'),
  streamText('直します'),
  assistant('msg_1', [{ type: 'text', text: 'ファイルを直します' }]),
  assistant('msg_1', [
    { type: 'tool_use', id: 'tu_1', name: 'Edit', input: { file_path: `${CWD}/src/a.ts` } },
  ]),
  streamStop,
  toolResult('tu_1', [{ type: 'text', text: 'ok' }]),
  streamStart('msg_2'),
  streamText('完了'),
  assistant('msg_2', [{ type: 'text', text: '完了' }]),
  streamStop,
  result(),
];

describe('ClaudeMessageNormalizer', () => {
  it('maps a turn to agent events', () => {
    const n = new ClaudeMessageNormalizer(CWD);
    const events = TURN.flatMap((m) => n.push(m)).concat(n.finish());
    expect(events).toEqual([
      { type: 'session', runtimeSessionId: SID },
      { type: 'activity', text: 'Claude Code を起動しました' },
      { type: 'text_delta', messageId: 'msg_1', text: 'ファイルを' },
      { type: 'text_delta', messageId: 'msg_1', text: '直します' },
      {
        type: 'tool_call',
        toolCallId: 'tu_1',
        name: 'Edit',
        input: { file_path: `${CWD}/src/a.ts` },
      },
      { type: 'activity', text: 'ファイルを編集中: src/a.ts' },
      {
        type: 'message',
        messageId: 'msg_1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'ファイルを直します' },
          {
            type: 'tool_call',
            toolCallId: 'tu_1',
            name: 'Edit',
            input: { file_path: `${CWD}/src/a.ts` },
          },
        ],
      },
      { type: 'tool_result', toolCallId: 'tu_1', name: 'Edit', output: 'ok', isError: false },
      { type: 'text_delta', messageId: 'msg_2', text: '完了' },
      {
        type: 'message',
        messageId: 'msg_2',
        role: 'assistant',
        content: [{ type: 'text', text: '完了' }],
      },
      {
        type: 'usage',
        usage: { inputTokens: 1000, outputTokens: 40, costUsd: 0.012, costSource: 'reported' },
      },
    ]);
    expect(n.outcome).toEqual({ ok: true });
    expect(n.sessionId).toBe(SID);
  });

  it('reports usage as a delta from the resume baseline', () => {
    const n = new ClaudeMessageNormalizer(CWD, {
      inputTokens: 600,
      outputTokens: 30,
      costUsd: 0.01,
    });
    n.push(init);
    const events = n.push(result());
    expect(events).toEqual([
      {
        type: 'usage',
        usage: {
          inputTokens: 400,
          outputTokens: 10,
          costUsd: expect.closeTo(0.002, 9),
          costSource: 'reported',
        },
      },
    ]);
    expect(n.usageTotals).toEqual({ inputTokens: 1000, outputTokens: 40, costUsd: 0.012 });
  });

  it('turns error results into a Japanese failure', () => {
    const n = new ClaudeMessageNormalizer(CWD);
    n.push(assistant('m', [{ type: 'text', text: 'x' }], { error: 'authentication_failed' }));
    n.push(result({ subtype: 'error_during_execution', is_error: true, errors: ['401'] }));
    expect(n.outcome).toEqual({
      ok: false,
      message: expect.stringContaining('Claude の認証に失敗しました'),
    });

    const m = new ClaudeMessageNormalizer(CWD);
    m.push(result({ subtype: 'error_max_turns', is_error: true }));
    expect(m.outcome).toEqual({ ok: false, message: 'ターン数の上限に達したため停止しました' });
  });

  it('keeps sub-agent narration out of the transcript but keeps its tool uses', () => {
    const n = new ClaudeMessageNormalizer(CWD);
    const sub = {
      ...assistant('sub_1', [
        { type: 'text', text: 'internal' },
        { type: 'tool_use', id: 'tu_s', name: 'Grep', input: { pattern: 'x' } },
      ]),
      parent_tool_use_id: 'tu_task',
    };
    n.push(init);
    const events = [...n.push(sub), ...n.finish()];
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'activity']);
  });

  it('ignores unknown messages and maps thinking blocks to reasoning', () => {
    const n = new ClaudeMessageNormalizer(CWD);
    expect(n.push({ type: 'rate_limit_event', session_id: SID })).toEqual([
      { type: 'session', runtimeSessionId: SID },
    ]);
    expect(n.push(null)).toEqual([]);
    n.push(assistant('m1', [{ type: 'thinking', thinking: 'hmm' }]));
    expect(n.finish()).toEqual([
      {
        type: 'message',
        messageId: 'm1',
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'hmm' }],
      },
    ]);
  });
});

// ---- runtime with a fake SDK -------------------------------------------------------------

interface FakeQuery extends QueryLike {
  options: Parameters<QueryFn>[0]['options'];
  prompts: unknown[];
  interrupted: boolean;
  closed: boolean;
}

/**
 * Fake `query()`: replays `messages`, calling `canUseTool` when it meets a
 * `{ type: '__ask__', tool, input }` marker (like the CLI's permission control request).
 */
function fakeSdk(messages: unknown[], opts: { hangAfter?: number; exitEarly?: boolean } = {}) {
  const queries: FakeQuery[] = [];
  const query: QueryFn = ({ prompt, options }) => {
    let stop: () => void = () => {};
    const stopped = new Promise<void>((r) => (stop = r));
    const q: FakeQuery = {
      options,
      prompts: [],
      interrupted: false,
      closed: false,
      async interrupt() {
        q.interrupted = true;
        stop();
      },
      close() {
        q.closed = true;
        stop();
      },
      async *[Symbol.asyncIterator]() {
        const it = prompt[Symbol.asyncIterator]();
        q.prompts.push((await it.next()).value);
        for (const [i, m] of messages.entries()) {
          if (opts.hangAfter !== undefined && i === opts.hangAfter) {
            await stopped;
            return;
          }
          const rec = m as { type: string; tool?: string; input?: Record<string, unknown> };
          if (rec.type === '__ask__') {
            const r = await options.canUseTool!(rec.tool!, rec.input!, {
              signal: new AbortController().signal,
              toolUseID: 'tu_x',
              requestId: 'req_1',
            });
            yield { type: '__decision__', r };
            continue;
          }
          yield m;
        }
        // Like the CLI: exit once the input stream ends (or crash early).
        if (!opts.exitEarly) await it.next();
      },
    };
    queries.push(q);
    return q;
  };
  const module: ClaudeSdkModule = { query };
  return { module, queries };
}

function input(over: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    runId: 'run_1',
    cwd: CWD,
    prompt: 'README を直して',
    signal: new AbortController().signal,
    canUseTool: async () => ({ decision: 'approved' }),
    ...over,
  };
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const settings =
  (s: unknown = {}) =>
  () =>
    Settings.parse(s);

describe('ClaudeAgentSdkRuntime', () => {
  it('passes the fixed options and streams normalized events', async () => {
    const sdk = fakeSdk(TURN);
    const rt = new ClaudeAgentSdkRuntime({
      settings: settings({ litellm: { baseUrl: 'http://127.0.0.1:4000', apiKey: 'sk-x' } }),
      loadSdk: async () => sdk.module,
      parentEnv: { PATH: '/bin', SECRET_TOKEN: 'nope' },
      clientApp: 'acc/test',
    });
    expect(await rt.available()).toEqual({ ok: true });
    const events = await collect(rt.run(input({ model: 'team-sonnet', systemPrompt: 'be nice' })));
    expect(events.filter((e) => e.type === 'message')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'usage' });

    const q = sdk.queries[0]!;
    expect(q.options).toMatchObject({
      cwd: CWD,
      permissionMode: 'default',
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: true,
      model: 'team-sonnet',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'be nice' },
    });
    expect(q.options.resume).toBeUndefined();
    expect(q.options.env).toEqual({
      PATH: '/bin',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000',
      ANTHROPIC_AUTH_TOKEN: 'sk-x',
      ANTHROPIC_MODEL: 'team-sonnet',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'team-sonnet',
      CLAUDE_CODE_SUBAGENT_MODEL: 'team-sonnet',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'acc/test',
    });
    expect(q.prompts[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'README を直して' },
    });
    expect(q.closed).toBe(true);
  });

  it('routes permissions through the policy and the approval flow', async () => {
    const sdk = fakeSdk([
      init,
      { type: '__ask__', tool: 'Read', input: { file_path: `${CWD}/package.json` } },
      { type: '__ask__', tool: 'Bash', input: { command: 'pnpm test' } },
      { type: '__ask__', tool: 'Bash', input: { command: 'rm -rf /' } },
      result(),
    ]);
    const asked: string[] = [];
    const decisions: ApprovalDecision[] = [
      { decision: 'approved' },
      { decision: 'rejected', note: '危険' },
    ];
    const rt = new ClaudeAgentSdkRuntime({ settings: settings(), loadSdk: async () => sdk.module });
    await collect(
      rt.run(
        input({
          canUseTool: async (req) => {
            asked.push(`${req.toolName}:${(req.input as { command: string }).command}`);
            return decisions.shift()!;
          },
        }),
      ),
    );
    // The in-workspace Read was allowed by policy without asking.
    expect(asked).toEqual(['Bash:pnpm test', 'Bash:rm -rf /']);
  });

  it('returns allow/deny results to the SDK', async () => {
    const results: unknown[] = [];
    // Drive canUseTool directly and record what goes back to the SDK.
    const recording: ClaudeSdkModule = {
      query: (params) => {
        const cut = params.options.canUseTool!;
        const opts = {
          signal: new AbortController().signal,
          toolUseID: 't',
          requestId: 'r',
        } as Parameters<typeof cut>[2];
        return {
          interrupt: async () => {},
          close: () => {},
          async *[Symbol.asyncIterator]() {
            results.push(await cut('Write', { file_path: `${CWD}/x.md` }, opts));
            results.push(await cut('Write', { file_path: '/definitely/outside/x.md' }, opts));
            results.push(await cut('Bash', { command: 'ls' }, opts));
            yield result();
          },
        };
      },
    };
    const rt2 = new ClaudeAgentSdkRuntime({ settings: settings(), loadSdk: async () => recording });
    let n = 0;
    await collect(
      rt2.run(
        input({
          canUseTool: async () => {
            n += 1;
            if (n === 1) return { decision: 'rejected', note: 'だめ' };
            throw new Error('cancelled');
          },
        }),
      ),
    );
    expect(results).toEqual([
      { behavior: 'allow', updatedInput: { file_path: `${CWD}/x.md` } },
      { behavior: 'deny', message: 'The user rejected this tool use: だめ' },
      { behavior: 'deny', message: 'The run was cancelled.', interrupt: true },
    ]);
  });

  it('resumes with the stored session and subtracts the baseline', async () => {
    const baselines = new MemoryBaselineStore();
    baselines.set(SID, { inputTokens: 900, outputTokens: 30, costUsd: 0.01 });
    const sdk = fakeSdk([init, result()]);
    const rt = new ClaudeAgentSdkRuntime({
      settings: settings(),
      loadSdk: async () => sdk.module,
      baselines,
    });
    const events = await collect(rt.run(input({ resumeSessionId: SID, model: 'gpt-4o' })));
    expect(sdk.queries[0]!.options.resume).toBe(SID);
    // Not a Claude model and no LiteLLM: let the CLI pick its default.
    expect(sdk.queries[0]!.options.model).toBeUndefined();
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        costUsd: expect.closeTo(0.002, 9),
        costSource: 'reported',
      },
    });
    expect(baselines.get(SID)).toEqual({ inputTokens: 1000, outputTokens: 40, costUsd: 0.012 });
  });

  it('fails the run on error results', async () => {
    const sdk = fakeSdk([init, result({ subtype: 'error_max_budget_usd', is_error: true })]);
    const rt = new ClaudeAgentSdkRuntime({ settings: settings(), loadSdk: async () => sdk.module });
    await expect(collect(rt.run(input()))).rejects.toThrow('予算の上限に達したため停止しました');
  });

  it('fails when the CLI exits without a result', async () => {
    const sdk = fakeSdk([init], { exitEarly: true });
    const rt = new ClaudeAgentSdkRuntime({ settings: settings(), loadSdk: async () => sdk.module });
    await expect(collect(rt.run(input()))).rejects.toThrow(
      'Claude Code が結果を返さずに終了しました',
    );

    const crashing: ClaudeSdkModule = {
      query: () => ({
        interrupt: async () => {},
        close: () => {},
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator]() {
          throw new Error('spawn ENOENT');
        },
      }),
    };
    const rt2 = new ClaudeAgentSdkRuntime({ settings: settings(), loadSdk: async () => crashing });
    await expect(collect(rt2.run(input()))).rejects.toThrow(
      'Claude Code が異常終了しました: spawn ENOENT',
    );
  });

  it('interrupts on abort and ends with the abort error', async () => {
    const sdk = fakeSdk([init, streamStart('m'), streamText('x')], { hangAfter: 3 });
    const rt = new ClaudeAgentSdkRuntime({
      settings: settings(),
      loadSdk: async () => sdk.module,
      interruptGraceMs: 10,
    });
    const ac = new AbortController();
    const events: AgentEvent[] = [];
    const p = (async () => {
      for await (const e of rt.run(input({ signal: ac.signal }))) {
        events.push(e);
        if (e.type === 'text_delta') ac.abort(new Error('cancelled by test'));
      }
    })();
    await expect(p).rejects.toThrow('cancelled by test');
    expect(sdk.queries[0]!.interrupted).toBe(true);
    expect(sdk.queries[0]!.closed).toBe(true);
  });

  it('reports the SDK as unavailable when it cannot be loaded', async () => {
    const load = vi.fn(async (): Promise<ClaudeSdkModule> => {
      throw new Error('Cannot find module');
    });
    const rt = new ClaudeAgentSdkRuntime({ settings: settings(), loadSdk: load });
    const r = await rt.available();
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: expect.stringContaining('Claude Agent SDK') });
    await expect(collect(rt.run(input()))).rejects.toThrow(
      'Claude Agent SDK を読み込めませんでした',
    );
    // Failed loads are retried.
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('passes the located Claude Code executable, or reports why it is missing', async () => {
    const sdk = fakeSdk(TURN);
    let location: ClaudeCodeLocation = { ok: true, path: '/opt/claude/claude', source: 'path' };
    const rt = new ClaudeAgentSdkRuntime({
      settings: settings(),
      loadSdk: async () => sdk.module,
      locateExecutable: () => location,
    });
    expect(await rt.available()).toEqual({ ok: true });
    await collect(rt.run(input()));
    expect(sdk.queries[0]!.options.pathToClaudeCodeExecutable).toBe('/opt/claude/claude');

    // Looked up again per call: uninstalling (or installing) needs no daemon restart.
    location = { ok: false, reason: 'Claude Code の実行ファイルが見つかりません' };
    expect(await rt.available()).toEqual({
      ok: false,
      reason: 'Claude Code の実行ファイルが見つかりません',
    });
    await expect(collect(rt.run(input()))).rejects.toThrow('実行ファイルが見つかりません');
    expect(sdk.queries).toHaveLength(1);
  });
});
