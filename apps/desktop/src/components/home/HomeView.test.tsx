import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { attention, card, homeSnapshot, homeTree, session } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { HomeView } from './HomeView';

function mount(handlers: Parameters<typeof createFakeClient>[0]) {
  const fake = createFakeClient(handlers);
  render(
    <RuntimeProvider runtime={createRuntime(fake.client)}>
      <TooltipProvider>
        <HomeView />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return fake;
}

beforeEach(() => useUi.setState({ mode: 'home', focusSessionId: null, selectedId: null }));

describe('<HomeView> (minimal, before U1)', () => {
  it('shows attention rows, then one lane per tree with its children as chips', async () => {
    const root = card({ title: 'ローンチ準備', role: 'supervisor', state: 'supervising' });
    const faq = card({ parentId: root.id, depth: 1, title: 'FAQ', state: 'needs_you' });
    const research = card({ parentId: root.id, depth: 1, title: '競合調査', state: 'working', now: 'pricing.md を参照' });
    const q = attention({ id: faq.id, rootSessionId: root.id }, { title: '価格を載せる？' });
    faq.attentionIds = [q.id];
    mount({ 'home.get': () => homeSnapshot({ attention: [q], trees: [homeTree(root, [research, faq])] }) });
    const rows = await screen.findByRole('region', { name: '出番' });
    expect(within(rows).getByText('価格を載せる？')).toBeInTheDocument();
    const lane = screen.getByRole('region', { name: 'ローンチ準備' });
    const chips = within(lane).getAllByRole('button').filter((b) => b.hasAttribute('data-session-chip'));
    // needs_you comes before working.
    expect(chips.map((c) => c.getAttribute('data-state'))).toEqual(['needs_you', 'working']);
    fireEvent.click(chips[1]!);
    expect(useUi.getState()).toMatchObject({ mode: 'session', focusSessionId: research.id });
  });

  it('is one input when there is nothing yet; Enter starts a conversation and stays home', async () => {
    const s = session({ kind: 'chat' });
    const fake = mount({
      'home.get': () => homeSnapshot(),
      'session.create': () => s,
      'session.messages': () => ({ items: [], hasMore: false, streaming: null }),
      'session.send': () => ({ messageId: 'msg_1', runId: null, delivery: 'started' }),
    });
    const input = await screen.findByRole('textbox', { name: '何を頼みますか' });
    fireEvent.change(input, { target: { value: '競合を調べて' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await vi.waitFor(() => expect(fake.calls.map((c) => c.method)).toContain('session.send'));
    expect(useUi.getState().mode).toBe('home');
  });
});
