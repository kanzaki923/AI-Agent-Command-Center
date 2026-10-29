import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRunInput, ApprovalDecision } from '../contracts';
import { type ToolDecisionRecord, ToolGate } from './gate';
import { MockPlanError, parseMockPlan } from './mock/plan';
import { MockAgentRuntime, acceptanceCriteria, slugify, taskTitle } from './mock/runtime';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acc-mock-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });

const plan = (p: unknown) => `作業して\n\n\`\`\`acc-mock\n${JSON.stringify(p)}\n\`\`\`\n`;

function input(prompt: string, over: Partial<AgentRunInput> = {}) {
  const asked: Parameters<AgentRunInput['canUseTool']>[0][] = [];
  const decisions: ApprovalDecision[] = [];
  const base: AgentRunInput = {
    runId: 'run_test',
    cwd: dir,
    writeRoot: dir,
    readRoots: [],
    maxBudgetUsd: null,
    prompt,
    signal: new AbortController().signal,
    canUseTool: async (req) => {
      asked.push(req);
      return decisions.shift() ?? { decision: 'approved' };
    },
    ...over,
  };
  return { base, asked, decisions };
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
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n');

describe('acc-mock plan', () => {
  it('parses plans, shorthand arrays and reports errors in Japanese', () => {
    expect(parseMockPlan('普通の依頼')).toBeNull();
    expect(parseMockPlan(plan({ steps: [{ type: 'say', text: 'hi' }] }))).toEqual({
      steps: [{ type: 'say', text: 'hi' }],
    });
    expect(parseMockPlan(plan([{ type: 'run', command: 'node' }]))?.steps[0]).toMatchObject({
      type: 'run',
      args: [],
      allowFailure: false,
      onReject: 'stop',
    });
    // The latest instructions come after the task: the last block wins.
    const both = `${plan([{ type: 'say', text: 'task' }])}\n\n## 追加の指示\n${plan([{ type: 'say', text: 'new' }])}`;
    expect(parseMockPlan(both)?.steps).toEqual([{ type: 'say', text: 'new' }]);
    expect(() => parseMockPlan('```acc-mock\n{nope\n```')).toThrow(MockPlanError);
    expect(() => parseMockPlan(plan({ steps: [{ type: 'explode' }] }))).toThrow(
      /acc-mock ブロックの形式が正しくありません/,
    );
  });

  it('derives titles, slugs and acceptance criteria', () => {
    expect(taskTitle('# タスク: ログイン画面を作る\n詳細')).toBe('ログイン画面を作る');
    expect(slugify('ログイン画面を作る')).toBe('ログイン画面を作る');
    expect(slugify('Fix the README!')).toBe('fix-the-readme');
    expect(slugify('***')).toMatch(/^task-[0-9a-f]{8}$/);
    expect(slugify('CON')).toBe('con-task');
    expect(
      acceptanceCriteria(
        '# t\n## 完了条件\n- テストが通る\n- [ ] 型が通る\n## 追加の指示\n- 無関係',
      ),
    ).toEqual(['テストが通る', '型が通る']);
  });
});

describe('MockAgentRuntime default behaviour', () => {
  it('writes a notes file named after the task, then updates it on the next run', async () => {
    const prompt =
      '# タスク: README を整える\n\n見出しを揃える\n\n## 完了条件\n- 見出しが統一されている';
    const { base, asked } = input(prompt);
    const events = await collect(fast.run(base));

    const file = join(dir, 'notes', 'readme-を整える.md');
    const content = readFileSync(file, 'utf8');
    expect(content).toContain('# README を整える');
    expect(content).toContain('見出しを揃える');
    expect(content).toContain('- [ ] 見出しが統一されている');
    expect(asked).toEqual([]); // edits inside the workspace and reads need no approval

    expect(events[0]).toEqual({ type: 'session', runtimeSessionId: 'mock_run_test' });
    const types = events.map((e) => e.type);
    expect(types).toContain('text_delta');
    expect(types).toContain('usage');
    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls.map((c) => c.name)).toEqual(['Write', 'Grep']);
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(events).toContainEqual({
      type: 'activity',
      text: 'ファイルを編集中: notes/readme-を整える.md',
    });
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      usage: { costSource: 'estimated' },
    });
    // Deltas of a message add up to its text.
    const firstMsg = events.find((e) => e.type === 'message')!;
    const deltas = events
      .filter((e) => e.type === 'text_delta' && e.messageId === firstMsg.messageId)
      .map((e) => (e.type === 'text_delta' ? e.text : ''))
      .join('');
    expect(firstMsg.content[0]).toEqual({ type: 'text', text: deltas });
    expect(textOf(events)).toContain('notes/readme-を整える.md を作成しました');

    const again = input(prompt, { runId: 'run_two', resumeSessionId: 'mock_run_test' });
    const events2 = await collect(fast.run(again.base));
    expect(events2[0]).toEqual({ type: 'session', runtimeSessionId: 'mock_run_test' });
    expect(readFileSync(file, 'utf8')).toContain(
      '- run_two: 依頼内容を再確認し、メモを更新しました。',
    );
    expect(textOf(events2)).toContain('前回の作業の続きから再開します。');
  });
});

