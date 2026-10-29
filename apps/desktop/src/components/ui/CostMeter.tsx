import { cn } from '../../lib/cn';
import { budgetTone, formatUsd } from '../../lib/states';
import { Tooltip } from './Tooltip';

const TONE_COLOR = {
  ok: 'var(--text-secondary)',
  warn: 'var(--st-needs_you)',
  over: 'var(--st-failed)',
} as const;

/** `$20` for a whole-dollar limit, `$2.50` otherwise. */
function limitText(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

/**
 * Spend against a budget (spec §1.3): the amount, a thin meter (used / limit) and the limit.
 * Over 80% the meter turns amber, at the limit red. Without a limit only the amount shows;
 * nothing at all when nothing was spent and there is no limit. Whether the amount is an
 * estimate goes to the tooltip only.
 */
export function CostMeter({
  usedUsd,
  limitUsd,
  estimated = false,
  width = 44,
  className,
}: {
  usedUsd: number;
  limitUsd: number | null;
  estimated?: boolean;
  /** Meter width in px. */
  width?: number;
  className?: string;
}) {
  const amount = formatUsd(usedUsd);
  if (limitUsd == null) {
    if (!amount) return null;
    return (
      <Tooltip content={estimated ? '推定を含む' : null}>
        <span className={cn('tabular text-meta whitespace-nowrap text-fg-2', className)}>{amount}</span>
      </Tooltip>
    );
  }
  const tone = budgetTone(usedUsd, limitUsd);
  const pct = Math.max(0, Math.min(1, limitUsd > 0 ? usedUsd / limitUsd : 1));
  const tip = `${amount ?? '$0'} / ${limitText(limitUsd)}${estimated ? '（推定を含む）' : ''}`;
  return (
    <Tooltip content={tip}>
      <span
        className={cn('inline-flex items-center gap-1.5 tabular text-meta whitespace-nowrap', className)}
        role="meter"
        aria-label="予算"
        aria-valuemin={0}
        aria-valuemax={limitUsd}
        aria-valuenow={Math.min(usedUsd, limitUsd)}
        aria-valuetext={tip}
        data-tone={tone}
      >
        {amount && <span className={tone === 'ok' ? 'text-fg-2' : undefined} style={tone === 'ok' ? undefined : { color: TONE_COLOR[tone] }}>{amount}</span>}
        <span className="relative h-1 overflow-hidden rounded-full bg-selected" style={{ width }}>
          <span
            className="absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-200"
            style={{ width: `${pct * 100}%`, background: TONE_COLOR[tone] }}
          />
        </span>
        <span className="text-fg-3">{limitText(limitUsd)}</span>
      </span>
    </Tooltip>
  );
}
