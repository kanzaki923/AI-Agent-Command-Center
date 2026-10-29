/** Unit tests of when schedules fire (spec 20261029 §3.11): cron, once, catch-up, labels. */
import type { Schedule } from '@acc/protocol';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../core/errors';
import {
  firingLabel,
  latestFireAtOrBefore,
  nextFireAfter,
  nextFires,
  nextRunAfter,
  normalizeTrigger,
  planDue,
} from './time';

const t = (iso: string) => Date.parse(iso);
const isoList = (ms: number[]) => ms.map((m) => new Date(m).toISOString());

describe('normalizeTrigger', () => {
  it('fills the default time zone and tidies the expression', () => {
    expect(normalizeTrigger({ kind: 'cron', expr: ' 0  9 * * 1-5 ' }, 'Asia/Tokyo')).toEqual({
      kind: 'cron',
      expr: '0 9 * * 1-5',
      tz: 'Asia/Tokyo',
    });
    expect(
      normalizeTrigger({ kind: 'cron', expr: '0 9 * * *', tz: 'Europe/Berlin' }, 'Asia/Tokyo'),
    ).toMatchObject({ tz: 'Europe/Berlin' });
    expect(normalizeTrigger({ kind: 'once', at: '2026-11-05T00:00:00Z' }, 'UTC')).toEqual({
      kind: 'once',
      at: '2026-11-05T00:00:00.000Z',
    });
  });

  it.each([
    ['0 9 * * * *', '5 つの欄'],
    ['0 9 * *', '5 つの欄'],
    ['61 9 * * *', 'cron の式が正しくありません'],
    ['0 9 * * mon-xyz', 'cron の式が正しくありません'],
  ])('rejects %s with a message a person can act on', (expr, message) => {
    let err: unknown;
    try {
      normalizeTrigger({ kind: 'cron', expr }, 'UTC');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 'invalid_params',
      message: expect.stringContaining(message),
    });
  });

  it('rejects an unknown time zone', () => {
    expect(() =>
      normalizeTrigger({ kind: 'cron', expr: '0 9 * * *', tz: 'Mars/Base' }, 'UTC'),
    ).toThrow(/タイムゾーン/);
  });
});

