import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { describeTool } from '../../lib/tools';
import type { ToolCallView } from '../../model/chat';
import type { ToolDecided } from '../../model/permissions';
import { TooltipProvider } from '../ui/Tooltip';
import { ToolGroup, inputText, outputOf, summarizeCalls } from './ToolBlocks';

const decided = (over: Partial<ToolDecided>): ToolDecided => ({
  runId: 'run_1',
  toolCallId: 'a',
  toolName: 'Bash',
  summary: 'git push origin HEAD',
  decision: 'denied',
  decidedBy: 'rule',
  rule: 'publish_remote',
  category: 'command_other',
  reason: 'リモートへの push はできません。反映は統合と人間の承認で行います',
  profile: 'autonomous',
  notable: true,
  ...over,
});

const call = (id: string, command: string, over: Partial<ToolCallView>): ToolCallView => ({
  id,
  name: 'Bash',
  input: { command },
  output: '',
  done: true,
  isError: false,
  desc: describeTool('Bash', { command }),
  at: '2026-10-29T05:00:00.000Z',
  endedAt: '2026-10-29T05:00:01.000Z',
  decision: null,
  ...over,
});

describe('<ToolGroup> decisions', () => {
  it('shows a block as a neutral chip with the reason, and allows as a quiet note', () => {
    const calls = [
      call('a', 'git push origin HEAD', {
        isError: true,
        output: '[AI Agent Command Center] リモートへの push はできません。',
        decision: decided({}),
      }),
      call('b', 'pnpm test', { decision: decided({ toolCallId: 'b', decision: 'allowed', summary: 'pnpm test', reason: null, notable: false }) }),
    ];
    render(
      <TooltipProvider>
        <ToolGroup calls={calls} />
      </TooltipProvider>,
    );
    // The group header counts blocks apart from failures (a block is not the agent failing).
    expect(screen.getByText('ブロック 1')).toBeInTheDocument();
    expect(screen.queryByText(/失敗/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /実行 2/ }));
    expect(screen.getByTestId('blocked-chip')).toHaveTextContent('ブロック');
    expect(screen.getByText('リモートへの push はできません')).toBeInTheDocument();
    // No decision text on the line itself: it is found by opening the call.
    expect(screen.queryByTestId('decision-note')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /pnpm test を実行/ }));
    expect(screen.getAllByText('判断').length).toBeGreaterThan(0);
    // Nothing in the block line uses the failure colour.
    const blocked = document.querySelector('[data-blocked]')!;
    expect(blocked.querySelector('.text-st-failed')).toBeNull();
  });
});

describe('tool call text', () => {
  it('shows inputs and structured outputs as lines, never as JSON', () => {
    expect(inputText({ command: 'pnpm test' })).toBe('$ pnpm test');
    const text = inputText({ title: '競合 3 社の調査', doneWhen: ['3 社の価格', '表にする'], budgetUsd: 1.5 });
    expect(text).toBe('title: 競合 3 社の調査\ndoneWhen:\n  - 3 社の価格\n  - 表にする\nbudgetUsd: 1.5');
    expect(text).not.toMatch(/[{}"]/);
    expect(outputOf('{"session":{"title":"FAQ"},"runId":null}')).toBe('session:\n  title: FAQ');
    expect(outputOf('plain text')).toBe('plain text');
  });

  it('counts spawned children as people asked', () => {
    const spawn = (id: string, title: string) =>
      call(id, '', {
        name: 'mcp__acc__session__spawn',
        input: { title },
        desc: describeTool('mcp__acc__session__spawn', { title }),
      });
    expect(summarizeCalls([spawn('a', 'A'), spawn('b', 'B'), call('c', 'ls', {})])).toBe('2 人に依頼 · 実行 1');
  });
});
