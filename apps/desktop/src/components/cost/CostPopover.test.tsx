import type { CostSummary } from '@acc/protocol';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { card, homeSnapshot, homeTree } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { CostPopover, spendRows } from './CostPopover';

const lead = card({ id: 'ses_00000000000000000000000101', role: 'supervisor', title: '新製品ローンチ準備' });
const chat = card({ id: 'ses_00000000000000000000000102', role: 'chat', title: 'お詫びメール' });

const summary = (rows: CostSummary['rows']): CostSummary => ({
  totalUsd: rows.reduce((a, r) => a + r.usd, 0),
  estimated: false,
  rows,
  daily: { limitUsd: 20, usedTodayUsd: 3.86 },
});

function mount() {
  const fake = createFakeClient({
    'home.get': () =>
      homeSnapshot({
        totals: { working: 0, needsYou: 0, failed: 0, spendTodayUsd: 3.86, dailyLimitUsd: 20, estimated: false },
        trees: [homeTree(lead), homeTree(chat)],
      }),
    'cost.summary': (p) =>
      p.groupBy === 'model'
        ? summary([
            { key: 'claude-sonnet', label: 'claude-sonnet', usd: 3.5, estimated: false },
            { key: 'claude-haiku', label: 'claude-haiku', usd: 0.36, estimated: false },
          ])
        : summary([
            { key: chat.id, label: chat.title, usd: 0.4, estimated: false },
            { key: lead.id, label: lead.title, usd: 3.46, estimated: false },
            { key: 'ses_00000000000000000000000103', label: '何もしていない', usd: 0, estimated: false },
          ]),
    'settings.update': () => ({}),
  });
  render(
    <RuntimeProvider runtime={createRuntime(fake.client)}>
      <TooltipProvider>
        <CostPopover>
          <button type="button">今日の費用</button>
        </CostPopover>
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return fake;
}

beforeEach(() => {
  useUi.setState({ mode: 'home', focusSessionId: null });
});

describe('<CostPopover>', () => {
  it("shows today's total against the limit, bars per tree (biggest first) and per model", async () => {
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '今日の費用' }));
    });
    const pop = await screen.findByTestId('cost-popover');
    await waitFor(() => expect(within(pop).getByTestId('cost-today')).toHaveTextContent('$3.86'));
    await waitFor(() => expect(within(pop).getByLabelText('1 日の上限')).toHaveValue('20'));
    const trees = await within(pop).findByRole('list', { name: '会話ごと' });
    const rows = within(trees).getAllByRole('button');
    expect(rows.map((r) => r.textContent)).toEqual(['新製品ローンチ準備$3.46', 'お詫びメール$0.40']);
    // The role says what each tree is: the delegated one carries the diamond.
    expect(within(rows[0]!).getByRole('img', { name: '任せた会話' })).toBeInTheDocument();
    const models = await within(pop).findByRole('list', { name: 'モデルごと' });
    expect(models).toHaveTextContent('claude-sonnet$3.50');
    expect(models).toHaveTextContent('claude-haiku$0.36');
  });

  it('opens a tree from its bar', async () => {
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '今日の費用' }));
    });
    const trees = await screen.findByRole('list', { name: '会話ごと' });
    await act(async () => {
      fireEvent.click(within(trees).getAllByRole('button')[0]!);
    });
    expect(useUi.getState()).toMatchObject({ mode: 'session', focusSessionId: lead.id });
  });

  it('changes the daily limit in place', async () => {
    const fake = mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '今日の費用' }));
    });
    await waitFor(() => expect(screen.getByLabelText('1 日の上限')).toHaveValue('20'));
    const input = screen.getByLabelText('1 日の上限');
    fireEvent.change(input, { target: { value: '30' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(fake.calls.filter((c) => c.method === 'settings.update').map((c) => c.params)).toEqual([
      { limits: { dailyUsd: 30 } },
    ]);
  });
});

describe('spendRows', () => {
  it('drops what spent nothing, sorts by spend and keeps the top N', () => {
    const rows = spendRows(
      summary([
        { key: 'a', label: 'a', usd: 0.001, estimated: false },
        { key: 'b', label: 'b', usd: 1, estimated: false },
        { key: 'c', label: 'c', usd: 2, estimated: false },
        { key: 'd', label: 'd', usd: 0.5, estimated: false },
      ]),
      2,
    );
    expect(rows.map((r) => r.key)).toEqual(['c', 'b']);
    expect(spendRows(undefined)).toEqual([]);
  });
});
