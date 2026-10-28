import type { CostSource } from '@acc/protocol';
import { AnimatePresence, motion } from 'motion/react';
import { useNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { formatAbsolute, formatCost, formatElapsed, formatTimestamp } from '../../lib/format';
import { Tooltip } from './Tooltip';

/** Cost in the reported / estimated / unknown notation (§9.4). */
export function Cost({
  usd,
  source,
  className,
}: {
  usd: number;
  source: CostSource;
  className?: string;
}) {
  const v = formatCost(usd, source);
  return (
    <Tooltip content={v.tooltip}>
      <span className={cn('tabular text-meta text-fg-3', className)}>{v.text}</span>
    </Tooltip>
  );
}

/** Elapsed time from `start` to `end` (or now, via the shared 1s ticker). */
export function ElapsedTime({
  start,
  end,
  className,
}: {
  start: string | null;
  end?: string | null;
  className?: string;
}) {
  if (!start) return <span className={cn('tabular text-meta text-fg-4', className)}>—</span>;
  if (end) {
    return (
      <span className={cn('tabular text-meta text-fg-3', className)}>
        {formatElapsed(Date.parse(end) - Date.parse(start))}
      </span>
    );
  }
  return <LiveElapsed start={start} className={className} />;
}

function LiveElapsed({ start, className }: { start: string; className?: string }) {
  const now = useNow();
  return (
    <span className={cn('tabular text-meta text-fg-3', className)}>
      {formatElapsed(now - Date.parse(start))}
    </span>
  );
}

/** `14:03` / `昨日 14:03` / `10/27`, absolute time in the tooltip. */
export function TimeStamp({
  iso,
  className,
  relative = false,
}: {
  iso: string;
  className?: string;
  relative?: boolean;
}) {
  const now = useNow();
  return (
    <Tooltip content={formatAbsolute(iso)}>
      <time dateTime={iso} className={cn('tabular text-meta text-fg-3', className)}>
        {formatTimestamp(iso, now, relative)}
      </time>
    </Tooltip>
  );
}

/** 20px monogram (first letter of the task name) — agents never get colours (§2.4). */
export function Monogram({ text, className }: { text: string; className?: string }) {
  const ch = Array.from(text.trim())[0]?.toUpperCase() ?? '·';
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-xs bg-selected text-[11px] leading-none font-medium text-fg-2',
        className,
      )}
    >
      {ch}
    </span>
  );
}

/** Count that rolls: old digit leaves upward, new one enters from below (180ms, §3.2). */
export function NumberRoll({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn('relative inline-flex overflow-hidden tabular', className)}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={value}
          initial={{ y: '100%', opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: '-100%', opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          className="inline-block"
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/**
 * Skeleton block: same size as the final layout, `bg-hover`, no shimmer. Appears only after
 * 150ms (CSS delay), so fast loads never flash (§8.3).
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('block animate-[acc-skeleton-in_0s_150ms_forwards] rounded-sm bg-hover opacity-0', className)}
    />
  );
}
