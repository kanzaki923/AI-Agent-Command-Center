/**
 * The mock agent's `ask` step (spec 20261029 §3.6, §3.12): with the `human.ask` tool it asks a
 * question, ends the run and continues the plan when the answer resumes the session.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRunInput, AgentTool } from '../../../contracts';
import { MockAgentRuntime } from '../runtime';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acc-mock-ask-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const plan = (p: unknown) => `作業して\n\n\`\`\`acc-mock\n${JSON.stringify(p)}\n\`\`\`\n`;

const STEPS = {
  steps: [
    { type: 'ask', title: '価格を載せる？', choices: ['載せる', '載せない'], allowText: false },
    { type: 'write', path: 'faq.md', content: '# FAQ\n' },
  ],
  summary: 'FAQ を書きました',
};

function humanAsk(result: unknown = { attentionId: 'atn_x', status: 'asked' }) {
  const calls: unknown[] = [];
  const tool: AgentTool = {
    method: 'human.ask',
    description: 'ask',
    execute: async (input) => {
      calls.push(input);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { tool, calls };
}

function input(prompt: string, over: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    runId: 'run_1',
    cwd: dir,
    writeRoot: dir,
    readRoots: [],
    maxBudgetUsd: null,
    prompt,
    signal: new AbortController().signal,
    canUseTool: () => Promise.reject(new Error('no approvals in this test')),
    ...over,
  };
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const textOf = (events: AgentEvent[]) =>
  events
    .filter((e): e is Extract<AgentEvent, { type: 'message' }> => e.type === 'message')
    .flatMap((e) => e.content)
    .map((p) => (p.type === 'text' ? p.text : ''));

describe('mock ask step with human.ask', () => {
  it('asks, stops the run, and the answer continues the rest of the plan', async () => {
    const mock = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
    const { tool, calls } = humanAsk();
    const first = await collect(mock.run(input(plan(STEPS), { tools: [tool] })));
    expect(calls).toEqual([
      { question: '価格を載せる？', choices: ['載せる', '載せない'], allowText: false },
    ]);
    expect(first.find((e) => e.type === 'tool_call')).toMatchObject({ name: 'human.ask' });
    expect(first.find((e) => e.type === 'tool_result')).toMatchObject({ isError: false });
    expect(textOf(first).at(-1)).toBe(
      '回答が届いたら続きから作業します。ここでいったん区切ります。',
    );
    expect(existsSync(join(dir, 'faq.md'))).toBe(false);
    const session = first.find((e) => e.type === 'session') as { runtimeSessionId: string };

    const second = await collect(
      mock.run(
        input('回答: 載せる', {
          runId: 'run_2',
          resumeSessionId: session.runtimeSessionId,
          tools: [tool],
        }),
      ),
    );
    expect(textOf(second)[0]).toBe('回答を受け取りました（載せる）。続きを進めます。');
    expect(textOf(second).at(-1)).toBe('FAQ を書きました');
    expect(existsSync(join(dir, 'faq.md'))).toBe(true);

    // The continuation is used once: another answer has nothing left to do.
    const third = await collect(
      mock.run(
        input('回答: もう一度', { runId: 'run_3', resumeSessionId: session.runtimeSessionId }),
      ),
    );
    expect(textOf(third).at(-1)).toBe('回答（もう一度）を確認しました。追加の作業はありません。');
  });

  it('a task run (plan in the task, answer in the extra instructions) continues, not restarts', async () => {
    const mock = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
    const { tool, calls } = humanAsk();
    const taskPrompt = (extra: string | null) =>
      [
        '# タスク: FAQ',
        '',
        plan(STEPS),
        ...(extra ? ['', '## 追加の指示', extra] : []),
        '',
        '作業はこのディレクトリの中で行ってください。',
      ].join('\n');
    const first = await collect(mock.run(input(taskPrompt(null), { tools: [tool] })));
    const session = first.find((e) => e.type === 'session') as { runtimeSessionId: string };
    const second = await collect(
      mock.run(
        input(taskPrompt('回答: 載せない\n補足です'), {
          runId: 'run_2',
          resumeSessionId: session.runtimeSessionId,
          tools: [tool],
        }),
      ),
    );
    expect(calls).toHaveLength(1);
    expect(textOf(second)[0]).toBe('回答を受け取りました（載せない）。続きを進めます。');
    expect(existsSync(join(dir, 'faq.md'))).toBe(true);
  });

  it('goes on without asking when the question cannot be sent', async () => {
    const mock = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
    const { tool } = humanAsk(new Error('forbidden'));
    const events = await collect(mock.run(input(plan(STEPS), { tools: [tool] })));
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      isError: true,
      output: 'forbidden',
    });
    expect(textOf(events)).toContain('質問を送れなかったため、確認せずに進めます。');
    expect(existsSync(join(dir, 'faq.md'))).toBe(true);
  });

  it('without the tool it is the approval scenario', async () => {
    const mock = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
    const asked: string[] = [];
    await collect(
      mock.run(
        input(plan(STEPS), {
          canUseTool: async (req) => {
            asked.push(req.toolName);
            return { decision: 'approved' };
          },
        }),
      ),
    );
    expect(asked).toEqual(['MockApproval']);
    expect(existsSync(join(dir, 'faq.md'))).toBe(true);
  });
});
