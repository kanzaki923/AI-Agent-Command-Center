/**
 * ClaudeMessageNormalizer and ClaudeAgentSdkRuntime against message streams RECORDED from the
 * real Claude Code CLI (claude/contract/recorded.ts, re-record with
 * `pnpm --filter @acc/daemon record:sdk-fixtures`). The runtime tests replay them through a
 * fake `query()`; the real CLI itself is exercised by claude/sdk-contract.test.ts.
 */
import type { HookCallback, HookInput, Options } from '@anthropic-ai/claude-agent-sdk';
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
import * as R from './claude/contract/recorded';
import { type RecordedStream, withPaths } from './claude/contract/recordedTypes';
import { DISALLOWED_AGENT_TOOLS } from './tools';
import { GATE_NOTES, type ToolDecisionRecord, ToolGate } from './gate';

const CWD = process.cwd();
const rec = (s: RecordedStream) => withPaths(s, { repo: CWD });
const sessionOf = (s: RecordedStream) => (s[0] as { session_id: string }).session_id;

function normalize(stream: RecordedStream, n = new ClaudeMessageNormalizer(CWD)) {
  const events = rec(stream).flatMap((m) => n.push(m));
  return { n, events: events.concat(n.finish()) };
}
const ofType = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);

describe('ClaudeMessageNormalizer (recorded streams)', () => {
  it('maps a streamed reply with thinking to deltas, one message and an estimated cost', () => {
    const { n, events } = normalize(R.TEXT);
    expect(events.slice(0, 2)).toEqual([
      { type: 'session', runtimeSessionId: sessionOf(R.TEXT) },
      { type: 'activity', text: 'Claude Code を起動しました' },
    ]);
    const deltas = ofType(events, 'text_delta');
    expect(new Set(deltas.map((d) => d.messageId)).size).toBe(1);
    expect(ofType(events, 'message')).toEqual([
      {
        type: 'message',
        messageId: deltas[0]!.messageId,
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '挨拶を返します。' },
          { type: 'text', text: deltas.map((d) => d.text).join('') },
        ],
      },
    ]);
    // Input counts cache reads too (1200 + 800).
    expect(events.at(-1)).toEqual({
      type: 'usage',
      usage: {
        inputTokens: 2000,
        outputTokens: 30,
        costUsd: expect.closeTo(0.00429, 9),
        costSource: 'estimated',
      },
    });
    expect(n.outcome).toEqual({ ok: true });
    expect(n.baselineTotals).toEqual({
      inputTokens: 2000,
      outputTokens: 30,
      costUsd: expect.closeTo(0.00429, 9),
    });
  });

  it('marks the cost unknown when the CLI had no price for the model (gateway alias)', () => {
    const { events } = normalize(R.TEXT_ALIAS);
    expect(ofType(events, 'usage')[0]?.usage.costSource).toBe('unknown');
  });

  it('maps tool uses and their results, persisting each message before its tool runs', () => {
    const { events } = normalize(R.EDIT_INSIDE);
    const types = events.map((e) => e.type);
    // Per tool: call → activity → message (flushed at message_stop) → result.
    expect(types.filter((t) => t !== 'text_delta')).toEqual([
      'session',
      'activity',
      'tool_call',
      'activity',
      'message',
      'tool_decision',
      'tool_result',
      'tool_call',
      'activity',
      'message',
      'tool_decision',
      'tool_result',
      'message',
      'usage',
    ]);
    // Who allowed each use (undocumented tool_result_meta): the CLI's mode, then our approval.
    expect(ofType(events, 'tool_decision')).toEqual([
      expect.objectContaining({ toolName: 'Read', decision: 'allowed', source: 'runtime' }),
      expect.objectContaining({ toolName: 'Edit', decision: 'allowed', source: 'human' }),
    ]);
    expect(ofType(events, 'activity').map((a) => a.text)).toEqual([
      'Claude Code を起動しました',
      'ファイルを読み込み中: README.md',
      'ファイルを編集中: README.md',
    ]);
    expect(ofType(events, 'tool_result')).toEqual([
      expect.objectContaining({ name: 'Read', isError: false }),
      expect.objectContaining({ name: 'Edit', isError: false }),
    ]);
  });

  it('reads MCP tool results and checks that our tools registered', () => {
    const ok = normalize(
      R.MCP,
      new ClaudeMessageNormalizer(CWD, undefined, {
        expectedTools: ['mcp__acc__task_get'],
      }),
    );
    expect(ok.n.fatal).toBeNull();
    expect(ofType(ok.events, 'tool_result')[0]).toMatchObject({
      name: 'mcp__acc__task_get',
      output: expect.stringContaining('デモのタスク') as string,
    });

    const missing = new ClaudeMessageNormalizer(CWD, undefined, {
      expectedTools: ['mcp__acc__task_get', 'mcp__acc__task_list'],
    });
    const mcpInit = rec(R.MCP)[0] as Record<string, unknown>;
    missing.push(mcpInit);
    expect(missing.fatal).toBe(
      'Control API のツールが Claude Code に登録されなかったため停止しました（未登録: mcp__acc__task_list、MCP サーバー: acc: connected）',
    );

    // A server still connecting is not a failure yet.
    const pending = new ClaudeMessageNormalizer(CWD, undefined, {
      expectedTools: ['mcp__acc__task_list'],
    });
    pending.push({ ...mcpInit, mcp_servers: [{ name: 'acc', status: 'pending' }] });
    expect(pending.fatal).toBeNull();
  });

  it('explains API errors and keeps zeroed error results out of the baseline', () => {
    const { n, events } = normalize(R.API_ERROR);
    expect(n.outcome).toEqual({
      ok: false,
      message:
        'モデルの呼び出しでエラーが発生しました: HTTP 400 / API Error: 400 bad request from fake',
    });
    expect(ofType(events, 'usage')).toEqual([]);
    expect(n.baselineTotals).toBeNull();
  });

  it('treats a rejected credential as fatal at the first retry', () => {
    const n = new ClaudeMessageNormalizer(CWD);
    const retry = rec(R.AUTH_ERROR).find(
      (m) => (m as { subtype?: string }).subtype === 'api_retry',
    );
    expect(n.push(retry)).toEqual([
      { type: 'activity', text: 'モデルの応答を待っています（再試行 1/10、HTTP 401）' },
    ]);
    expect(n.fatal).toBe(
      'Claude の認証に失敗しました。Claude Code へのログイン、または LiteLLM の URL / API キーを確認してください（HTTP 401）',
    );
  });

  it('reports the usage of an interrupted turn only when the CLI counted it', () => {
    // Interrupted while streaming: nothing was counted (zeroed totals).
    const stream = normalize(R.INTERRUPT_STREAM);
    expect(stream.n.outcome).toMatchObject({ ok: false });
    expect(ofType(stream.events, 'usage')).toEqual([]);
    expect(stream.n.baselineTotals).toBeNull();
    // Interrupted at an approval: the completed call before it was counted.
    const pending = normalize(R.ABORT_PENDING_APPROVAL);
    expect(ofType(pending.events, 'usage')).toEqual([
      { type: 'usage', usage: expect.objectContaining({ inputTokens: 100, outputTokens: 22 }) },
    ]);
  });

  it('reports a resumed run as the delta from the previous totals', () => {
    const first = normalize(R.RESUME_FIRST);
    const second = normalize(
      R.RESUME_SECOND,
      new ClaudeMessageNormalizer(CWD, first.n.baselineTotals!),
    );
    expect(ofType(second.events, 'usage')).toEqual([
      {
        type: 'usage',
        usage: {
          inputTokens: 2000,
          outputTokens: 10,
          costUsd: expect.closeTo(0.00615, 9),
          costSource: 'estimated',
        },
      },
    ]);
    expect(second.n.baselineTotals).toEqual({
      inputTokens: 3000,
      outputTokens: 20,
      costUsd: expect.closeTo(0.0093, 9),
    });
  });

  // Not recorded (needs a real sub-agent run): hand-written, minimal.
  it('keeps sub-agent narration out of the transcript but keeps its tool uses', () => {
    const n = new ClaudeMessageNormalizer(CWD);
    n.push(rec(R.TEXT)[0]);
    const sub = {
      type: 'assistant',
      parent_tool_use_id: 'tu_task',
      session_id: sessionOf(R.TEXT),
      message: {
        id: 'sub_1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'internal' },
          { type: 'tool_use', id: 'tu_s', name: 'Grep', input: { pattern: 'x' } },
        ],
      },
    };
    const events = [...n.push(sub), ...n.finish()];
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'activity']);
  });

  it('ignores unknown messages', () => {
    const n = new ClaudeMessageNormalizer(CWD);
    expect(n.push({ type: 'something_new', session_id: 's1' })).toEqual([
      { type: 'session', runtimeSessionId: 's1' },
    ]);
    expect(n.push(null)).toEqual([]);
  });
});

