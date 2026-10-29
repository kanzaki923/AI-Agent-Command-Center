import type { SessionState } from '@acc/protocol';
import { Circle } from 'lucide-react';
import { cn } from '../../lib/cn';
import { STATE_META } from '../../lib/states';

/**
 * A session's state (spec §1.1): shape and colour, with the label for screen readers and the
 * tooltip of the caller. `working` turns (a still, thick circle when motion is reduced);
 * `supervising` breathes slowly while its children work.
 */
export function StateIcon({
  state,
  size = 14,
  className,
}: {
  state: SessionState;
  size?: number;
  className?: string;
}) {
  const meta = STATE_META[state];
  const Icon = meta.icon;
  const stroke = size <= 12 ? 2.25 : 2;
  return (
    <span
      role="img"
      aria-label={meta.label}
      data-state={state}
      className={cn('inline-flex shrink-0 items-center justify-center transition-colors duration-200', className)}
      style={{ width: size, height: size, color: meta.color }}
    >
      {state === 'working' ? (
        <>
          <Icon size={size} strokeWidth={stroke + 0.25} className="acc-motion-only acc-spin" aria-hidden />
          <Circle size={size} strokeWidth={stroke + 1} className="acc-still-only" aria-hidden />
        </>
      ) : (
        <Icon
          size={size}
          strokeWidth={stroke}
          aria-hidden
          className={state === 'supervising' ? 'acc-breathe' : undefined}
          fill={state === 'supervising' ? 'currentColor' : 'none'}
          fillOpacity={state === 'supervising' ? 0.25 : undefined}
        />
      )}
    </span>
  );
}
