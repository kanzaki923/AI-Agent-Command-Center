import { type ReactElement, useState } from 'react';
import { useCostSummary } from '../../daemon/cost';
import { useTodaySpend } from '../../daemon/home';
import { formatUsd } from '../../lib/states';
import { CostMeter } from '../ui/CostMeter';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Menu';

/**
 * Today's spend (title bar meter → this popover, spec §7). Owned by track U5; this is the
 * entry point with its fixed props: `children` is the trigger (the title bar's meter button).
 * Minimal content: today's total against the daily limit and the trees that spent the most.
 */
export function CostPopover({ children }: { children: ReactElement }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        {open && <CostContents />}
      </PopoverContent>
    </Popover>
  );
}

function CostContents() {
  const today = useTodaySpend();
  const byTree = useCostSummary({ range: 'today', groupBy: 'root' }).data;
  const rows = (byTree?.rows ?? []).filter((r) => r.usd > 0).slice(0, 8);
  const max = Math.max(...rows.map((r) => r.usd), 0.0001);
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="cost-popover">
      <div className="flex items-center justify-between gap-3">
        <span className="text-ui font-medium text-fg">今日</span>
        <CostMeter usedUsd={today?.usedUsd ?? 0} limitUsd={today?.limitUsd ?? null} estimated={today?.estimated} width={96} />
      </div>
      {rows.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_72px_48px] items-center gap-2 text-meta">
              <span className="truncate text-fg-2">{r.label}</span>
              <span className="h-1.5 rounded-full bg-selected">
                <span className="block h-full rounded-full bg-[var(--text-secondary)]" style={{ width: `${(r.usd / max) * 100}%` }} />
              </span>
              <span className="tabular text-right text-fg-2">{formatUsd(r.usd)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
