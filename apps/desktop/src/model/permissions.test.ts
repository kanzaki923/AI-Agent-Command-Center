import type { Event } from '@acc/protocol';
import { describe, expect, it } from 'vitest';
import { approval, event, id, run, session } from '../test/fixtures';
import { describeApproval } from './approval';
import { buildChatBlocks, isBlocked } from './chat';
import {
  type ToolDecided,
  canRemember,
  decisionSummaryText,
  decisionsByToolCall,
  deciderTooltip,
  describeDecision,
  effectiveProfile,
  firstSentence,
  gateText,
  recentBlocks,
  rememberHint,
  rememberOptions,
  summarizeDecisions,
} from './permissions';
import { buildTimelineRows, describeEvent, EMPTY_FILTERS } from './timeline';

function decided(over: Partial<ToolDecided> = {}): ToolDecided {
  return {
    runId: 'run_1',
    toolCallId: 'tc_1',
    toolName: 'Bash',
    summary: 'git push origin HEAD',
    decision: 'denied',
    decidedBy: 'rule',
    rule: 'publish_remote',
    category: 'command_other',
    reason: 'リモートへの push はできません。反映は統合と人間の承認で行います（git push origin HEAD）\nYou cannot push.',
    profile: 'autonomous',
    notable: true,
    ...over,
  };
}

describe('profiles', () => {
  it('follows the project, then the global default, then おまかせ', () => {
    expect(effectiveProfile({ permissionProfile: 'careful' }, { defaultPermissionProfile: 'standard' })).toBe('careful');
    expect(effectiveProfile({ permissionProfile: null }, { defaultPermissionProfile: 'standard' })).toBe('standard');
    expect(effectiveProfile(null, null)).toBe('autonomous');
  });
});

describe('decisions', () => {
  it('reads the first Japanese sentence of a reason', () => {
    expect(firstSentence(decided().reason)).toBe('リモートへの push はできません');
    expect(firstSentence('[AI Agent Command Center] .git は変更できません。ファイルだけを…')).toBe('.git は変更できません');
    expect(firstSentence(null)).toBeNull();
  });

  it('names who decided and how, without alarm words', () => {
    expect(describeDecision(decided())).toMatchObject({ tone: 'blocked', label: 'ブロック', decider: 'rule' });
    expect(describeDecision(decided({ decision: 'allowed', decidedBy: 'classifier' }))).toMatchObject({
      tone: 'allowed',
      label: '自動で許可',
    });
    expect(describeDecision(decided({ decision: 'allowed', decidedBy: 'remembered' })).label).toBe('記憶した許可');
    expect(describeDecision(decided({ decision: 'asked' })).label).toBe('あなたに確認');
  });

  it('says where auto mode judged when the daemon could tell', () => {
    expect(deciderTooltip({ decidedBy: 'classifier', judge: 'server' })).toBe(
      'Claude Code の Auto mode（安全性の分類器）が決めました（Anthropic のサーバーで判定）',
    );
    expect(describeDecision(decided({ decidedBy: 'classifier', judge: 'client' })).deciderTooltip).toContain('手元の分類器で判定');
    expect(deciderTooltip({ decidedBy: 'classifier' })).toBe('Claude Code の Auto mode（安全性の分類器）が決めました');
    expect(deciderTooltip({ decidedBy: 'rule', judge: 'server' })).toBe('Core Daemon のルールで決めました');
    expect(gateText({ profile: 'autonomous', gate: 'classifier', note: null, judge: 'server' })).toBe('おまかせ · Auto mode が判断（サーバー判定）');
    expect(gateText({ profile: 'standard', gate: 'classifier', note: null, judge: 'client' })).toBe('標準 · Auto mode が判断（手元の分類器）');
    expect(gateText({ profile: 'standard', gate: 'classifier', note: null })).toBe('標準 · Auto mode が判断');
    expect(gateText({ profile: 'careful', gate: 'rules', note: null })).toBe('慎重 · ルールで判断');
  });

  it('summarizes a run as automatic decisions, blocks and (only when any) asks', () => {
    const s = summarizeDecisions({ allowed: 11, denied: 1, asked: 0 })!;
    expect(decisionSummaryText(s)).toBe('自動判断 12 件 · ブロック 1 件');
    expect(decisionSummaryText(summarizeDecisions({ allowed: 3, denied: 0, asked: 1 })!)).toBe('自動判断 3 件 · 確認 1 件');
    expect(summarizeDecisions(null)).toBeNull();
  });

  it('joins decisions to the chat tool calls by tool call id', () => {
    const s = session();
    const ev = (p: ToolDecided, sessionId = s.id) => event('tool.decided', p, { sessionId });
    const events: Event[] = [ev(decided({ toolCallId: 'a' })), ev(decided({ toolCallId: 'b', decision: 'allowed' })), ev(decided({ toolCallId: 'c' }), 'ses_other')];
    const map = decisionsByToolCall(events, s.id);
    expect([...map.keys()]).toEqual(['a', 'b']);

    const msg = {
      id: id('msg'),
      sessionId: s.id,
      runId: null,
      role: 'assistant' as const,
      content: [
        { type: 'tool_call' as const, toolCallId: 'a', name: 'Bash', input: { command: 'git push origin HEAD' } },
        { type: 'tool_call' as const, toolCallId: 'b', name: 'Bash', input: { command: 'pnpm test' } },
      ],
      author: { kind: 'agent' as const, sessionId: s.id, runId: 'run_1' },
      model: null,
      createdAt: new Date().toISOString(),
      delivery: 'delivered' as const,
      meta: null,
      usage: null,
    };
    const blocks = buildChatBlocks({ messages: [msg], approvals: [], streaming: [], runs: [], decisions: map });
    const calls = blocks[0]!.kind === 'tools' ? blocks[0]!.calls : [];
    expect(calls.map(isBlocked)).toEqual([true, false]);
    expect(calls[1]!.decision?.decision).toBe('allowed');
  });

  it('lists the latest blocks of a run, newest first', () => {
    const events = [
      event('tool.decided', decided({ summary: 'one' })),
      event('tool.decided', decided({ summary: 'ok', decision: 'allowed' })),
      event('tool.decided', decided({ summary: 'two' })),
      event('tool.decided', decided({ summary: 'other', runId: 'run_2' })),
    ];
    expect(recentBlocks(events, 'run_1').map((d) => d.summary)).toEqual(['two', 'one']);
  });
});

