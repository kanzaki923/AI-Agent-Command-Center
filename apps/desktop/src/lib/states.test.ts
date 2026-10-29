// @vitest-environment node
import { SessionState } from '@acc/protocol';
import { describe, expect, it } from 'vitest';
import {
  ATTENTION_META,
  OUTPUT_META,
  STATE_META,
  STATE_ORDER,
  budgetTone,
  formatNextRun,
  formatSince,
  formatUsd,
  isSettled,
  sessionTitle,
  sortByState,
  stateRank,
} from './states';

describe('states vocabulary (spec §1.1)', () => {
  it('has a colour token, an icon and a Japanese label for every state', () => {
    for (const s of SessionState.options) {
      expect(STATE_META[s].color).toMatch(/^var\(--st-/);
      expect(STATE_META[s].icon).toBeTruthy();
      expect(STATE_META[s].label).toMatch(/[ぁ-んァ-ヶ一-龠]/);
    }
    expect(STATE_META.needs_you.label).toBe('あなたの出番');
    expect(STATE_META.supervising.label).toBe('子の作業待ち');
  });

  it('orders needs_you > failed > working > supervising > queued > review > stopped > done > idle', () => {
    expect(STATE_ORDER).toEqual(['needs_you', 'failed', 'working', 'supervising', 'queued', 'review', 'stopped', 'done', 'idle']);
    expect(stateRank('needs_you')).toBeLessThan(stateRank('failed'));
  });

  it('sorts by state and keeps the given order inside a state', () => {
    const items = [
      { id: 'a', state: 'done' as const },
      { id: 'b', state: 'working' as const },
      { id: 'c', state: 'needs_you' as const },
      { id: 'd', state: 'working' as const },
    ];
    expect(sortByState(items, (i) => i.state).map((i) => i.id)).toEqual(['c', 'b', 'd', 'a']);
  });

  it('names attention kinds and output kinds in the UI words', () => {
    expect(ATTENTION_META.approval.label).toBe('確認');
    expect(ATTENTION_META.stuck.label).toBe('止まっている');
    expect(OUTPUT_META.code.label).toBe('変更');
    expect(OUTPUT_META.data.label).toBe('表');
  });

  it('knows which states are settled', () => {
    expect(['done', 'idle', 'stopped'].every((s) => isSettled(s as SessionState))).toBe(true);
    expect(isSettled('working')).toBe(false);
    expect(isSettled('needs_you')).toBe(false);
  });
});

describe('numbers (spec §1.3)', () => {
  it('formats spend: two decimals, <$0.01 below half a cent, nothing for zero', () => {
    expect(formatUsd(0.214)).toBe('$0.21');
    expect(formatUsd(3.2)).toBe('$3.20');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(0)).toBeNull();
    expect(formatUsd(null)).toBeNull();
  });

  it('turns the budget meter amber above 80% and red at the limit', () => {
    expect(budgetTone(1, 10)).toBe('ok');
    expect(budgetTone(8, 10)).toBe('ok');
    expect(budgetTone(8.1, 10)).toBe('warn');
    expect(budgetTone(10, 10)).toBe('over');
  });

  it('says how long a state has lasted, ongoing or finished', () => {
    const now = new Date(2026, 9, 30, 15, 0, 0).getTime();
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(formatSince(ago(30_000), now, false)).toBe('30秒');
    expect(formatSince(ago(4 * 60_000), now, false)).toBe('4分');
    expect(formatSince(ago(2 * 3600_000), now, false)).toBe('2時間');
    expect(formatSince(ago(10_000), now, true)).toBe('たった今');
    expect(formatSince(ago(12 * 60_000), now, true)).toBe('12分前');
    expect(formatSince(ago(3 * 3600_000), now, true)).toBe('3時間前');
    expect(formatSince(new Date(2026, 9, 29, 20, 0).toISOString(), now, true)).toBe('昨日');
    expect(formatSince(new Date(2026, 9, 20, 20, 0).toISOString(), now, true)).toBe('10/20');
  });

  it('shows the next run as a clock time, tomorrow, or a date', () => {
    const now = new Date(2026, 9, 30, 8, 0).getTime();
    expect(formatNextRun(new Date(2026, 9, 30, 9, 0).toISOString(), now)).toBe('9:00');
    expect(formatNextRun(new Date(2026, 9, 31, 9, 5).toISOString(), now)).toBe('明日 9:05');
    expect(formatNextRun(new Date(2026, 10, 3, 9, 0).toISOString(), now)).toBe('11/3 9:00');
  });

  it('names an untitled conversation by what it is', () => {
    expect(sessionTitle({ title: '  ', kind: 'chat' })).toBe('新しい会話');
    expect(sessionTitle({ title: '', kind: 'agent' })).toBe('無題のエージェント');
    expect(sessionTitle({ title: 'FAQ' })).toBe('FAQ');
  });
});
