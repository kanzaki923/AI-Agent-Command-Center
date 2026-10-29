import { join } from 'node:path';
import type { AgentTool } from '../../../contracts';
import type { FakeAnthropicOptions, FakeReply, FakeTurn } from './fakeAnthropic';
import type { CliSandbox } from './harness';
import type { RunScenarioOptions } from './runner';

/**
 * Scenarios for the real Claude Code CLI against the fake API, shared by the contract test
 * (`sdk-contract.test.ts`, which asserts what the CLI does) and the fixture recorder
 * (`scripts/record-sdk-fixtures.ts`, which saves the raw message streams for the unit tests).
 */
export interface Scenario {
  name: string;
  api?: FakeAnthropicOptions;
  /** Script and run options, given the sandbox (paths). */
  setup(sb: CliSandbox): { turns: FakeTurn[]; run: RunScenarioOptions };
}

export const TASK_ID = `tsk_${'a'.repeat(26)}`;

const text =
  (t: string, usage?: FakeReply['usage']): FakeTurn =>
  () => ({
    content: [{ type: 'text', text: t }],
    ...(usage ? { usage } : {}),
  });
const toolUse =
  (name: string, input: Record<string, unknown>): FakeTurn =>
  () => ({
    content: [{ type: 'tool_use', name, input }],
  });
/** Final turn: echoes the tool results it got (so the test can see what the model saw). */
const echoResults: FakeTurn = (req) => ({
  content: [
    { type: 'text', text: `結果: ${JSON.stringify(req.toolResults.map((r) => r.is_error))}` },
  ],
});

