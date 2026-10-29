import type { Schedule, ScheduleTriggerInput } from '@acc/protocol';
import { Clock } from 'lucide-react';
import { useState } from 'react';
import { useSessions } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { createSchedule, deleteSchedule, updateSchedule, useSchedulePreview, useSchedules } from '../../daemon/schedule';
import { useSlowNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { formatNextRun } from '../../lib/states';
import { FieldRow, UsdField } from '../settings/controls';
import { Button } from '../ui/Button';
import { inputClass } from '../ui/Dialog';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';
import {
  CUSTOM,
  DEFAULT_FIRING_BUDGET,
  REPEAT_PRESETS,
  cronTrigger,
  formatFireTime,
  presetOf,
  repeatPrompt,
  repeatTitle,
} from './repeat';

export { REPEAT_PRESETS } from './repeat';

/**
 * 繰り返す (spec §7): repeat a conversation's request on a schedule. The clock in the header
 * shows the next time once it repeats; the popover picks a preset (or a cron expression),
 * shows the next 3 times and the budget of one firing.
 */
export function RepeatButton({ sessionId, className }: { sessionId: string; className?: string }) {
  const now = useSlowNow();
  const [open, setOpen] = useState(false);
  const schedule = (useSchedules(sessionId).data ?? []).find((s) => s.enabled) ?? null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content={open || schedule ? null : '繰り返す'}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="繰り返す"
            data-repeating={schedule ? '' : undefined}
            className={cn(
              'inline-flex h-7 shrink-0 items-center gap-1 rounded-sm px-1.5 text-meta hover:bg-hover hover:text-fg',
              schedule ? 'text-fg-2' : 'text-fg-3',
              className,
            )}
          >
            <Clock size={15} strokeWidth={1.75} />
            {schedule?.nextRunAt && <span className="tabular">{formatNextRun(schedule.nextRunAt, now)}</span>}
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent focusInput={false} align="end" className="w-72">
        {/* Keyed: a schedule made or removed elsewhere starts the choice afresh. */}
        {open && (
          <RepeatSettings key={schedule?.id ?? 'new'} sessionId={sessionId} schedule={schedule} onDone={() => setOpen(false)} />
        )}
      </PopoverContent>
    </Popover>
  );
}

function RepeatSettings({
  sessionId,
  schedule,
  onDone,
}: {
  sessionId: string;
  schedule: Schedule | null;
  onDone: () => void;
}) {
  const rt = useRuntime();
  const connected = useConnectionState() === 'open';
  const now = useSlowNow();
  const session = useSessions().data?.find((s) => s.id === sessionId) ?? null;
  const [choice, setChoice] = useState(() => (schedule ? presetOf(schedule.trigger) : REPEAT_PRESETS[0]!.id));
  const [expr, setExpr] = useState(() => (schedule?.trigger.kind === 'cron' ? schedule.trigger.expr : '0 9 * * *'));
  const [budget, setBudget] = useState(schedule?.run.budgetUsd ?? DEFAULT_FIRING_BUDGET);
  const trigger: ScheduleTriggerInput | null =
    choice === CUSTOM ? cronTrigger(expr) : (REPEAT_PRESETS.find((p) => p.id === choice)?.trigger ?? null);
  const preview = useSchedulePreview(trigger, 3);
  const invalid = choice === CUSTOM && (!trigger || preview.isError);
  const prompt = repeatPrompt(session);

  // An existing schedule changes at once; a new one waits for 繰り返す.
  const pick = (id: string) => {
    setChoice(id);
    const t = REPEAT_PRESETS.find((p) => p.id === id)?.trigger;
    if (schedule && t) void updateSchedule(rt, { scheduleId: schedule.id, trigger: t });
  };
  const commitExpr = () => {
    const t = cronTrigger(expr);
    const current = schedule?.trigger.kind === 'cron' ? schedule.trigger.expr : null;
    if (schedule && t && !preview.isError && t.expr !== current) {
      void updateSchedule(rt, { scheduleId: schedule.id, trigger: t });
    }
  };
  const create = async () => {
    if (!trigger || invalid || !prompt) return;
    const title = repeatTitle(session);
    const made = await createSchedule(rt, {
      sessionId,
      prompt,
      trigger,
      ...(title ? { title } : {}),
      run: { budgetUsd: budget },
    });
    if (made) onDone();
  };

  return (
    <div className="flex flex-col" data-testid="repeat-popover">
      <div role="radiogroup" aria-label="いつ" className="flex flex-col p-1">
        {[...REPEAT_PRESETS.map((p) => ({ id: p.id, label: p.label })), { id: CUSTOM, label: '自分で書く' }].map((o) => {
          const checked = choice === o.id;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => pick(o.id)}
              className={cn(
                'flex h-7 items-center gap-2 rounded-sm px-2 text-left text-ui',
                checked ? 'bg-selected text-fg' : 'text-fg-2 hover:bg-hover',
              )}
            >
              <span
                className={cn(
                  'flex size-3 shrink-0 items-center justify-center rounded-full border',
                  checked ? 'border-accent' : 'border-line-strong',
                )}
              >
                {checked && <span className="size-1.5 rounded-full bg-accent" />}
              </span>
              {o.label}
            </button>
          );
        })}
        {choice === CUSTOM && (
          <input
            aria-label="cron"
            aria-invalid={invalid}
            autoFocus
            spellCheck={false}
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            onBlur={commitExpr}
            onKeyDown={(e) => e.key === 'Enter' && commitExpr()}
            placeholder="分 時 日 月 曜日"
            className={cn(inputClass, 'mx-1 mt-1 w-auto font-mono', invalid && 'border-st-failed hover:border-st-failed')}
          />
        )}
      </div>
      <div className="flex flex-col gap-1.5 border-t border-line-subtle px-3 py-2.5">
        <ol aria-label="次の予定" className="flex flex-col gap-1" data-testid="repeat-preview">
          {(trigger && !preview.isError ? (preview.data ?? []) : []).map((t) => (
            <li key={t} className="flex items-center gap-2 text-meta text-fg-2 tabular">
              <Clock size={12} strokeWidth={1.75} className="text-fg-3" />
              {formatFireTime(t, now)}
            </li>
          ))}
        </ol>
        <FieldRow label="1 回の予算" htmlFor="repeat-budget">
          <UsdField
            id="repeat-budget"
            label="1 回の予算"
            value={budget}
            max={1000}
            width={84}
            onCommit={(v) => {
              if (v == null) return;
              setBudget(v);
              if (schedule) void updateSchedule(rt, { scheduleId: schedule.id, run: { budgetUsd: v } });
            }}
          />
        </FieldRow>
      </div>
      <div className="flex justify-end gap-2 border-t border-line-subtle px-3 py-2">
        {schedule ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onDone();
              void deleteSchedule(rt, schedule.id);
            }}
          >
            繰り返しをやめる
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={!connected || !trigger || invalid || !prompt}
            hint={prompt ? undefined : '依頼がまだありません'}
            onClick={() => void create()}
          >
            繰り返す
          </Button>
        )}
      </div>
    </div>
  );
}
