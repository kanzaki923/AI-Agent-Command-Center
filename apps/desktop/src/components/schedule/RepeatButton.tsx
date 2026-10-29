import type { ScheduleTriggerInput, Session } from '@acc/protocol';
import { Clock } from 'lucide-react';
import { qk } from '../../daemon/keys';
import { useRuntime } from '../../daemon/runtime';
import { createSchedule, deleteSchedule, useSchedules } from '../../daemon/schedule';
import { useSlowNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { formatNextRun } from '../../lib/states';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';

/** Presets of 繰り返す (spec §7). Times are in the daemon's time zone setting. */
export const REPEAT_PRESETS: { id: string; label: string; trigger: ScheduleTriggerInput }[] = [
  { id: 'daily', label: '毎朝 9:00', trigger: { kind: 'cron', expr: '0 9 * * *' } },
  { id: 'weekdays', label: '平日 9:00', trigger: { kind: 'cron', expr: '0 9 * * 1-5' } },
  { id: 'monday', label: '毎週月曜 9:00', trigger: { kind: 'cron', expr: '0 9 * * 1' } },
  { id: 'hourly', label: '毎時', trigger: { kind: 'cron', expr: '0 * * * *' } },
];

/**
 * 繰り返す (spec §7): repeat a conversation's request on a schedule. Owned by track U5 (the
 * popover with presets, the next 3 times and the budget per run); this entry point keeps its
 * props fixed: `sessionId`. Minimal behaviour: a menu of presets; with a schedule, the clock
 * shows the next time and the menu can stop it.
 */
export function RepeatButton({ sessionId, className }: { sessionId: string; className?: string }) {
  const rt = useRuntime();
  const now = useSlowNow();
  const schedule = (useSchedules(sessionId).data ?? []).find((s) => s.enabled) ?? null;
  const create = (trigger: ScheduleTriggerInput, label: string) => {
    const session = rt.queryClient.getQueryData<Session[]>(qk.sessions)?.find((s) => s.id === sessionId);
    const prompt = session?.brief?.goal ?? session?.title ?? '';
    if (!prompt.trim()) return;
    void createSchedule(rt, { sessionId, prompt, trigger, title: label });
  };
  return (
    <Menu>
      <Tooltip content={schedule ? null : '繰り返す'}>
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label="繰り返す"
            className={cn(
              'inline-flex h-7 shrink-0 items-center gap-1 rounded-sm px-1.5 text-meta hover:bg-hover hover:text-fg',
              schedule ? 'text-fg-2' : 'text-fg-3',
              className,
            )}
          >
            <Clock size={15} strokeWidth={1.75} />
            {schedule?.nextRunAt && <span className="tabular">{formatNextRun(schedule.nextRunAt, now)}</span>}
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="end">
        {REPEAT_PRESETS.map((p) => (
          <MenuItem key={p.id} onSelect={() => create(p.trigger, p.label)}>
            {p.label}
          </MenuItem>
        ))}
        {schedule && (
          <>
            <MenuSeparator />
            <MenuItem danger onSelect={() => void deleteSchedule(rt, schedule.id)}>
              繰り返しをやめる
            </MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}
