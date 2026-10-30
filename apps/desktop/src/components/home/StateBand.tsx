import type { HomeTree } from '@acc/protocol';
import { cn } from '../../lib/cn';
import { STATE_META } from '../../lib/states';
import { StateIcon } from '../ui/StateIcon';
import { Tooltip } from '../ui/Tooltip';
import { bandSegments } from './layout';

/**
 * A tree at a glance (spec §3.1): its sessions' states as one thin bar, each state's share in
 * its colour, in priority order (needs you and failures first, done last). Hovering shows the
 * counts as icons and numbers, and `note` (the tree's spend, ui-rework spec §3.1) after them.
 */
export function StateBand({
  counts,
  note,
  width = 120,
  className,
}: {
  counts: HomeTree['counts'];
  /** One more line in the tooltip (e.g. `費用 $2.77 / $3.40`). */
  note?: string | null;
  width?: number;
  className?: string;
}) {
  const segments = bandSegments(counts);
  const total = segments.reduce((n, s) => n + s.n, 0);
  const label = segments.map((s) => `${STATE_META[s.state].label} ${s.n}`).join('、');
  const bar = (
    <span
      role="img"
      aria-label={label || '状態なし'}
      aria-description={note ?? undefined}
      data-state-band
      className={cn('flex h-1.5 shrink-0 gap-px overflow-hidden rounded-full', total === 0 && 'bg-selected', className)}
      style={{ width }}
    >
      {segments.map((s) => (
        <span
          key={s.state}
          data-band-state={s.state}
          className="h-full transition-[flex-grow,background-color] duration-200 first:rounded-l-full last:rounded-r-full"
          style={{ flexGrow: s.n, flexBasis: 0, background: STATE_META[s.state].color }}
        />
      ))}
    </span>
  );
  if (total === 0 && !note) return bar;
  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-1">
          {total > 0 && (
            <span className="flex items-center gap-2.5">
              {segments.map((s) => (
                <span key={s.state} className="flex items-center gap-1">
                  <StateIcon state={s.state} size={12} />
                  <span className="tabular text-fg">{s.n}</span>
                </span>
              ))}
            </span>
          )}
          {note && <span className="tabular">{note}</span>}
        </span>
      }
    >
      {bar}
    </Tooltip>
  );
}
