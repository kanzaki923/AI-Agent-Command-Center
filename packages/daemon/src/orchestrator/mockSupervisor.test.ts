/**
 * The mock supervisor's state machine (spec 20261029 §3.13), as a pure function of the
 * request: what arrived last decides the reply, and only the plan / follow-ups call tools.
 */
import { describe, expect, it } from 'vitest';
import { WAKE_MARKER } from '../inbox/wake';
import { mockCallInfo } from '../llm/mock';
import { toolNameForMethod } from '../llm/tools';
import type { ChatMessage, ChatRequest } from '../llm/types';
import { REPOSITORY_LABEL, PROJECT_ID_LABEL, TREE_HEADING } from './executor';
import { mockOrchestrator } from './mockModel';
import { childPlans, mockSupervisor } from './mockSupervisor';

const SUPERVISOR_TOOLS = [
  'session.spawn',
  'session.tree',
  'session.stop',
  'session.resume',
  'attention.respond',
  'orchestrator.recordDecision',
];
const SELF = 'ses_00000000000000000000000000';
const PRJ = 'prj_00000000000000000000000000';

function system(
  children: { id: string; title: string; state: string; outputs?: string }[],
  repo = false,
) {
  return [
    'You lead other agents.',
    'Project',
    `- ${PROJECT_ID_LABEL} ${PRJ}`,
    `- ${REPOSITORY_LABEL} ${repo ? 'yes' : 'no'}`,
    '',
    TREE_HEADING,
    `- [${SELF}] 「指揮役」（この会話） state=supervising`,
    ...children.map(
      (c) =>
        `  - [${c.id}] 「${c.title}」 state=${c.state}${c.outputs ? ` outputs=${c.outputs}` : ''}`,
    ),
  ].join('\n');
}

function request(messages: ChatMessage[], tools = SUPERVISOR_TOOLS): ChatRequest {
  return {
    model: 'mock/orchestrator',
    messages,
    tools: tools.map((t) => ({ name: toolNameForMethod(t), description: t, parameters: {} })),
  };
}

const reply = (req: ChatRequest) => mockSupervisor(req, mockCallInfo(req));
const methods = (r: { toolCalls?: { name: string }[] }) =>
  (r.toolCalls ?? []).map((c) => c.name.replaceAll('__', '.'));
const kid = (n: number, state: string, title = `子${n}`, outputs?: string) => ({
  id: `ses_0000000000000000000000000${n}`,
  title,
  state,
  ...(outputs ? { outputs } : {}),
});