// ---- runtime with a replaying SDK ----------------------------------------------------------

interface FakeQuery extends QueryLike {
  options: Options;
  prompts: unknown[];
  interrupted: boolean;
  closed: boolean;
}

/**
 * Fake `query()` replaying recorded messages. `before` runs before message i is yielded (to
 * call `canUseTool` like the CLI would); `hangAt` stops yielding at index i until
 * interrupted / closed. Like the CLI, it exits once the prompt input ends.
 */
function replaySdk(
  messages: unknown[],
  opts: {
    before?: (i: number, options: Options) => Promise<void>;
    hangAt?: number;
    /** End without waiting for the input to close (a CLI that exits early). */
    exitEarly?: boolean;
    /** Keep yielding after interrupt() (the CLI answers an interrupt with a result). */
    afterInterrupt?: unknown[];
  } = {},
) {
  const queries: FakeQuery[] = [];
  const query: QueryFn = ({ prompt, options }) => {
    let wake: () => void = () => {};
    const woken = new Promise<void>((r) => (wake = r));
    const q: FakeQuery = {
      options,
      prompts: [],
      interrupted: false,
      closed: false,
      async interrupt() {
        q.interrupted = true;
        wake();
      },
      close() {
        q.closed = true;
        wake();
      },
      async *[Symbol.asyncIterator]() {
        const it = prompt[Symbol.asyncIterator]();
        q.prompts.push((await it.next()).value);
        for (const [i, m] of messages.entries()) {
          if (opts.hangAt === i) {
            await woken;
            if (q.closed) return;
            yield* opts.afterInterrupt ?? [];
            break;
          }
          await opts.before?.(i, options);
          yield m;
        }
        if (!opts.exitEarly) await Promise.race([it.next(), woken]);
      },
    };
    queries.push(q);
    return q;
  };
  return { module: { query } satisfies ClaudeSdkModule, queries };
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

const runtime = (
  module: ClaudeSdkModule,
  over: Partial<ConstructorParameters<typeof ClaudeAgentSdkRuntime>[0]> = {},
) => new ClaudeAgentSdkRuntime({ settings: settings(), loadSdk: async () => module, ...over });

/** Tool use ids are unique per call, like the CLI's (the gate answers one id once). */
let nextToolUse = 0;
const freshId = () => `tu_${++nextToolUse}`;

/** The PreToolUse hook the runtime registered. */
function preToolUse(
  options: Options,
): (toolName: string, toolInput: unknown, id?: string) => Promise<unknown> {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
  return (toolName, toolInput, id = freshId()) =>
    hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: toolInput,
        tool_use_id: id,
        session_id: 's',
        transcript_path: '',
        cwd: CWD,
      } satisfies HookInput,
      id,
      { signal: new AbortController().signal },
    );
}

