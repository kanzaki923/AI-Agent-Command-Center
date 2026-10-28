// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { dayBucket, formatCost, formatDiffStat, formatElapsed, formatTimestamp, sumUsage } from './format';

describe('formatElapsed', () => {
  it('uses mm:ss under an hour and h:mm:ss above', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(12 * 60_000 + 4_000)).toBe('12:04');
    expect(formatElapsed(3_600_000 + 2 * 60_000 + 33_000)).toBe('1:02:33');
    expect(formatElapsed(-5)).toBe('00:00');
  });
});

describe('formatCost (reported / estimated / unknown, concept §5.1)', () => {
  it('shows reported cost plainly', () => {
    expect(formatCost(0.42, 'reported')).toMatchObject({ text: '$0.42', tooltip: null });
  });
  it('marks estimates with ≈ and explains them', () => {
    expect(formatCost(0.42, 'estimated')).toMatchObject({
      text: '≈$0.42',
      tooltip: 'トークン数からの推定値です',
    });
  });
  it('shows unknown cost as an em dash, never $0.00', () => {
    expect(formatCost(0, 'unknown')).toMatchObject({ text: '—', tooltip: 'コストを取得できない接続です' });
  });
  it('labels demo mode', () => {
    expect(formatCost(1.5, 'reported', { demo: true }).text).toBe('$0.00（デモ）');
  });
  it('uses one decimal from $10', () => {
    expect(formatCost(12.345, 'reported').text).toBe('$12.3');
  });
});

describe('sumUsage', () => {
  const u = (costUsd: number, costSource: 'reported' | 'estimated' | 'unknown') => ({
    inputTokens: 0,
    outputTokens: 0,
    costUsd,
    costSource,
  });
  it('is unknown only when nothing was measured', () => {
    expect(sumUsage([u(0, 'unknown'), u(0, 'unknown')])).toEqual({ costUsd: 0, costSource: 'unknown' });
    expect(sumUsage([])).toEqual({ costUsd: 0, costSource: 'unknown' });
  });
  it('becomes an estimate when any part is estimated', () => {
    expect(sumUsage([u(0.1, 'reported'), u(0.2, 'estimated'), u(5, 'unknown')])).toEqual({
      costUsd: 0.30000000000000004,
      costSource: 'estimated',
    });
  });
  it('stays reported when all measured parts are reported', () => {
    expect(sumUsage([u(0.1, 'reported'), u(0, 'unknown')]).costSource).toBe('reported');
  });
});

describe('timestamps', () => {
  const now = new Date(2026, 9, 29, 15, 0, 0).getTime();
  it('shows today as HH:mm, yesterday with 昨日, older as M/D', () => {
    expect(formatTimestamp(new Date(2026, 9, 29, 14, 3).toISOString(), now)).toBe('14:03');
    expect(formatTimestamp(new Date(2026, 9, 28, 9, 5).toISOString(), now)).toBe('昨日 09:05');
    expect(formatTimestamp(new Date(2026, 9, 20, 9, 5).toISOString(), now)).toBe('10/20');
  });
  it('can be relative within the hour', () => {
    expect(formatTimestamp(new Date(now - 3 * 60_000).toISOString(), now, true)).toBe('3 分前');
  });
  it('buckets days for the sidebar', () => {
    expect(dayBucket(new Date(2026, 9, 29, 1).toISOString(), now)).toBe('today');
    expect(dayBucket(new Date(2026, 9, 28, 23).toISOString(), now)).toBe('yesterday');
    expect(dayBucket(new Date(2026, 9, 25).toISOString(), now)).toBe('week');
    expect(dayBucket(new Date(2026, 8, 1).toISOString(), now)).toBe('older');
  });
});

it('formats diff stats with a real minus sign', () => {
  expect(formatDiffStat(58, 12)).toBe('+58 −12');
});
