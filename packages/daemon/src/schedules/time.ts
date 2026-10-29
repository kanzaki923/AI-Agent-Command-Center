/**
 * When schedules fire (architecture.md §2.18): cron expressions with a time zone (croner),
 * one-off times, and the catch-up rule for firings that were missed while the daemon was not
 * running or the machine slept. Pure functions over epoch milliseconds.
 */
import type { Schedule, ScheduleTrigger, ScheduleTriggerInput } from '@acc/protocol';
import { Cron } from 'croner';
import { invalidParams } from '../core/errors';

/** A `skip` schedule does not run a firing that is this late or later. */
export const SKIP_LATENESS_MS = 5 * 60_000;

/** Whether `tz` is an IANA time zone this runtime knows. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function cronOf(expr: string, tz: string): Cron {
  return new Cron(expr, { timezone: tz, mode: '5-part', paused: true });
}

/**
 * Validate an API trigger and fill the default time zone. Throws invalid_params with a message
 * a person can act on (shown next to the input).
 */
export function normalizeTrigger(input: ScheduleTriggerInput, defaultTz: string): ScheduleTrigger {
  if (input.kind === 'once') return { kind: 'once', at: new Date(input.at).toISOString() };
  const tz = input.tz ?? defaultTz;
  if (!isValidTimeZone(tz)) throw invalidParams(`タイムゾーン「${tz}」は使えません`);
  const expr = input.expr.trim().split(/\s+/).join(' ');
  if (expr.split(' ').length !== 5) {
    throw invalidParams('cron は「分 時 日 月 曜日」の 5 つの欄で書いてください');
  }
  try {
    cronOf(expr, tz);
  } catch (err) {
    throw invalidParams(`cron の式が正しくありません: ${(err as Error).message}`);
  }
  return { kind: 'cron', expr, tz };
}

/** The first firing strictly after `afterMs`, or null when there is none. */
export function nextFireAfter(trigger: ScheduleTrigger, afterMs: number): number | null {
  if (trigger.kind === 'once') {
    const at = Date.parse(trigger.at);
    return at > afterMs ? at : null;
  }
  return cronOf(trigger.expr, trigger.tz).nextRun(new Date(afterMs))?.getTime() ?? null;
}

/** The next `count` firings strictly after `afterMs`. */
export function nextFires(trigger: ScheduleTrigger, afterMs: number, count: number): number[] {
  if (trigger.kind === 'once') {
    const at = nextFireAfter(trigger, afterMs);
    return at === null ? [] : [at];
  }
  return cronOf(trigger.expr, trigger.tz)
    .nextRuns(count, new Date(afterMs))
    .map((d) => d.getTime());
}

/** The latest firing at or before `atMs`, or null. */
export function latestFireAtOrBefore(trigger: ScheduleTrigger, atMs: number): number | null {
  if (trigger.kind === 'once') {
    const at = Date.parse(trigger.at);
    return at <= atMs ? at : null;
  }
  // previousRuns is exclusive of the reference; cron has minute precision, so +1s includes atMs.
  const [prev] = cronOf(trigger.expr, trigger.tz).previousRuns(1, new Date(atMs + 1000));
  const t = prev?.getTime() ?? null;
  return t !== null && t <= atMs ? t : null;
}

/**
 * The next firing after `afterMs` that is still before `expiresAt`, or null (the schedule has
 * nothing left to fire).
 */
export function nextRunAfter(
  s: Pick<Schedule, 'trigger' | 'expiresAt'>,
  afterMs: number,
): number | null {
  const next = nextFireAfter(s.trigger, afterMs);
  if (next === null) return null;
  if (s.expiresAt && next > Date.parse(s.expiresAt)) return null;
  return next;
}

/** What to do with a schedule whose `nextRunAt` has come (§3.11 取りこぼし). */
export interface DuePlan {
  /** The firing to run now, or null. */
  fire: number | null;
  /** The firing recorded as `missed` (too late to run), or null. */
  missed: number | null;
  /** The schedule's next run after this one (null: nothing left). */
  nextRunAt: number | null;
}

/**
 * Of every firing between `nextRunAt` and now, only the latest counts (past ones never run in a
 * batch). It runs when it is late by at most `maxLatenessMin` (`catchUp: latest`) or by less
 * than 5 minutes (`catchUp: skip`); otherwise it is recorded as missed.
 */
export function planDue(
  s: Pick<Schedule, 'trigger' | 'expiresAt' | 'nextRunAt' | 'catchUp' | 'maxLatenessMin'>,
  nowMs: number,
): DuePlan {
  const due = s.nextRunAt ? Date.parse(s.nextRunAt) : null;
  const nextRunAt = nextRunAfter(s, nowMs);
  if (due === null || due > nowMs) return { fire: null, missed: null, nextRunAt };
  const cap = s.expiresAt ? Math.min(nowMs, Date.parse(s.expiresAt)) : nowMs;
  // The latest firing not after now (and not after expiry); never earlier than the one due.
  const latest = Math.max(due, latestFireAtOrBefore(s.trigger, cap) ?? due);
  const lateness = nowMs - latest;
  const onTime =
    s.catchUp === 'latest' ? lateness <= s.maxLatenessMin * 60_000 : lateness < SKIP_LATENESS_MS;
  return onTime
    ? { fire: latest, missed: null, nextRunAt }
    : { fire: null, missed: latest, nextRunAt };
}

/** "11/5 9:00" in the given time zone (used in the title of a firing's child). */
export function firingLabel(atMs: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: isValidTimeZone(tz) ? tz : 'UTC',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(atMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('month')}/${get('day')} ${Number(get('hour'))}:${get('minute')}`;
}