describe('MockAgentRuntime plans', () => {
  it('runs commands only after approval and reports their output', async () => {
    const { base, asked } = input(
      plan({
        steps: [
          { type: 'write', path: 'src/a.txt', content: 'one\n' },
          { type: 'append', path: 'src/a.txt', content: 'two\n' },
          {
            type: 'run',
            command: 'node',
            args: ['-e', "require('fs').writeFileSync('out.txt','ran');console.log('hello')"],
            title: 'スクリプトを実行する',
          },
          { type: 'check', path: 'out.txt', contains: 'ran' },
        ],
        summary: 'おわり',
      }),
    );
    const events = await collect(fast.run(base));
    expect(readFileSync(join(dir, 'src', 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('ran');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      toolName: 'Bash',
      input: { command: expect.stringMatching(/^node -e /) },
    });
    const bash = events.find((e) => e.type === 'tool_result' && e.name === 'Bash');
    expect(bash).toMatchObject({ isError: false, output: expect.stringContaining('hello') });
    expect(textOf(events).split('\n').at(-1)).toBe('おわり');
  });

  it('stops when a command is rejected', async () => {
    const { base, decisions } = input(
      plan([
        { type: 'run', command: 'node', args: ['-e', "require('fs').writeFileSync('x','1')"] },
        { type: 'write', path: 'after.txt', content: 'x' },
      ]),
    );
    decisions.push({ decision: 'rejected', note: '今はやめて' });
    const events = await collect(fast.run(base));
    expect(existsSync(join(dir, 'x'))).toBe(false);
    expect(existsSync(join(dir, 'after.txt'))).toBe(false);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ isError: true });
    expect(textOf(events)).toContain(
      '承認されなかったため、ここで作業を止めます（理由: 今はやめて）。',
    );
    expect(textOf(events)).toContain('途中で作業を止めました。');
  });

  it('continues or fails on rejected ask steps as requested', async () => {
    const cont = input(
      plan([
        { type: 'ask', title: '続けてよいですか', onReject: 'continue' },
        { type: 'write', path: 'ok.txt', content: 'x' },
      ]),
    );
    cont.decisions.push({ decision: 'rejected' });
    await collect(fast.run(cont.base));
    expect(cont.asked[0]).toMatchObject({ toolName: 'MockApproval', title: '続けてよいですか' });
    expect(existsSync(join(dir, 'ok.txt'))).toBe(true);

    const fail = input(plan([{ type: 'ask', title: '本当に?', onReject: 'fail' }]));
    fail.decisions.push({ decision: 'rejected' });
    await expect(collect(fast.run(fail.base))).rejects.toThrow('必要な操作が承認されませんでした');
  });

  it('fails on failing commands, fail steps and failed checks', async () => {
    await expect(
      collect(
        fast.run(
          input(plan([{ type: 'run', command: 'node', args: ['-e', 'process.exit(3)'] }])).base,
        ),
      ),
    ).rejects.toThrow('コマンドが失敗しました（終了コード 3）');
    await expect(
      collect(
        fast.run(
          input(
            plan([
              { type: 'run', command: 'node', args: ['-e', 'process.exit(3)'], allowFailure: true },
            ]),
          ).base,
        ),
      ),
    ).resolves.toBeDefined();
    await expect(
      collect(fast.run(input(plan([{ type: 'fail', message: 'ビルド失敗' }])).base)),
    ).rejects.toThrow('ビルド失敗');
    await expect(
      collect(fast.run(input(plan([{ type: 'check', path: 'missing.md' }])).base)),
    ).rejects.toThrow('確認に失敗しました: missing.md が見つかりません');
    await expect(
      collect(
        fast.run(input(plan([{ type: 'run', command: 'definitely-not-a-command-acc' }])).base),
      ),
    ).rejects.toThrow('コマンドが失敗しました');
  });

  it('never writes outside the workspace: the rules deny it and the mock carries on', async () => {
    const outside = join(dir, '..', `acc-outside-${Date.now()}.txt`);
    const { base, asked } = input(
      plan([
        { type: 'write', path: outside, content: 'x' },
        { type: 'write', path: 'inside.txt', content: 'y' },
      ]),
      // No temp-dir exception: the test's folders are in the temp dir.
      { gate: new ToolGate({ cwd: dir, profile: 'autonomous', policy: { allowedOutside: [] } }) },
    );
    const events = await collect(fast.run(base));
    expect(asked).toEqual([]);
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(dir, 'inside.txt'))).toBe(true);
    expect(events.filter((e) => e.type === 'tool_result')[0]).toMatchObject({
      isError: true,
      output: expect.stringContaining('worktree の外には書き込めません') as string,
    });
    expect(textOf(events)).toContain('デーモンの規則で拒否されました');
  });

  it('follows the gate: autonomous runs commands, careful asks, ask steps always ask', async () => {
    const steps = [
      { type: 'run', command: 'node', args: ['-e', 'process.exit(0)'] },
      { type: 'run', command: 'git', args: ['push'], onDeny: 'stop' },
      { type: 'write', path: 'never.txt', content: '' },
    ];
    const records: ToolDecisionRecord[] = [];
    const auto = input(plan(steps), {
      gate: new ToolGate({ cwd: dir, profile: 'autonomous', record: (r) => records.push(r) }),
    });
    const events = await collect(fast.run(auto.base));
    expect(auto.asked).toEqual([]);
    // onDeny "stop": the push was denied and the plan stopped there.
    expect(existsSync(join(dir, 'never.txt'))).toBe(false);
    expect(textOf(events)).toContain('ここで作業を止めます');
    expect(records.map((r) => [r.decision, r.rule])).toEqual([
      ['allowed', null],
      ['denied', 'publish_remote'],
    ]);

    const careful = input(plan([steps[0], { type: 'ask', title: '本番に触れてよいですか' }]), {
      gate: new ToolGate({ cwd: dir, profile: 'careful' }),
    });
    await collect(fast.run(careful.base));
    expect(careful.asked.map((a) => [a.toolName, a.category])).toEqual([
      ['Bash', 'command_other'],
      ['MockApproval', undefined],
    ]);
  });

  it('says what a long step is doing (the chip shows it as now)', async () => {
    const ac = new AbortController();
    const { base } = input(plan([{ type: 'sleep', ms: 10_000, activity: '競合サイトを確認中' }]), {
      signal: ac.signal,
    });
    const events: AgentEvent[] = [];
    const p = (async () => {
      for await (const e of fast.run(base)) events.push(e);
    })();
    await new Promise((r) => setTimeout(r, 20));
    ac.abort(new Error('cancelled'));
    await expect(p).rejects.toThrow('cancelled');
    expect(events).toContainEqual({ type: 'activity', text: '競合サイトを確認中' });
  });

  it('stops with the abort error when cancelled', async () => {
    const ac = new AbortController();
    const { base } = input(
      plan([
        { type: 'sleep', ms: 10_000 },
        { type: 'write', path: 'never.txt', content: '' },
      ]),
      {
        signal: ac.signal,
      },
    );
    const p = collect(fast.run(base));
    setTimeout(() => ac.abort(new Error('cancelled')), 20);
    await expect(p).rejects.toThrow('cancelled');
    expect(existsSync(join(dir, 'never.txt'))).toBe(false);
  });

  it('streams with delays by default and honours delayScale', async () => {
    const slow = new MockAgentRuntime({ stepDelayMs: 200, typingDelayMs: 50 });
    const started = Date.now();
    await collect(
      slow.run(input(plan({ steps: [{ type: 'say', text: 'こんにちは' }], delayScale: 0 })).base),
    );
    expect(Date.now() - started).toBeLessThan(150);
  });
});
