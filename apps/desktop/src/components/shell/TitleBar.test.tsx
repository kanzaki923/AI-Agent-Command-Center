import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { attention, card, homeSnapshot, homeTree } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { TitleBar } from './TitleBar';

function mount(snap = homeSnapshot()) {
  const fake = createFakeClient({
    'home.get': () => snap,
    'cost.summary': () => ({ totalUsd: 3.2, estimated: false, rows: [{ key: 'r', label: 'ローンチ準備', usd: 3.2, estimated: false }], daily: { limitUsd: 20, usedTodayUsd: 3.2 } }),
  });
  render(
    <RuntimeProvider runtime={createRuntime(fake.client)}>
      <TooltipProvider>
        <TitleBar />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return fake;
}

beforeEach(() => useUi.setState({ mode: 'session', focusSessionId: 'ses_x', back: [], forward: [], selectedId: null }));

describe('<TitleBar>', () => {
  it("shows today's spend against the daily limit and the attention count, without a project switcher", async () => {
    const root = card();
    const a = attention({ id: root.id });
    mount(
      homeSnapshot({
        attention: [a, attention({ id: root.id })],
        trees: [homeTree(root)],
        totals: { working: 1, needsYou: 2, failed: 0, spendTodayUsd: 3.2, dailyLimitUsd: 20, estimated: false },
      }),
    );
    const meter = await screen.findByRole('meter', { name: '予算' });
    expect(meter).toHaveTextContent('$3.20');
    expect(meter).toHaveTextContent('$20');
    const count = screen.getByRole('button', { name: '出番 2' });
    expect(screen.queryByText(/プロジェクト/)).toBeNull();
    fireEvent.click(count);
    expect(useUi.getState()).toMatchObject({ mode: 'home', selectedId: a.id });
  });

  it('hides the count at zero, and opens the cost popover from the meter', async () => {
    mount(homeSnapshot({ totals: { working: 0, needsYou: 0, failed: 0, spendTodayUsd: 3.2, dailyLimitUsd: 20, estimated: false } }));
    await screen.findByRole('meter');
    expect(screen.queryByRole('button', { name: /出番/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '今日の費用' }));
    expect(await screen.findByText('ローンチ準備')).toBeInTheDocument();
  });

  it('goes back and forward', async () => {
    mount();
    useUi.getState().openSession('ses_y');
    const back = await screen.findByRole('button', { name: '戻る' });
    fireEvent.click(back);
    expect(useUi.getState().focusSessionId).toBe('ses_x');
  });
});
