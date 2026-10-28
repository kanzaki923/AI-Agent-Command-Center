import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { highlightTerms } from '../../lib/highlight';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { approval, integration, run, session } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { CommandPalette, messageQuery } from './CommandPalette';

function mount(handlers: Parameters<typeof createFakeClient>[0]) {
  const fake = createFakeClient(handlers);
  const rt = createRuntime(fake.client);
  render(
    <RuntimeProvider runtime={rt}>
      <TooltipProvider>
        <CommandPalette />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return { fake, rt };
}

describe('palette helpers', () => {
  it('marks every searched word in a snippet', () => {
    expect(highlightTerms('…山の景色がきれいでした…', '景色')).toEqual(['…山の', { mark: '景色' }, 'がきれいでした…']);
    expect(highlightTerms('Pnpm test と pnpm build', 'pnpm')).toEqual([{ mark: 'Pnpm' }, ' test と ', { mark: 'pnpm' }, ' build']);
    expect(highlightTerms('abc', '')).toEqual(['abc']);
  });

  it('searches messages for plain and # queries, not for commands or help', () => {
    expect(messageQuery('#景色')).toBe('景色');
    expect(messageQuery('景色 山')).toBe('景色 山');
    expect(messageQuery('>テーマ')).toBe('');
    expect(messageQuery('?')).toBe('');
  });
});

describe('<CommandPalette>', () => {
  beforeEach(() => {
    useUi.setState({ paletteOpen: false, paletteQuery: '', palettePages: [], selectedId: null, focusSessionId: null, mode: 'command', jumpTo: null });
  });

  it('finds messages with session.search, highlights the words and jumps to the message', async () => {
    const s = session({ kind: 'chat', title: '旅行の相談' });
    const hit = {
      sessionId: s.id,
      sessionTitle: '旅行の相談',
      messageId: 'msg_00000000000000000000000042',
      snippet: '…山の景色がきれいでした…',
      createdAt: '2026-10-29T05:00:00.000Z',
    };
    let searched: unknown = null;
    mount({
      'session.list': () => ({ items: [s], nextCursor: null }),
      'session.search': (p) => {
        searched = p;
        return { items: [hit] };
      },
    });
    act(() => useUi.getState().openPalette('#'));
    const input = await screen.findByRole('combobox');
    fireEvent.change(input, { target: { value: '#景色' } });
    const row = await screen.findByTestId('message-hit', {}, { timeout: 2000 });
    expect(searched).toMatchObject({ query: '景色' });
    expect(within(row).getByText('景色').tagName).toBe('MARK');
    expect(row).toHaveTextContent('旅行の相談');
    fireEvent.click(row);
    expect(useUi.getState().focusSessionId).toBe(s.id);
    expect(useUi.getState().jumpTo).toMatchObject({ sessionId: s.id, messageId: hit.messageId });
    expect(useUi.getState().paletteOpen).toBe(false);
  });

  it('says when nothing matches and still offers to ask the AI', async () => {
    mount({ 'session.list': () => ({ items: [], nextCursor: null }), 'session.search': () => ({ items: [] }) });
    act(() => useUi.getState().openPalette());
    const input = await screen.findByRole('combobox');
    fireEvent.change(input, { target: { value: 'zzzzqqqq' } });
    expect(await screen.findByTestId('palette-no-match', {}, { timeout: 2000 })).toHaveTextContent('「zzzzqqqq」に一致するものはありません');
    expect(screen.getByText(/AI に頼む/)).toBeInTheDocument();
  });

  it('reaches every action: approve next, open integration, task board, theme toggle', async () => {
    const s = session({ title: 'API のリファクタリング' });
    const r = run(s, { status: 'awaiting_approval' });
    s.activeRunId = r.id;
    const a = approval(r, { payload: { toolName: 'Bash', input: { command: 'pnpm test' } } });
    const i = integration({ status: 'awaiting_approval', title: '統合: 2 Task → main' });
    let responded: unknown = null;
    mount({
      'session.list': () => ({ items: [s], nextCursor: null }),
      'run.list': () => ({ items: [r], nextCursor: null }),
      'approval.list': (p) => ({ items: (p.status as string[]).includes('pending') ? [a] : [], nextCursor: null }),
      'integration.list': () => ({ items: [i], nextCursor: null }),
      'approval.respond': (p) => {
        responded = p;
        return { ...a, status: 'approved' };
      },
    });
    act(() => useUi.getState().openPalette());
    const approveNext = await screen.findByRole('option', { name: /承認: API のリファクタリング/ });
    expect(approveNext).toHaveTextContent('$ pnpm test');
    expect(screen.getByRole('option', { name: /統合をレビュー: 2 Task → main/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Task ボードを開く/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /ライトテーマに切り替え|ダークテーマに切り替え/ })).toBeInTheDocument();
    fireEvent.click(approveNext);
    await waitFor(() => expect(responded).toMatchObject({ approvalId: a.id, decision: 'approve' }));
  });
});
