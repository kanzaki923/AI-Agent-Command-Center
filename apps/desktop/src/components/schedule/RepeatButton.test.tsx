import type { Schedule, Session } from '@acc/protocol';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { createFakeClient } from '../../test/fakeClient';
import { T0, iso, session } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { RepeatButton } from './RepeatButton';
import { CUSTOM, cronTrigger, formatFireTime, presetOf, repeatPrompt, repeatTitle } from './repeat';

const NEXT = ['2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z', '2026-11-04T00:00:00.000Z'];

function schedule(s: Session, over: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch_00000000000000000000000001',
    sessionId: s.id,
    title: s.title,
    prompt: '今週のまとめ',
    trigger: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'Asia/Tokyo' },
    run: { mode: 'agent', workspace: { kind: 'none' }, model: null, budgetUsd: 1, supervise: false, includePrevious: true },
    catchUp: 'latest',
    maxLatenessMin: 720,
    enabled: true,
    nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
    lastRun: null,
    expiresAt: null,
    createdBy: { kind: 'human', client: 'desktop' },
    createdAt: iso(T0),
    updatedAt: iso(T0),
    ...over,
  };
}

function mount(s: Session, schedules: Schedule[] = [], opts: { previewFails?: boolean } = {}) {
  const fake = createFakeClient({
    'session.list': () => ({ items: [s], nextCursor: null }),
    'schedule.list': () => ({ items: schedules }),
    'schedule.preview': () => {
      if (opts.previewFails) throw new Error('invalid cron');
      return { times: NEXT };
    },
    'schedule.create': (p) => schedule(s, { prompt: p.prompt as string }),
    'schedule.update': () => schedules[0],
    'schedule.delete': () => ({ ok: true }),
  });
  render(
    <RuntimeProvider runtime={createRuntime(fake.client)}>
      <TooltipProvider>
        <RepeatButton sessionId={s.id} />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  const calls = (m: string) => fake.calls.filter((c) => c.method === m).map((c) => c.params);
  return { calls };
}

const openPopover = async () => {
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: '繰り返す' }));
  });
  return screen.findByTestId('repeat-popover');
};

describe('<RepeatButton>', () => {
  it('picks a preset, shows the next 3 times and repeats with the budget of one firing', async () => {
    const s = session({ kind: 'chat', title: '朝のまとめ', brief: { goal: '昨日のニュースを 5 行にまとめて', doneWhen: [], fromSessionId: null, reviewBy: 'none', givenAt: iso(T0) } });
    const { calls } = mount(s);
    const pop = await openPopover();
    expect(within(pop).getByRole('radio', { name: '毎朝 9:00' })).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(within(pop).getByTestId('repeat-preview').children).toHaveLength(3));
    fireEvent.click(within(pop).getByRole('radio', { name: '平日 9:00' }));
    await waitFor(() =>
      expect(calls('schedule.preview')).toContainEqual({ trigger: { kind: 'cron', expr: '0 9 * * 1-5' }, count: 3 }),
    );
    const budget = within(pop).getByLabelText('1 回の予算');
    fireEvent.change(budget, { target: { value: '2.5' } });
    fireEvent.blur(budget);
    await act(async () => {
      fireEvent.click(within(pop).getByRole('button', { name: '繰り返す' }));
    });
    expect(calls('schedule.create')).toEqual([
      {
        sessionId: s.id,
        prompt: '昨日のニュースを 5 行にまとめて',
        trigger: { kind: 'cron', expr: '0 9 * * 1-5' },
        title: '朝のまとめ',
        run: { budgetUsd: 2.5 },
      },
    ]);
    await waitFor(() => expect(screen.queryByTestId('repeat-popover')).toBeNull());
  });

  it('shows the next time on the clock and changes or stops an existing schedule at once', async () => {
    const s = session({ kind: 'chat', title: '週次レポート' });
    const existing = schedule(s);
    const { calls } = mount(s, [existing]);
    await waitFor(() => expect(screen.getByRole('button', { name: '繰り返す' })).toHaveTextContent(/\d+:\d\d/));
    const pop = await openPopover();
    expect(within(pop).getByRole('radio', { name: '平日 9:00' })).toHaveAttribute('aria-checked', 'true');
    await act(async () => {
      fireEvent.click(within(pop).getByRole('radio', { name: '毎時' }));
    });
    expect(calls('schedule.update')).toEqual([{ scheduleId: existing.id, trigger: { kind: 'cron', expr: '0 * * * *' } }]);
    await act(async () => {
      fireEvent.click(within(pop).getByRole('button', { name: '繰り返しをやめる' }));
    });
    expect(calls('schedule.delete')).toEqual([{ scheduleId: existing.id }]);
  });

  it('takes a hand-written cron expression and marks one the daemon rejects', async () => {
    const s = session({ kind: 'chat', title: 'x' });
    const { calls } = mount(s, [], { previewFails: true });
    const pop = await openPopover();
    fireEvent.click(within(pop).getByRole('radio', { name: '自分で書く' }));
    const input = within(pop).getByLabelText('cron');
    fireEvent.change(input, { target: { value: '0 7 * * 6' } });
    await waitFor(() => expect(input).toHaveAttribute('aria-invalid', 'true'));
    expect(within(pop).getByRole('button', { name: '繰り返す' })).toBeDisabled();
    expect(calls('schedule.create')).toEqual([]);
  });
});

describe('repeat helpers', () => {
  it('recognises the presets and checks a cron expression has five fields', () => {
    expect(presetOf({ kind: 'cron', expr: '0  9 * * 1', tz: 'UTC' })).toBe('monday');
    expect(presetOf({ kind: 'cron', expr: '30 7 * * *', tz: 'UTC' })).toBe(CUSTOM);
    expect(presetOf(null)).toBe(CUSTOM);
    expect(cronTrigger(' 0 9  * * * ')).toEqual({ kind: 'cron', expr: '0 9 * * *' });
    expect(cronTrigger('0 9 * *')).toBeNull();
  });

  it('formats firing times as 今日 / 明日 / date with weekday', () => {
    const now = new Date(2026, 9, 30, 8, 0).getTime();
    expect(formatFireTime(new Date(2026, 9, 30, 9, 0).toISOString(), now)).toBe('今日 9:00');
    expect(formatFireTime(new Date(2026, 9, 31, 9, 0).toISOString(), now)).toBe('明日 9:00');
    expect(formatFireTime(new Date(2026, 10, 2, 9, 5).toISOString(), now)).toBe('11/2 (月) 9:05');
  });

  it('repeats the brief (or the title) under the conversation title', () => {
    expect(repeatPrompt({ title: 'A', brief: null })).toBe('A');
    expect(repeatPrompt({ title: 'A', brief: { goal: ' B ', doneWhen: [] } as unknown as Session['brief'] })).toBe('B');
    expect(repeatTitle({ title: '  ' })).toBeUndefined();
    expect(repeatTitle({ title: 'x'.repeat(100) })).toHaveLength(80);
  });
});
