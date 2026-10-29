import type { ParamsInput, Schedule, ScheduleTriggerInput } from '@acc/protocol';
import { useQuery } from '@tanstack/react-query';
import { toastError } from '../store/toast';
import { qk } from './keys';
import { type AppRuntime, useRuntime } from './runtime';

/**
 * Schedules ("繰り返す", spec §7): the ones owned by a session (or all of them with null),
 * soonest first. schedule.* events refetch the lists (daemon/live.ts).
 */
export function useSchedules(sessionId: string | null) {
  const rt = useRuntime();
  return useQuery<Schedule[]>({
    queryKey: qk.schedules(sessionId ?? ''),
    queryFn: () =>
      rt
        .callOr('schedule.list', sessionId ? { sessionId } : {}, { items: [] })
        .then((r) => r.items),
  });
}

/** The next `count` times a trigger fires (cron check, shown under the presets). */
export function useSchedulePreview(trigger: ScheduleTriggerInput | null, count = 3) {
  const rt = useRuntime();
  return useQuery<string[]>({
    queryKey: qk.schedulePreview({ trigger, count }),
    queryFn: () => rt.client.call('schedule.preview', { trigger: trigger!, count }).then((r) => r.times),
    enabled: !!trigger,
    staleTime: 60_000,
    retry: false,
  });
}

const refresh = (rt: AppRuntime) => {
  void rt.queryClient.invalidateQueries({ queryKey: ['schedule.list'] });
  void rt.queryClient.invalidateQueries({ queryKey: qk.home });
};

export async function createSchedule(rt: AppRuntime, params: ParamsInput<'schedule.create'>): Promise<Schedule | null> {
  try {
    const s = await rt.client.call('schedule.create', params);
    refresh(rt);
    return s;
  } catch (err) {
    toastError(err, '繰り返しを設定できませんでした');
    return null;
  }
}

export async function updateSchedule(rt: AppRuntime, params: ParamsInput<'schedule.update'>): Promise<Schedule | null> {
  try {
    const s = await rt.client.call('schedule.update', params);
    refresh(rt);
    return s;
  } catch (err) {
    toastError(err, '繰り返しを変更できませんでした');
    return null;
  }
}

export async function deleteSchedule(rt: AppRuntime, scheduleId: string): Promise<boolean> {
  try {
    await rt.client.call('schedule.delete', { scheduleId });
    refresh(rt);
    return true;
  } catch (err) {
    toastError(err, '繰り返しをやめられませんでした');
    return false;
  }
}

/** Fire once now; returns the new session it started. */
export async function runScheduleNow(rt: AppRuntime, scheduleId: string): Promise<string | null> {
  try {
    const r = await rt.client.call('schedule.runNow', { scheduleId });
    return r.sessionId;
  } catch (err) {
    toastError(err, '実行できませんでした');
    return null;
  }
}
