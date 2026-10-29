import type { Schedule, ScheduleTriggerInput, Session } from '@acc/protocol';

/** Presets of 繰り返す (spec §7). Times are in the daemon's time zone setting. */
export const REPEAT_PRESETS: { id: string; label: string; trigger: ScheduleTriggerInput & { kind: 'cron' } }[] = [
  { id: 'daily', label: '毎朝 9:00', trigger: { kind: 'cron', expr: '0 9 * * *' } },
  { id: 'weekdays', label: '平日 9:00', trigger: { kind: 'cron', expr: '0 9 * * 1-5' } },
  { id: 'monday', label: '毎週月曜 9:00', trigger: { kind: 'cron', expr: '0 9 * * 1' } },
  { id: 'hourly', label: '毎時', trigger: { kind: 'cron', expr: '0 * * * *' } },
];

/** The id of the hand-written choice (自分で書く). */
export const CUSTOM = 'custom';

/** Default budget of one firing (protocol DEFAULT_SCHEDULE_RUN). */
export const DEFAULT_FIRING_BUDGET = 1;

const normalize = (expr: string) => expr.trim().replace(/\s+/g, ' ');

/** Which choice a schedule's trigger is: a preset id, or `custom`. */
export function presetOf(trigger: Schedule['trigger'] | null | undefined): string {
  if (!trigger || trigger.kind !== 'cron') return CUSTOM;
  const expr = normalize(trigger.expr);
  return REPEAT_PRESETS.find((p) => p.trigger.expr === expr)?.id ?? CUSTOM;
}

/** A five-field cron expression, or null (the daemon still checks it; this only gates preview). */
export function cronTrigger(expr: string): (ScheduleTriggerInput & { kind: 'cron' }) | null {
  const e = normalize(expr);
  return e.split(' ').length === 5 ? { kind: 'cron', expr: e } : null;
}

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'];

function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A firing time: `今日 9:00`, `明日 9:00`, otherwise `11/3 (月) 9:00`. */
export function formatFireTime(iso: string, now: number): string {
  const d = new Date(iso);
  const clock = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  const days = Math.round((dayStart(d.getTime()) - dayStart(now)) / 86_400_000);
  if (days === 0) return `今日 ${clock}`;
  if (days === 1) return `明日 ${clock}`;
  return `${d.getMonth() + 1}/${d.getDate()} (${WEEKDAY[d.getDay()]}) ${clock}`;
}

/** What each firing asks: the conversation's request (its brief) or, without one, its title. */
export function repeatPrompt(session: Pick<Session, 'title' | 'brief'> | null | undefined): string {
  return (session?.brief?.goal ?? session?.title ?? '').trim();
}

/** Name of the schedule (the firings are titled "<name> · 11/5 9:00"): the conversation's title. */
export function repeatTitle(session: Pick<Session, 'title'> | null | undefined): string | undefined {
  const t = session?.title.trim();
  return t ? t.slice(0, 80) : undefined;
}
