import type { CostSummary, SessionRole } from '@acc/protocol';
import { Cpu } from 'lucide-react';
import { type ReactElement, type ReactNode, useState } from 'react';
import { setDailyLimit, useCostSummary } from '../../daemon/cost';
import { useHomeSelect, useTodaySpend } from '../../daemon/home';
import { useRuntime } from '../../daemon/runtime';
import { cn } from '../../lib/cn';
import { budgetTone, formatUsd } from '../../lib/states';
import { useUi } from '../../store/ui';
import { UsdField } from '../settings/controls';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Menu';
import { RoleIcon } from '../ui/SemanticIcons';
import { Tooltip } from '../ui/Tooltip';

/** Trees shown in the popover (the rest are in the total). */
export const TOP_TREES = 8;

const TONE_COLOR = { ok: 'var(--text-secondary)', warn: 'var(--st-needs_you)', over: 'var(--st-failed)' } as const;

/** Rows worth a line: something was spent, the biggest first. */
export function spendRows(summary: CostSummary | undefined, limit = Number.POSITIVE_INFINITY): CostSummary['rows'] {
  return (summary?.rows ?? [])
    .filter((r) => r.usd >= 0.005)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, limit);
}

/**
 * Today's spend (title bar meter → this popover, spec §7): the total against the daily limit
 * (changed in place), one bar per conversation tree (the top 8, press to open it) and the
 * subtotal per model. `children` is the trigger.
 */
export function CostPopover({ children }: { children: ReactElement }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent focusInput={false} align="end" className="w-[360px]">
        {open && <CostContents onOpenTree={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  );
}

function CostContents({ onOpenTree }: { onOpenTree: () => void }) {
  const rt = useRuntime();
  const openSession = useUi((s) => s.openSession);
  const today = useTodaySpend();
  const byTree = spendRows(useCostSummary({ range: 'today', groupBy: 'root' }).data, TOP_TREES);
  const byModel = spendRows(useCostSummary({ range: 'today', groupBy: 'model' }).data);
  const roles = useHomeSelect((s) => new Map<string, SessionRole>(s.trees.map((t) => [t.root.id, t.root.role]))) ?? null;
  const used = today?.usedUsd ?? 0;
  const limit = today?.limitUsd ?? null;
  const tone = limit != null ? budgetTone(used, limit) : 'ok';
  const max = Math.max(...byTree.map((r) => r.usd), ...byModel.map((r) => r.usd), 0.01);
  return (
    <div className="flex flex-col" data-testid="cost-popover">
      <div className="flex flex-col gap-2 px-3 pt-3 pb-2.5">
        <div className="flex items-center gap-2">
          <span className="flex-1 text-ui font-medium text-fg">今日</span>
          <Tooltip content={today?.estimated ? '推定を含む' : null}>
            <span
              className="text-title tabular"
              style={{ color: tone === 'ok' ? 'var(--text-primary)' : TONE_COLOR[tone] }}
              data-testid="cost-today"
            >
              {formatUsd(used) ?? '$0'}
            </span>
          </Tooltip>
          <span className="text-ui text-fg-4">/</span>
          <UsdField
            label="1 日の上限"
            value={limit}
            allowEmpty
            placeholder="—"
            width={76}
            onCommit={(v) => void setDailyLimit(rt, v)}
          />
        </div>
        {limit != null && (
          <span className="relative h-1 overflow-hidden rounded-full bg-selected" role="presentation">
            <span
              className="absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-200"
              style={{ width: `${Math.min(1, limit > 0 ? used / limit : 1) * 100}%`, background: TONE_COLOR[tone] }}
            />
          </span>
        )}
      </div>
      {byTree.length > 0 && (
        <ul aria-label="会話ごと" className="flex flex-col border-t border-line-subtle p-1">
          {byTree.map((r) => (
            <li key={r.key}>
              <button
                type="button"
                className="w-full rounded-sm px-2 py-1 hover:bg-hover"
                onClick={() => {
                  onOpenTree();
                  openSession(r.key);
                }}
              >
                <SpendBar
                  icon={<RoleIcon role={roles?.get(r.key) ?? 'chat'} size={12} className="text-fg-3" />}
                  label={r.label}
                  usd={r.usd}
                  max={max}
                />
              </button>
            </li>
          ))}
        </ul>
      )}
      {byModel.length > 0 && (
        <ul aria-label="モデルごと" className="flex flex-col border-t border-line-subtle p-1">
          {byModel.map((r) => (
            <li key={r.key} className="px-2 py-1">
              <SpendBar
                icon={<Cpu size={12} strokeWidth={1.75} className="text-fg-3" aria-hidden />}
                label={r.label}
                usd={r.usd}
                max={max}
                muted
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SpendBar({
  icon,
  label,
  usd,
  max,
  muted = false,
}: {
  icon: ReactNode;
  label: string;
  usd: number;
  max: number;
  muted?: boolean;
}) {
  return (
    <span className="grid grid-cols-[14px_minmax(0,1fr)_72px_52px] items-center gap-2 text-left text-meta">
      <span className="flex justify-center">{icon}</span>
      <span className={cn('truncate', muted ? 'text-fg-3' : 'text-fg-2')}>{label}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-selected">
        <span
          className="block h-full rounded-full"
          style={{ width: `${Math.max(2, (usd / max) * 100)}%`, background: muted ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}
        />
      </span>
      <span className={cn('tabular text-right', muted ? 'text-fg-3' : 'text-fg-2')}>{formatUsd(usd)}</span>
    </span>
  );
}
