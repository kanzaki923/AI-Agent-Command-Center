import { GitMerge } from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '../../lib/cn';
import { type DisplayState, STATE_LABEL } from '../../lib/status';

const COLOR: Record<DisplayState, string> = {
  running: 'var(--st-running)',
  awaiting_approval: 'var(--st-awaiting_approval)',
  failed: 'var(--st-failed)',
  review: 'var(--st-review)',
  interrupted: 'var(--st-interrupted)',
  completed: 'var(--st-completed)',
  queued: 'var(--st-queued)',
  cancelled: 'var(--st-cancelled)',
  idle: 'var(--text-disabled)',
};

export function stateColor(s: DisplayState): string {
  return COLOR[s];
}

/** Glyph inside a filled disc, drawn on a 16-unit grid. */
function Glyph({ state }: { state: DisplayState }) {
  const white = 'var(--bg-canvas)';
  switch (state) {
    case 'awaiting_approval':
      return (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M6.2 6.2a1.9 1.9 0 1 1 2.6 1.75c-.5.2-.8.6-.8 1.1v.35"
            fill="none"
            stroke={white}
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <circle cx="8" cy="11.6" r="0.95" fill={white} />
        </>
      );
    case 'failed':
      return (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke={white} strokeWidth="1.6" strokeLinecap="round" />
        </>
      );
    case 'completed':
      return (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M5 8.3l2 2 4-4.4"
            fill="none"
            stroke={white}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case 'interrupted':
      return (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6.6 5.6v4.8M9.4 5.6v4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      );
    case 'cancelled':
      return (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5.5 8h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      );
    case 'queued':
      return (
        <circle
          cx="8"
          cy="8"
          r="6.25"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="2 2"
        />
      );
    case 'idle':
      return <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />;
    case 'running':
    case 'review':
      return null;
  }
}

/**
 * Run/Task state icon (ui-design §2.5). Shape + colour + (optional) label: never colour
 * alone. Changing state cross-fades/scales the glyph once (motion, 120–180ms).
 */
export function StatusIcon({
  state,
  size = 14,
  className,
  title,
}: {
  state: DisplayState;
  size?: number;
  className?: string;
  title?: string;
}) {
  const color = COLOR[state];
  const label = title ?? STATE_LABEL[state];
  if (state === 'running') {
    const dot = Math.round(size * 0.58);
    return (
      <span
        role="img"
        aria-label={label}
        className={cn('relative inline-flex shrink-0 items-center justify-center', className)}
        style={{ width: size, height: size }}
      >
        <span
          className="acc-pulse absolute rounded-full"
          style={{ width: dot, height: dot, background: color }}
        />
        <motion.span
          key="dot"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18 }}
          className="relative rounded-full"
          style={{ width: dot, height: dot, background: color }}
        />
      </span>
    );
  }
  if (state === 'review') {
    return (
      <span
        role="img"
        aria-label={label}
        className={cn('inline-flex shrink-0', className)}
        style={{ width: size, height: size, color }}
      >
        <GitMerge size={size} strokeWidth={1.75} />
      </span>
    );
  }
  return (
    <motion.svg
      key={state}
      role="img"
      aria-label={label}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      style={{ color }}
      initial={state === 'completed' ? { scale: 0.6, opacity: 0 } : { opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: state === 'completed' ? 0.12 : 0.18, ease: [0.16, 1, 0.3, 1] }}
    >
      <Glyph state={state} />
    </motion.svg>
  );
}

/** Small status label in the state colour (paired with the icon). */
export function StatusLabel({ state, className }: { state: DisplayState; className?: string }) {
  return (
    <span className={cn('text-meta font-medium', className)} style={{ color: COLOR[state] }}>
      {STATE_LABEL[state]}
    </span>
  );
}