export const scenarios = {
  /** a) Plain streamed text with a thinking block, priced model. */
  text: {
    name: 'text',
    setup: () => ({
      turns: [
        () => ({
          content: [
            { type: 'thinking', thinking: '挨拶を返します。' },
            { type: 'text', text: 'こんにちは。テスト用の返答です。' },
          ],
          usage: { input_tokens: 1200, output_tokens: 30, cache_read_input_tokens: 800 },
        }),
      ],
      run: { prompt: 'こんにちは' },
    }),
  },
  /** a) Same, but a gateway alias the CLI has no price for (costBasis "unknown"). */
  textAlias: {
    name: 'textAlias',
    setup: () => ({
      turns: [text('別名モデルの返答です。', { input_tokens: 500, output_tokens: 20 })],
      run: { prompt: 'こんにちは', model: 'team-sonnet' },
    }),
  },
  /** c) Read then Edit inside the workspace: the policy allows, no approval. */
  editInside: {
    name: 'editInside',
    setup: (sb) => ({
      turns: [
        toolUse('Read', { file_path: join(sb.repo, 'README.md') }),
        toolUse('Edit', {
          file_path: join(sb.repo, 'README.md'),
          old_string: 'hello',
          new_string: 'hello, world',
        }),
        text('README を直しました。'),
      ],
      run: { prompt: 'README を直して' },
    }),
  },
  /** b) A read-only Bash command the CLI auto-approves; our allowlist agrees. */
  bashReadOnly: {
    name: 'bashReadOnly',
    setup: () => ({
      turns: [toolUse('Bash', { command: 'git status', description: '状態' }), echoResults],
      run: { prompt: '状態を見て' },
    }),
  },
  /** b) A read-only-looking command our policy does not allow (git -c): the hook forces a prompt. */
  bashForcedAsk: {
    name: 'bashForcedAsk',
    setup: () => ({
      turns: [
        toolUse('Bash', { command: 'git -c core.pager=cat log -1', description: 'ログ' }),
        echoResults,
      ],
      run: { prompt: 'ログを見て', decide: async () => ({ decision: 'rejected', note: 'だめ' }) },
    }),
  },
  /** b) A command the CLI itself asks about: approved by the human. */
  bashApproved: {
    name: 'bashApproved',
    setup: () => ({
      turns: [
        toolUse('Bash', { command: 'echo hi > out.txt', description: '書き込み' }),
        echoResults,
      ],
      run: { prompt: 'ファイルを作って' },
    }),
  },
  /** c) Editing .git/config: the CLI would allow it inside cwd; the hard rules deny it. */
  editGitConfig: {
    name: 'editGitConfig',
    setup: (sb) => ({
      turns: [
        toolUse('Read', { file_path: join(sb.repo, '.git', 'config') }),
        toolUse('Edit', {
          file_path: join(sb.repo, '.git', 'config'),
          old_string: '[core]',
          new_string: '[core]\n\tfsmonitor = evil',
        }),
        echoResults,
      ],
      run: { prompt: '設定を変えて', decide: async () => ({ decision: 'rejected' }) },
    }),
  },
  /** c) Reading outside the workspace: asked. */
  readOutside: {
    name: 'readOutside',
    setup: (sb) => ({
      turns: [toolUse('Read', { file_path: join(sb.outside, 'secret.txt') }), echoResults],
      run: { prompt: '外を読んで', decide: async () => ({ decision: 'rejected' }) },
    }),
  },
  /** d) Search tools inside the workspace: registered and not asked. */
  search: {
    name: 'search',
    setup: () => ({
      turns: [
        toolUse('Grep', { pattern: 'hello' }),
        toolUse('Glob', { pattern: '**/*.ts' }),
        echoResults,
      ],
      run: { prompt: '探して' },
    }),
  },
  /** e) A disallowed tool (AskUserQuestion) called anyway. */
  askUser: {
    name: 'askUser',
    setup: () => ({
      turns: [
        toolUse('AskUserQuestion', {
          questions: [
            {
              question: 'どちらにしますか',
              header: '選択',
              multiSelect: false,
              options: [
                { label: 'A', description: 'a' },
                { label: 'B', description: 'b' },
              ],
            },
          ],
        }),
        echoResults,
      ],
      run: { prompt: '聞いて' },
    }),
  },
  /** Hook deny honoured by the CLI (forced, since our policy denies only removed tools). */
  hookDeny: {
    name: 'hookDeny',
    setup: () => ({
      turns: [toolUse('Bash', { command: 'git status', description: '状態' }), echoResults],
      run: { prompt: '状態を見て', forceHookDeny: ['Bash'] },
    }),
  },
  /**
   * A sub-agent (Agent tool) running a command: background tasks are off, so the Agent call
   * waits for it, and its tool uses go through the hook and the approval flow like any other.
   */
  subagent: {
    name: 'subagent',
    setup: () => ({
      turns: [
        toolUse('Agent', {
          description: '調査',
          prompt: 'ログを見て',
          subagent_type: 'general-purpose',
        }),
        // The sub-agent's own requests.
        toolUse('Bash', { command: 'git -c core.pager=cat log -1', description: 'ログ' }),
        text('サブエージェント完了'),
        // Back in the main thread with the Agent result.
        echoResults,
      ],
      run: { prompt: '調べて', decide: async () => ({ decision: 'rejected' }) },
    }),
  },
  /** f) In-process MCP round trip through our tool. */
  mcp: {
    name: 'mcp',
    setup: () => ({
      turns: [toolUse('mcp__acc__task_get', { taskId: TASK_ID }), echoResults],
      run: { prompt: 'タスクを見て', tools: [taskGetTool()] },
    }),
  },
  /** g) Interrupt while the response streams. */
  interruptStream: {
    name: 'interruptStream',
    setup: () => ({
      turns: [
        () => ({
          content: [{ type: 'text', text: 'とても長い返答の途中で止められる予定のテキストです。' }],
          hangAfterDeltas: 2,
        }),
      ],
      run: { prompt: '長く話して', abortOn: (ev) => ev.type === 'text_delta' },
    }),
  },
  /** g) Abort while an approval is pending. */
  abortPendingApproval: {
    name: 'abortPendingApproval',
    setup: () => ({
      turns: [toolUse('Bash', { command: 'rm -rf build', description: '削除' })],
      run: {
        prompt: '消して',
        decide: (_req, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('cancelled'))),
          ),
        abortAfterAskMs: 300,
      },
    }),
  },
  /** g) The API stream stalls: our idle timeout stops the run. */
  stall: {
    name: 'stall',
    setup: () => ({
      turns: [
        () => ({
          content: [{ type: 'text', text: '止まる返答です。続きは来ません。' }],
          hangAfterDeltas: 1,
        }),
      ],
      run: { prompt: '話して', runtime: { idleTimeoutMs: 3000 } as RunScenarioOptions['runtime'] },
    }),
  },
  /** API error (400): the CLI ends with success + is_error. */
  apiError: {
    name: 'apiError',
    api: {
      fallback: () => ({
        content: [],
        error: { status: 400, type: 'invalid_request_error', message: 'bad request from fake' },
      }),
    },
    setup: () => ({ turns: [], run: { prompt: 'エラーにして' } }),
  },
  /** Credentials rejected (401): the CLI retries; we stop at the first retry. */
  authError: {
    name: 'authError',
    api: {
      fallback: () => ({
        content: [],
        error: { status: 401, type: 'authentication_error', message: 'invalid x-api-key' },
      }),
    },
    setup: () => ({ turns: [], run: { prompt: '認証エラー' } }),
  },
} satisfies Record<string, Scenario>;

export type ScenarioName = keyof typeof scenarios;

export function taskGetTool(calls: unknown[] = []): AgentTool {
  return {
    method: 'task.get',
    description: 'Get a task.',
    execute: async (input) => {
      calls.push(input);
      return { id: TASK_ID, title: 'デモのタスク' };
    },
  };
}