const cut = (
  options: Options,
  toolName: string,
  toolInput: Record<string, unknown>,
  id = freshId(),
) =>
  options.canUseTool!(toolName, toolInput, {
    signal: new AbortController().signal,
    toolUseID: id,
    requestId: 'req_1',
  });

/** A gate like the executor builds, recording into `decisions`. */
function testGate(
  profile: 'careful' | 'standard' | 'autonomous',
  autoMode: { classifierModel: string | null } | null = null,
) {
  const decisions: ToolDecisionRecord[] = [];
  const permissions: unknown[] = [];
  const gate = new ToolGate({
    cwd: CWD,
    profile,
    autoMode,
    record: (d) => decisions.push(d),
    onPermission: (p) => permissions.push(p),
  });
  return { gate, decisions, permissions };
}

describe('ClaudeAgentSdkRuntime', () => {
  it('passes the fixed options and streams normalized events', async () => {
    const sdk = replaySdk(rec(R.TEXT));
    const rt = runtime(sdk.module, {
      settings: settings({ litellm: { baseUrl: 'http://127.0.0.1:4000', apiKey: 'sk-x' } }),
      parentEnv: { PATH: '/bin', SECRET_TOKEN: 'nope' },
      clientApp: 'acc/test',
    });
    expect(await rt.available()).toEqual({ ok: true });
    const events = await collect(rt.run(input({ model: 'team-sonnet', systemPrompt: 'be nice' })));
    expect(ofType(events, 'message')).toHaveLength(1);
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
    expect(q.options.disallowedTools).toEqual([...DISALLOWED_AGENT_TOOLS]);
    expect(q.options.hooks?.PreToolUse).toHaveLength(1);
    // Nothing bypasses canUseTool / the hook.
    expect(q.options.allowedTools).toBeUndefined();
    expect(q.options.resume).toBeUndefined();
    expect(q.options.env).toEqual({
      PATH: '/bin',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000',
      ANTHROPIC_AUTH_TOKEN: 'sk-x',
      ANTHROPIC_MODEL: 'team-sonnet',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'team-sonnet',
      CLAUDE_CODE_SUBAGENT_MODEL: 'team-sonnet',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'acc/test',
    });
    expect(q.prompts[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'README を直して' },
    });
    expect(q.closed).toBe(true);
  });

  it('enforces the policy in the PreToolUse hook for every tool use', async () => {
    // Without a gate from the executor: the careful profile.
    const sdk = replaySdk(rec(R.TEXT));
    await collect(runtime(sdk.module).run(input()));
    const hook = preToolUse(sdk.queries[0]!.options);
    // Allowed: the hook stays out of the way (the CLI may still ask; canUseTool re-checks).
    expect(await hook('Read', { file_path: `${CWD}/package.json` })).toEqual({});
    expect(await hook('Bash', { command: 'git status' })).toEqual({});
    expect(await hook('Grep', { pattern: 'x' })).toEqual({});
    expect(await hook('mcp__acc__task_get', {})).toEqual({});
    // Ask: the CLI then calls canUseTool even for tools it would auto-approve.
    for (const [tool, toolInput] of [
      ['Bash', { command: 'git -c core.quotepath=false log' }],
      ['Workflow', { script: 'x' }],
      ['Read', { file_path: '/definitely/outside/secret' }],
    ] as const) {
      expect(await hook(tool, toolInput)).toMatchObject({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
      });
    }
    // Deny (hard rules, every profile): removed tools that slip through, git metadata, push.
    expect(await hook('Monitor', { command: 'echo hi' })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(await hook('AskUserQuestion', {})).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('Work autonomously') as string,
      },
    });
    expect(await hook('Edit', { file_path: `${CWD}/.git/config` })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(await hook('Bash', { command: 'git push origin HEAD' })).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('Integration') as string,
      },
    });
  });

  it('runs the autonomous profile without asks, recording each decision once', async () => {
    const { gate, decisions } = testGate('autonomous');
    const sdk = replaySdk(rec(R.TEXT));
    await collect(runtime(sdk.module).run(input({ gate })));
    const o = sdk.queries[0]!.options;
    const hook = preToolUse(o);
    expect(o.permissionMode).toBe('default');
    expect(await hook('Bash', { command: 'pnpm test' }, 'tu_a')).toEqual({});
    // The CLI then calls canUseTool for the same use: the same answer, recorded once.
    expect(await cut(o, 'Bash', { command: 'pnpm test' }, 'tu_a')).toMatchObject({
      behavior: 'allow',
    });
    expect(await hook('Bash', { command: 'pnpm add left-pad' })).toEqual({});
    expect(await hook('Read', { file_path: '/definitely/outside/secret' })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(await hook('Bash', { command: 'cat ~/.ssh/id_rsa' })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(
      decisions.map((d) => [d.toolName, d.decision, d.decidedBy, d.category, d.routine]),
    ).toEqual([
      ['Bash', 'allowed', 'rule', 'build_test', false],
      ['Bash', 'allowed', 'rule', 'deps_add', false],
      ['Read', 'denied', 'rule', 'outside_read', false],
      ['Bash', 'denied', 'rule', 'command_other', false],
    ]);
    expect(decisions[1]!.notable).toBe(true);
    expect(decisions[3]!.rule).toBe('credentials');
  });

  it('answers canUseTool from the policy and the approval flow', async () => {
    const asked: string[] = [];
    const decisions: ApprovalDecision[] = [
      { decision: 'approved' },
      { decision: 'rejected', note: 'だめ' },
    ];
    const sdk = replaySdk(rec(R.TEXT));
    await collect(
      runtime(sdk.module).run(
        input({
          canUseTool: async (req) => {
            asked.push(req.toolName);
            const d = decisions.shift();
            if (!d) throw new Error('cancelled');
            return d;
          },
        }),
      ),
    );
    const o = sdk.queries[0]!.options;
    expect(await cut(o, 'Write', { file_path: `${CWD}/x.md` })).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: `${CWD}/x.md` },
    });
    expect(await cut(o, 'AskUserQuestion', {})).toMatchObject({ behavior: 'deny' });
    expect(await cut(o, 'Bash', { command: 'pnpm test' })).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'pnpm test' },
    });
    expect(await cut(o, 'Bash', { command: 'rm -rf build' })).toEqual({
      behavior: 'deny',
      message: 'The user rejected this tool use: だめ',
    });
    // A hard rule never reaches the human.
    expect(await cut(o, 'Bash', { command: 'rm -rf /' })).toMatchObject({ behavior: 'deny' });
    expect(await cut(o, 'WebFetch', { url: 'https://example.com' })).toEqual({
      behavior: 'deny',
      message: 'The run was cancelled.',
      interrupt: true,
    });
    expect(asked).toEqual(['Bash', 'Bash', 'WebFetch']);
  });

  it('hands the gray zone to the auto mode classifier when its model is configured', async () => {
    const { gate, decisions, permissions } = testGate('autonomous', {
      classifierModel: 'team-classifier',
    });
    // An init that reports auto mode (the recorded ones ran in default mode).
    const stream = rec(R.TEXT).map((m) =>
      (m as { type?: string; subtype?: string }).type === 'system' &&
      (m as { subtype?: string }).subtype === 'init'
        ? { ...(m as object), permissionMode: 'auto' }
        : m,
    );
    const sdk = replaySdk(stream);
    const rt = runtime(sdk.module, {
      settings: settings({ litellm: { baseUrl: 'http://127.0.0.1:4000', apiKey: 'sk-x' } }),
      parentEnv: { PATH: '/bin' },
    });
    await collect(rt.run(input({ gate, model: 'team-sonnet' })));
    const o = sdk.queries[0]!.options;
    expect(o.permissionMode).toBe('auto');
    expect(o.env).toMatchObject({
      CLAUDE_CODE_AUTO_MODE_MODEL: 'team-classifier',
      CLAUDE_CODE_AUTO_MODE_SERVER: '0',
    });
    expect(o.settings).toMatchObject({
      autoMode: { classifyAllShell: true, hard_deny: expect.arrayContaining(['$defaults']) },
    });
    expect(gate.mode).toBe('classifier');
    expect(permissions).toEqual([{ profile: 'autonomous', gate: 'classifier', note: null }]);

    const hook = preToolUse(o);
    // Gray zone: nothing from the hook, so the classifier decides (an allow would skip it).
    expect(await hook('Bash', { command: 'pnpm test' }, 'tu_c1')).toEqual({});
    // Hard rules still deny first; our own tools skip the classifier.
    expect(await hook('Bash', { command: 'git push' })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(await hook('mcp__acc__task_get', {})).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
    // The classifier blocked it repeatedly and the CLI asks: autonomous never asks a human.
    expect(await cut(o, 'Bash', { command: 'pnpm test' }, 'tu_c1')).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('繰り返し') as string,
    });
    expect(decisions.map((d) => [d.decision, d.decidedBy, d.notable])).toEqual([
      ['denied', 'rule', false],
      ['allowed', 'rule', false],
      ['denied', 'classifier', true],
    ]);
  });

  it('falls back to the rules when auto mode does not start or its classifier cannot answer', async () => {
    // LiteLLM without a classifier model: rules from the start.
    {
      const { gate } = testGate('autonomous', { classifierModel: null });
      const sdk = replaySdk(rec(R.TEXT));
      const rt = runtime(sdk.module, {
        settings: settings({ litellm: { baseUrl: 'http://127.0.0.1:4000' } }),
      });
      await collect(rt.run(input({ gate })));
      expect(sdk.queries[0]!.options.permissionMode).toBe('default');
      expect(gate.permission).toEqual({
        profile: 'autonomous',
        gate: 'rules',
        note: GATE_NOTES.noClassifierModel,
      });
    }
    // The user's Claude login: auto requested, but init says "default" (unsupported model).
    {
      const { gate } = testGate('standard', { classifierModel: null });
      const sdk = replaySdk(rec(R.TEXT));
      await collect(runtime(sdk.module).run(input({ gate })));
      expect(sdk.queries[0]!.options.permissionMode).toBe('auto');
      expect(gate.permission.note).toBe(GATE_NOTES.unsupportedModel);
    }
    // The classifier could not evaluate: leave auto mode and let the rules decide.
    {
      const { gate, decisions } = testGate('autonomous', { classifierModel: 'team-classifier' });
      const [init, ...rest] = rec(R.TEXT) as Record<string, unknown>[];
      const denied = {
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        tool_use_id: 'tu_x',
        decision_reason_type: 'classifier',
        message: 'Auto mode could not evaluate this action and is blocking it for safety.',
        uuid: 'u',
        session_id: init!.session_id,
      };
      let hook: ReturnType<typeof preToolUse> | null = null;
      const sdk = replaySdk([{ ...init, permissionMode: 'auto' }, denied, ...rest], {
        before: async (i, options) => {
          if (i !== 1) return;
          hook = preToolUse(options);
          expect(await hook('Bash', { command: 'pnpm test' }, 'tu_x')).toEqual({});
        },
      });
      const modes: string[] = [];
      const module: ClaudeSdkModule = {
        query: (p) => {
          const q = sdk.module.query(p);
          return Object.assign(q, {
            setPermissionMode: async (m: string) => {
              modes.push(m);
            },
          });
        },
      };
      const rt = runtime(module, {
        settings: settings({ litellm: { baseUrl: 'http://127.0.0.1:4000' } }),
      });
      await collect(rt.run(input({ gate })));
      expect(modes).toEqual(['default']);
      expect(gate.permission.note).toBe(GATE_NOTES.classifierUnavailable);
      expect(decisions).toEqual([
        expect.objectContaining({ decision: 'denied', decidedBy: 'classifier', notable: true }),
      ]);
      // From now on the rules allow it outright (explicitly: the CLI may still be in auto mode).
      expect(await hook!('Bash', { command: 'pnpm test' })).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'allow' },
      });
      expect(decisions.at(-1)).toMatchObject({ decision: 'allowed', decidedBy: 'rule' });
    }
  });

  it('resumes with the stored session and subtracts the baseline', async () => {
    const baselines = new MemoryBaselineStore();
    const first = normalize(R.RESUME_FIRST).n;
    const sid = sessionOf(R.RESUME_SECOND);
    baselines.set(sid, first.baselineTotals!);
    const sdk = replaySdk(rec(R.RESUME_SECOND));
    const events = await collect(
      runtime(sdk.module, { baselines }).run(input({ resumeSessionId: sid, model: 'gpt-4o' })),
    );
    expect(sdk.queries[0]!.options.resume).toBe(sid);
    // Not a Claude model and no LiteLLM: let the CLI pick its default.
    expect(sdk.queries[0]!.options.model).toBeUndefined();
    expect(ofType(events, 'usage')[0]?.usage).toMatchObject({
      inputTokens: 2000,
      outputTokens: 10,
    });
    expect(baselines.get(sid)).toMatchObject({ inputTokens: 3000, outputTokens: 20 });
  });

  it('fails the run on error results without touching the baseline', async () => {
    const baselines = new MemoryBaselineStore();
    const sid = sessionOf(R.API_ERROR);
    baselines.set(sid, { inputTokens: 5, outputTokens: 5, costUsd: 0.5 });
    const sdk = replaySdk(rec(R.API_ERROR));
    await expect(
      collect(runtime(sdk.module, { baselines }).run(input({ resumeSessionId: sid }))),
    ).rejects.toThrow('モデルの呼び出しでエラーが発生しました: HTTP 400');
    expect(baselines.get(sid)).toEqual({ inputTokens: 5, outputTokens: 5, costUsd: 0.5 });
  });

  it('stops the CLI at a fatal retry instead of waiting out the backoff', async () => {
    const msgs = rec(R.AUTH_ERROR);
    const retryAt = msgs.findIndex((m) => (m as { subtype?: string }).subtype === 'api_retry');
    const sdk = replaySdk(msgs.slice(0, retryAt + 1).concat([{ type: 'never' }]), {
      hangAt: retryAt + 1,
      afterInterrupt: msgs.slice(retryAt + 1),
    });
    await expect(
      collect(runtime(sdk.module, { interruptGraceMs: 10 }).run(input())),
    ).rejects.toThrow('Claude の認証に失敗しました');
    expect(sdk.queries[0]!.interrupted).toBe(true);
    expect(sdk.queries[0]!.closed).toBe(true);
  });

  it('fails when the CLI exits without a result, or crashes', async () => {
    const msgs = rec(R.TEXT);
    const noResult = replaySdk(msgs.slice(0, 2), { exitEarly: true });
    await expect(collect(runtime(noResult.module).run(input()))).rejects.toThrow(
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
    await expect(collect(runtime(crashing).run(input()))).rejects.toThrow(
      'Claude Code が異常終了しました: spawn ENOENT',
    );
  });

  it('interrupts on abort, still reports the interrupted turn usage, and ends with the abort error', async () => {
    // Recorded: abort during a pending approval; the CLI answers the interrupt with a result.
    const msgs = rec(R.ABORT_PENDING_APPROVAL);
    const resultAt = msgs.findIndex((m) => (m as { type?: string }).type === 'result');
    const userAt = msgs.findIndex((m) => (m as { type?: string }).type === 'user');
    const sdk = replaySdk(msgs.slice(0, userAt).concat([{ type: 'never' }]), {
      hangAt: userAt,
      afterInterrupt: msgs.slice(userAt, resultAt + 1),
    });
    const ac = new AbortController();
    const events: AgentEvent[] = [];
    const p = (async () => {
      for await (const e of runtime(sdk.module, { interruptGraceMs: 10 }).run(
        input({ signal: ac.signal }),
      )) {
        events.push(e);
        if (e.type === 'message') ac.abort(new Error('cancelled by test'));
      }
    })();
    await expect(p).rejects.toThrow('cancelled by test');
    expect(sdk.queries[0]!.interrupted).toBe(true);
    expect(sdk.queries[0]!.closed).toBe(true);
    // After the abort only usage is passed on (the CLI counted the completed call).
    expect(
      events.slice(events.findIndex((e) => e.type === 'message') + 1).map((e) => e.type),
    ).toEqual(['usage']);
  });

  it('stops a silent CLI after the idle timeout, but not while an approval is pending', async () => {
    const msgs = rec(R.TEXT);
    const silent = replaySdk(msgs, { hangAt: 2 });
    await expect(
      collect(runtime(silent.module, { idleTimeoutMs: 30, interruptGraceMs: 10 }).run(input())),
    ).rejects.toThrow('Claude Code から 0 秒以上応答がないため停止しました');
    expect(silent.queries[0]!.interrupted).toBe(true);
    expect(silent.queries[0]!.closed).toBe(true);

    // A human taking longer than the idle timeout to answer is not a hung CLI.
    const waiting = replaySdk(msgs, {
      before: async (i, options) => {
        if (i === 2) await cut(options, 'Bash', { command: 'pnpm test' });
      },
    });
    const slowHuman = async (): Promise<ApprovalDecision> => {
      await new Promise((r) => setTimeout(r, 120));
      return { decision: 'approved' };
    };
    const events = await collect(
      runtime(waiting.module, { idleTimeoutMs: 30 }).run(input({ canUseTool: slowHuman })),
    );
    expect(events.at(-1)).toMatchObject({ type: 'usage' });
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
    const sdk = replaySdk(rec(R.TEXT));
    let location: ClaudeCodeLocation = { ok: true, path: '/opt/claude/claude', source: 'path' };
    const rt = runtime(sdk.module, { locateExecutable: () => location });
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
