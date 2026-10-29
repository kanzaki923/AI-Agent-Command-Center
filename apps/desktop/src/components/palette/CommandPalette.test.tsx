import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { highlightTerms } from '../../lib/highlight';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { attention, card, homeSnapshot, homeTree, session } from '../../test/fixtures';
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
    useUi.setState({ paletteOpen: false, paletteQuery: '', palettePages: [], selectedId: null, focusSessionId: null, mode: 'home', jumpTo: null });
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

  it('finds a conversation by its title after the # prefix', async () => {
    const s = session({ kind: 'chat', title: '旅行の相談' });
    mount({ 'session.list': () => ({ items: [s], nextCursor: null }), 'session.search': () => ({ items: [] }) });
    act(() => useUi.getState().openPalette('#'));
    const input = await screen.findByRole('combobox');
    fireEvent.change(input, { target: { value: '#旅行' } });
    fireEvent.click(await screen.findByRole('option', { name: /旅行の相談/ }));
    expect(useUi.getState()).toMatchObject({ mode: 'session', focusSessionId: s.id });
  });

  it('keeps Tab inside the palette (it is a modal)', async () => {
    mount({ 'session.list': () => ({ items: [], nextCursor: null }) });
    act(() => useUi.getState().openPalette());
    const input = await screen.findByRole('combobox');
    input.focus();
    const tab = fireEvent.keyDown(input, { key: 'Tab' });
    const shiftTab = fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    // Default prevented: the browser does not move focus to the app behind the overlay.
    expect(tab).toBe(false);
    expect(shiftTab).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('says when nothing matches and still offers to ask the AI', async () => {
    mount({ 'session.list': () => ({ items: [], nextCursor: null }), 'session.search': () => ({ items: [] }) });
    act(() => useUi.getState().openPalette());
    const input = await screen.findByRole('combobox');
    fireEvent.change(input, { target: { value: 'zzzzqqqq' } });
    expect(await screen.findByTestId('palette-no-match', {}, { timeout: 2000 })).toHaveTextContent('「zzzzqqqq」に一致するものはありません');
    expect(screen.getByText(/AI に頼む/)).toBeInTheDocument();
  });

  it('reaches every action in the new words: next attention, stop, delegate, screens, theme', async () => {
    const s = session({ kind: 'chat', title: 'ローンチ準備', state: 'supervising' });
    const root = card({ id: s.id, title: s.title, role: 'supervisor', state: 'supervising' });
    const kid = card({ parentId: s.id, depth: 1, state: 'needs_you' });
    const ask = attention({ id: kid.id, rootSessionId: s.id });
    let stopped: unknown = null;
    mount({
      'session.list': () => ({ items: [s], nextCursor: null }),
      'home.get': () => homeSnapshot({ attention: [ask], trees: [homeTree(root, [kid])] }),
      'session.tree': () => ({ rootSessionId: s.id, nodes: [root, kid] }),
      'session.stop': (p) => {
        stopped = p;
        return { stoppedSessionIds: [s.id], cancelledRunIds: [] };
      },
    });
    useUi.setState({ mode: 'session', focusSessionId: s.id });
    act(() => useUi.getState().openPalette());
    expect(await screen.findByRole('option', { name: /次の出番へ/ })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: /任せるのをやめる/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /ホーム/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'タイムライン' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /ライトテーマ|ダークテーマ/ })).toBeInTheDocument();
    for (const word of ['Task', 'Orchestrator', 'Worker', '司令室', 'フォーカス']) {
      expect(screen.queryByText(new RegExp(word))).toBeNull();
    }
    fireEvent.click(screen.getByRole('option', { name: /^止める/ }));
    await waitFor(() => expect(stopped).toMatchObject({ sessionId: s.id }));
  });
});