describe('next firings', () => {
  it('cron in a time zone: weekdays at 9:00 in Tokyo', () => {
    const trigger = normalizeTrigger(
      { kind: 'cron', expr: '0 9 * * 1-5', tz: 'Asia/Tokyo' },
      'UTC',
    );
    // 2026-10-30 is a Friday.
    expect(isoList(nextFires(trigger, t('2026-10-29T12:00:00Z'), 5))).toEqual([
      '2026-10-30T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
      '2026-11-03T00:00:00.000Z',
      '2026-11-04T00:00:00.000Z',
      '2026-11-05T00:00:00.000Z',
    ]);
  });

  it('keeps 9:00 local time across a DST change (New York, 2026-03-08)', () => {
    const trigger = normalizeTrigger(
      { kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' },
      'UTC',
    );
    expect(isoList(nextFires(trigger, t('2026-03-06T12:00:00Z'), 4))).toEqual([
      '2026-03-06T14:00:00.000Z', // EST
      '2026-03-07T14:00:00.000Z',
      '2026-03-08T13:00:00.000Z', // EDT
      '2026-03-09T13:00:00.000Z',
    ]);
  });

  it('a time skipped by DST still fires once that day', () => {
    const trigger = normalizeTrigger(
      { kind: 'cron', expr: '30 2 * * *', tz: 'America/New_York' },
      'UTC',
    );
    const times = nextFires(trigger, t('2026-03-07T12:00:00Z'), 2);
    expect(times).toHaveLength(2);
    expect(new Date(times[0]!).toISOString().slice(0, 10)).toBe('2026-03-08');
    expect(new Date(times[1]!).toISOString().slice(0, 10)).toBe('2026-03-09');
  });

  it('is strictly after the given time; once fires only when still ahead', () => {
    const hourly = normalizeTrigger({ kind: 'cron', expr: '0 * * * *', tz: 'UTC' }, 'UTC');
    expect(nextFireAfter(hourly, t('2026-01-01T10:00:00Z'))).toBe(t('2026-01-01T11:00:00Z'));
    const once = { kind: 'once' as const, at: '2026-01-01T10:00:00.000Z' };
    expect(nextFireAfter(once, t('2026-01-01T09:00:00Z'))).toBe(t('2026-01-01T10:00:00Z'));
    expect(nextFireAfter(once, t('2026-01-01T10:00:00Z'))).toBeNull();
    expect(nextFires(once, t('2026-01-01T09:00:00Z'), 5)).toEqual([t('2026-01-01T10:00:00Z')]);
  });

  it('latest firing at or before a time includes that exact time', () => {
    const hourly = normalizeTrigger({ kind: 'cron', expr: '0 * * * *', tz: 'UTC' }, 'UTC');
    expect(latestFireAtOrBefore(hourly, t('2026-01-01T10:00:00Z'))).toBe(t('2026-01-01T10:00:00Z'));
    expect(latestFireAtOrBefore(hourly, t('2026-01-01T10:59:00Z'))).toBe(t('2026-01-01T10:00:00Z'));
  });

  it('nothing after expiresAt', () => {
    const daily = normalizeTrigger({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' }, 'UTC');
    const s = { trigger: daily, expiresAt: '2026-01-02T12:00:00.000Z' };
    expect(nextRunAfter(s, t('2026-01-01T12:00:00Z'))).toBe(t('2026-01-02T09:00:00Z'));
    expect(nextRunAfter(s, t('2026-01-02T10:00:00Z'))).toBeNull();
  });
});

describe('planDue (catch-up)', () => {
  const hourly = { kind: 'cron' as const, expr: '0 * * * *', tz: 'UTC' };
  function schedule(over: Partial<Schedule>): Parameters<typeof planDue>[0] {
    return {
      trigger: hourly,
      expiresAt: null,
      nextRunAt: '2026-01-01T10:00:00.000Z',
      catchUp: 'latest',
      maxLatenessMin: 720,
      ...over,
    };
  }

  it('on time: fires the due one and moves on', () => {
    expect(planDue(schedule({}), t('2026-01-01T10:00:00.500Z'))).toEqual({
      fire: t('2026-01-01T10:00:00Z'),
      missed: null,
      nextRunAt: t('2026-01-01T11:00:00Z'),
    });
  });

  it('not due yet: nothing to do', () => {
    expect(planDue(schedule({}), t('2026-01-01T09:59:00Z'))).toMatchObject({
      fire: null,
      missed: null,
    });
  });

  it('latest: of many missed firings only the latest runs (within 12 hours)', () => {
    // Asleep from 10:00 to 15:20: 10, 11, 12, 13, 14, 15 were missed; only 15:00 runs.
    expect(planDue(schedule({}), t('2026-01-01T15:20:00Z'))).toEqual({
      fire: t('2026-01-01T15:00:00Z'),
      missed: null,
      nextRunAt: t('2026-01-01T16:00:00Z'),
    });
  });

  it('latest: a firing later than maxLatenessMin is missed', () => {
    const daily = { kind: 'cron' as const, expr: '0 9 * * *', tz: 'UTC' };
    const s = schedule({ trigger: daily, nextRunAt: '2026-01-01T09:00:00.000Z' });
    expect(planDue(s, t('2026-01-01T21:00:00Z')).fire).toBe(t('2026-01-01T09:00:00Z'));
    expect(planDue(s, t('2026-01-01T21:00:01Z'))).toEqual({
      fire: null,
      missed: t('2026-01-01T09:00:00Z'),
      nextRunAt: t('2026-01-02T09:00:00Z'),
    });
  });

  it('skip: runs only when less than 5 minutes late', () => {
    const s = schedule({ catchUp: 'skip' });
    expect(planDue(s, t('2026-01-01T10:04:59Z')).fire).toBe(t('2026-01-01T10:00:00Z'));
    expect(planDue(s, t('2026-01-01T10:05:00Z'))).toMatchObject({
      fire: null,
      missed: t('2026-01-01T10:00:00Z'),
    });
    // Many missed, the latest is recent: that one runs.
    expect(planDue(s, t('2026-01-01T15:02:00Z')).fire).toBe(t('2026-01-01T15:00:00Z'));
  });

  it('once: fires once, nothing after', () => {
    const s = schedule({
      trigger: { kind: 'once', at: '2026-01-01T10:00:00.000Z' },
    });
    expect(planDue(s, t('2026-01-01T10:30:00Z'))).toEqual({
      fire: t('2026-01-01T10:00:00Z'),
      missed: null,
      nextRunAt: null,
    });
  });

  it('expiry caps which firing counts as the latest', () => {
    const s = schedule({ expiresAt: '2026-01-01T12:30:00.000Z' });
    expect(planDue(s, t('2026-01-01T14:10:00Z'))).toEqual({
      fire: t('2026-01-01T12:00:00Z'),
      missed: null,
      nextRunAt: null,
    });
  });
});

describe('firingLabel', () => {
  it('month/day hour:minute in the zone', () => {
    expect(firingLabel(t('2026-11-05T00:00:00Z'), 'Asia/Tokyo')).toBe('11/5 9:00');
    expect(firingLabel(t('2026-11-05T13:05:00Z'), 'UTC')).toBe('11/5 13:05');
    expect(firingLabel(t('2026-11-05T00:00:00Z'), 'America/New_York')).toBe('11/4 19:00'); // EST
  });
});