describe('mock supervisor', () => {
  it('a goal: three children and the plan in one reply (never a decision-only reply)', () => {
    const r = reply(
      request([
        { role: 'system', content: system([]) },
        { role: 'user', content: '週報を作って' },
      ]),
    );
    expect(methods(r)).toEqual([
      'session.spawn',
      'session.spawn',
      'session.spawn',
      'orchestrator.recordDecision',
    ]);
    expect(r.text).toContain('3 つの作業に分けて任せます');
    const inputs = (r.toolCalls ?? []).slice(0, 3).map((c) => c.input as Record<string, unknown>);
    expect(inputs.every((i) => i.mode === 'agent' && !('workspace' in i))).toBe(true);
    expect(String(inputs[0]!.goal)).toContain('```acc-mock');
  });

  it('a code project gets one worktree child; the others work without git', () => {
    const plans = childPlans('ログイン画面を直して', PRJ);
    expect(plans.filter((p) => p.code)).toHaveLength(1);
    const r = reply(
      request([
        { role: 'system', content: system([], true) },
        { role: 'user', content: 'ログイン画面を直して' },
      ]),
    );
    const spawns = (r.toolCalls ?? []).filter((c) => c.name === 'session__spawn');
    expect(spawns.filter((c) => 'workspace' in (c.input as object))).toHaveLength(1);
    expect((spawns[1]!.input as { workspace: unknown }).workspace).toEqual({
      kind: 'worktree',
      projectId: PRJ,
    });
  });

  it('after the spawn results it answers with text only (the run ends)', () => {
    const plan = reply(
      request([
        { role: 'system', content: system([]) },
        { role: 'user', content: '新製品のローンチ準備' },
      ]),
    );
    const calls = (plan.toolCalls ?? []).map((c, i) => ({
      id: `c${i}`,
      name: c.name,
      arguments: JSON.stringify(c.input),
    }));
    const r = reply(
      request([
        { role: 'system', content: system([]) },
        { role: 'user', content: '新製品のローンチ準備' },
        { role: 'assistant', content: plan.text ?? null, toolCalls: calls },
        ...calls.map((c) => ({ role: 'tool' as const, toolCallId: c.id, content: '{"ok":true}' })),
      ]),
    );
    expect(r.toolCalls ?? []).toEqual([]);
    expect(r.text).toContain(
      '3 人に任せました：「競合の価格を調べる」、「FAQ を書く」、「告知文を書く」',
    );
  });

  it('a wake with some children working: progress only; all finished: the final report without tools', () => {
    const some = reply(
      request([
        { role: 'system', content: system([kid(1, 'done', 'A'), kid(2, 'working', 'B')]) },
        { role: 'user', content: 'goal' },
        { role: 'assistant', content: '任せました' },
        { role: 'user', content: `${WAKE_MARKER}\n- 「A」: 完了` },
      ]),
    );
    expect(some.toolCalls ?? []).toEqual([]);
    expect(some.text).toBe('1/2 件が終わりました。「B」の作業が終わるのを待ちます。');

    const all = reply(
      request([
        {
          role: 'system',
          content: system([
            kid(1, 'done', 'A', '「価格表」(art_00000000000000000000000001)'),
            kid(2, 'review', 'B'),
          ]),
        },
        { role: 'user', content: 'goal' },
        { role: 'user', content: `${WAKE_MARKER}\n- 「B」: 確認待ち` },
      ]),
    );
    expect(all.toolCalls ?? []).toEqual([]);
    expect(all.text).toContain('すべての作業が終わりました（2 件）');
    expect(all.text).toContain('「A」: 完了 — 成果物 「価格表」');
    expect(all.text).toContain('確認してほしいもの: 「B」の成果物');
  });

  it('a question is answered when the goal already answers it, else left to the human', () => {
    const wake = [
      WAKE_MARKER,
      `- 「FAQ」（${kid(1, 'x').id}）: 人の判断を待っています`,
      '  質問: 「価格を載せる？」（atn_00000000000000000000000001） 選択肢: 載せる（yes） / 載せない（no）',
    ].join('\n');
    const msgs = (goal: string): ChatMessage[] => [
      { role: 'system', content: system([kid(1, 'needs_you', 'FAQ')]) },
      { role: 'user', content: goal },
      { role: 'user', content: wake },
    ];
    const answered = reply(request(msgs('FAQ を作って。価格は載せない方針で')));
    expect(methods(answered)).toEqual(['attention.respond']);
    expect(answered.toolCalls![0]!.input).toEqual({
      attentionId: 'atn_00000000000000000000000001',
      choiceId: 'no',
    });
    const left = reply(request(msgs('FAQ を作って')));
    expect(left.toolCalls ?? []).toEqual([]);
    expect(left.text).toContain('「FAQ」はあなたの判断を待っています（「価格を載せる？」）');
  });

  it('"いま何してる？" asks session.tree; "止めて" stops the children that work', () => {
    const sys = { role: 'system' as const, content: system([kid(1, 'working'), kid(2, 'done')]) };
    const now = reply(
      request([
        sys,
        { role: 'user', content: 'goal' },
        { role: 'user', content: 'いま何してる？' },
      ]),
    );
    expect(methods(now)).toEqual(['session.tree']);
    expect(now.toolCalls![0]!.input).toEqual({ sessionId: SELF });
    const stop = reply(
      request([sys, { role: 'user', content: 'goal' }, { role: 'user', content: '止めて' }]),
    );
    expect(methods(stop)).toEqual(['session.stop']);
    expect(stop.toolCalls![0]!.input).toEqual({ sessionId: kid(1, 'x').id });
  });

  it('mock/orchestrator picks the supervisor machine only when session.spawn is a tool', async () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: system([]) },
      { role: 'user', content: 'goal' },
    ];
    const sup = await mockOrchestrator(request(msgs), mockCallInfo(request(msgs)));
    expect(methods(sup)).toContain('session.spawn');
    const none = await mockOrchestrator(request(msgs, []), mockCallInfo(request(msgs, [])));
    expect(none.toolCalls ?? []).toEqual([]);
  });
});