describe('Timeline rows for tool decisions', () => {
  it('shows blocks with a decider badge and the reason; routine allows only on request', () => {
    const block = event('tool.decided', decided());
    const routine = event('tool.decided', decided({ decision: 'allowed', notable: false, summary: 'pnpm test' }));
    const notable = event('tool.decided', decided({ decision: 'allowed', notable: true, summary: 'pnpm add zod', decidedBy: 'classifier' }));
    const v = describeEvent(block);
    expect(v).toMatchObject({ group: 'grant', label: 'ブロック', blocked: true, detail: 'リモートへの push はできません' });
    expect(v.decider?.badge).toBe('ルール');
    expect(describeEvent(notable).decider?.badge).toBe('Auto mode');

    const rows = (showAutoAllowed: boolean) =>
      buildTimelineRows({
        events: [block, routine, notable],
        filters: EMPTY_FILTERS,
        groupByRun: false,
        runs: new Map(),
        toggled: {},
        showAutoAllowed,
      }).map((r) => (r.kind === 'event' ? r.view.summary : r.kind));
    expect(rows(false)).toEqual(['git push origin HEAD', 'pnpm add zod']);
    expect(rows(true)).toEqual(['git push origin HEAD', 'pnpm test', 'pnpm add zod']);
  });
});

describe('remembering an approval', () => {
  const s = session({ projectId: id('prj'), taskId: id('tsk') });
  const r = run(s, { status: 'awaiting_approval' });

  it('offers run / task / project for tool uses, task only when there is one', () => {
    const a = approval(r);
    expect(canRemember(a, describeApproval(a))).toBe(true);
    expect(rememberOptions(a).map((o) => [o.scope, o.available])).toEqual([
      ['run', true],
      ['task', true],
      ['project', true],
    ]);
    const noTask = approval(r, { taskId: null });
    expect(rememberOptions(noTask).find((o) => o.scope === 'task')).toMatchObject({ available: false });
  });

  it('never for high-risk uses or non-tool approvals', () => {
    const push = approval(r, { payload: { toolName: 'Bash', input: { command: 'git push' } } });
    expect(canRemember(push, describeApproval(push))).toBe(false);
    const verify = approval(r, { kind: 'integration', payload: { action: 'verify', command: 'pnpm test' } });
    expect(canRemember(verify, describeApproval(verify))).toBe(false);
  });

  it('shows what would be remembered, and offers nothing the daemon cannot remember', () => {
    const a = approval(r, {
      payload: { toolName: 'Bash', input: { command: 'node scripts/test.js' }, rememberAs: 'コマンド「node scripts/test.js」を許可' },
    });
    const view = describeApproval(a);
    expect(canRemember(a, view)).toBe(true);
    expect(rememberHint(view)).toMatch(/^覚える内容：コマンド「node scripts\/test\.js」を許可。/);
    const inline = approval(r, { payload: { toolName: 'Bash', input: { command: 'node -e "x()"' }, rememberAs: null } });
    expect(canRemember(inline, describeApproval(inline))).toBe(false);
  });

  it('says why the daemon asked', () => {
    const a = approval(r, {
      payload: { toolName: 'Bash', input: { command: 'pnpm add zod' }, reason: '新しい依存の追加はこのプロジェクトでは確認が必要（zod）' },
    });
    expect(describeApproval(a).why).toBe('新しい依存の追加はこのプロジェクトでは確認が必要（zod）');
    const verify = approval(r, { kind: 'integration', payload: { action: 'verify', command: 'pnpm test' } });
    expect(describeApproval(verify).why).toMatch(/慎重プロファイル/);
  });
});
