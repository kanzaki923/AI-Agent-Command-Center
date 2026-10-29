import type { HomeTree } from '@acc/protocol';
import { cn } from '../../lib/cn';
import { STATE_META } from '../../lib/states';
import { StateIcon } from '../ui/StateIcon';
import { Tooltip } from '../ui/Tooltip';
import { bandSegments } from './layout';

/**
 * A tree at a glance (spec §3.1): its sessions' states as one thin bar, each state's share in
 * its colour, in priority order (needs you and failures first, done last). Hovering shows the
 * counts as icons and numbers.
 */
export function StateBand({ counts, width = 120, className }: { counts: HomeTree['counts']; width?: number; className?: string }) {
  const segments = bandSegments(counts);
  const total = segments.reduce((n, s) => n + s.n, 0);
  const label = segments.map((s) => `${STATE_META[s.state].label} ${s.n}`).join('、');
  const bar = (
    <span
      role="img"
      aria-label={label || '状態なし'}
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
  if (total === 0) return bar;
  return (
    <Tooltip
      content={
        <span className="flex items-center gap-2.5">
          {segments.map((s) => (
            <span key={s.state} className="flex items-center gap-1">
              <StateIcon state={s.state} size={12} />
              <span className="tabular text-fg">{s.n}</span>
            </span>
          ))}
        </span>
      }
    >
      {bar}
    </Tooltip>
  );
}
