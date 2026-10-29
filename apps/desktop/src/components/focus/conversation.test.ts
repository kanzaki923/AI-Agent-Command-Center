import type { WakeItemView } from '@acc/protocol';
import { describe, expect, it } from 'vitest';
import type { ChatBlock } from '../../model/chat';
import { stabilizeBlocks } from '../../model/chat';
import { approval, attention, iso, message, run, session, T0 } from '../../test/fixtures';
import {
  type ConversationBlock,
  buildBaseBlocks,
  describeControlCall,
  stripMachineBlocks,
  toConversationBlocks,
  toolMethod,
} from './conversation';

const s = session({ kind: 'agent' });
const base = { approvals: [], streaming: [], runs: [], attention: [] };

describe('stripMachineBlocks', () => {
  it('removes the mock runtime steps and keeps what a person wrote', () => {
    const text = '競合 3 社を調べてください。\n\n```acc-mock\n{\n  "steps": []\n}\n```\n\nよろしく';
    expect(stripMachineBlocks(text)).toBe('競合 3 社を調べてください。\n\nよろしく');
    // An unterminated block (cut off) is removed too.
    expect(stripMachineBlocks('依頼\n```acc-mock\n{ "steps": [')).toBe('依頼');
    expect(stripMachineBlocks('```ts\nconst a = 1;\n```')).toBe('```ts\nconst a = 1;\n```');
  });
});

describe('tool calls in the screen\'s words', () => {
  it('finds the method behind every spelling of a tool name', () => {
    expect(toolMethod('session.spawn')).toBe('session.spawn');
    expect(toolMethod('mcp__acc__session__spawn')).toBe('session.spawn');
    expect(toolMethod('mcp__acc__artifact_publish')).toBe('artifact.publish');
    expect(toolMethod('Bash')).toBeNull();
  });

  it('says what happened without Task / Run / Worker', () => {
    expect(describeControlCall('session.spawn', { title: '競合 3 社の調査' })).toBe('「競合 3 社の調査」に依頼');
    expect(describeControlCall('mcp__acc__human_ask', { question: '価格を載せる？' })).toBe('質問「価格を載せる？」');
    expect(describeControlCall('mcp__acc__artifact_publish', { title: 'プレスリリース' })).toBe('「プレスリリース」を提出');
    expect(describeControlCall('session.send', { sessionId: 'ses_1' }, () => 'FAQ')).toBe('「FAQ」に伝える');
    expect(describeControlCall('session.tree', {})).toBe('状況を確認');
    expect(describeControlCall('task.wait', {})).toBe('終わるのを待つ');
    expect(describeControlCall('Read', { file_path: 'a.md' })).toBeNull();
  });
});

describe('conversation blocks', () => {
  it('turns the first message of a child into the request card', () => {
    const brief = { goal: '調べて', doneWhen: ['表にする'], fromSessionId: null, reviewBy: 'none' as const, givenAt: iso(T0) };
    const m = message(s, { meta: { kind: 'brief', brief }, content: [{ type: 'text', text: '調べて\n\n## 完了条件\n- 表にする' }] });
    const blocks = toConversationBlocks(buildBaseBlocks({ ...base, messages: [m] }), new WeakMap());
    expect(blocks).toEqual([expect.objectContaining({ kind: 'brief', brief })]);
  });

  it('keeps a wake-up (a system message) in order as the status card', () => {
    const items: WakeItemView[] = [{ sessionId: 'ses_a', title: 'FAQ', change: 'needs_you', artifactIds: [] }];
    const first = message(s, { createdAt: iso(T0) });
    const wake = message(s, { role: 'system', meta: { kind: 'wake', items }, createdAt: iso(T0 + 1000) });
    const answer = message(s, { role: 'assistant', content: [{ type: 'text', text: 'はい' }], createdAt: iso(T0 + 2000) });
    const other = message(s, { role: 'system', content: [{ type: 'text', text: 'internal' }], createdAt: iso(T0 + 1500) });
    const blocks = toConversationBlocks(buildBaseBlocks({ ...base, messages: [first, wake, other, answer] }), new WeakMap());
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'wake', 'assistant']);
  });

  it('shows a pending approval only where it has no attention row', () => {
    const r = run(s);
    const covered = approval(r);
    const bare = approval(r);
    const answered = approval(r, { status: 'approved', resolvedAt: iso(T0 + 5000) });
    const att = attention(s, { kind: 'approval', refs: { approvalId: covered.id } });
    const blocks = buildBaseBlocks({ ...base, messages: [], approvals: [covered, bare, answered], attention: [att] });
    const ids = blocks.flatMap((b) => (b.kind === 'approval' ? [b.approval.id] : []));
    expect(ids).toEqual([bare.id, answered.id]);
  });

  it('rephrases control calls and keeps the mapped row while its block is unchanged', () => {
    const m = message(s, {
      role: 'assistant',
      content: [{ type: 'tool_call', toolCallId: 't1', name: 'mcp__acc__session__spawn', input: { title: 'FAQ' } }],
    });
    const prev = new Map<string, ChatBlock>();
    const cache = new WeakMap<ChatBlock, ConversationBlock>();
    const first = toConversationBlocks(stabilizeBlocks(prev, buildBaseBlocks({ ...base, messages: [m] })), cache);
    const tools = first[0]!;
    expect(tools.kind === 'tools' && tools.calls[0]!.desc.label).toBe('「FAQ」に依頼');
    const again = toConversationBlocks(stabilizeBlocks(prev, buildBaseBlocks({ ...base, messages: [m] })), cache);
    expect(again[0]).toBe(tools);
  });
});
