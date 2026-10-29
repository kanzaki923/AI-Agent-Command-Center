import { useRef, useState } from 'react';
import { HOLD_AFTER_KEYBOARD_MS, HOLD_MAX_MS } from '../../hooks/useDeferredReorder';
import { type LaneShape, heldShape } from './layout';

export interface ShapeHold {
  /** The shape to draw: live, or held still. */
  lanes: LaneShape[];
  holding: boolean;
  /** Spread onto the area the pointer holds still. */
  bind: { onPointerEnter: () => void; onPointerLeave: () => void };
  /** Call when the selection moved by keyboard. */
  noteKeyboard: () => void;
}

/**
 * Holds the home screen's shape (lane order, folding, chip order) still while the pointer is
 * over it, or for 2s after a keyboard move, never longer than 4s at a time (spec §0.5, §3.3;
 * the same timings as useDeferredReorder). Cards keep updating; only their places wait. Event
 * driven: timers set from handlers, no effects.
 */
export function useShapeHold(live: LaneShape[]): ShapeHold {
  const [held, setHeld] = useState<LaneShape[] | null>(null);
  const timers = useRef<{ max?: ReturnType<typeof setTimeout>; key?: ReturnType<typeof setTimeout> }>({});
  const pointerInside = useRef(false);

  const release = () => {
    clearTimeout(timers.current.max);
    clearTimeout(timers.current.key);
    timers.current = {};
    setHeld(null);
  };

  const capture = () => {
    if (timers.current.max) return; // already holding
    setHeld(live);
    timers.current.max = setTimeout(release, HOLD_MAX_MS);
  };

  const bind = {
    onPointerEnter: () => {
      pointerInside.current = true;
      capture();
    },
    onPointerLeave: () => {
      pointerInside.current = false;
      if (!timers.current.key) release();
    },
  };

  const noteKeyboard = () => {
    capture();
    clearTimeout(timers.current.key);
    timers.current.key = setTimeout(() => {
      timers.current.key = undefined;
      if (!pointerInside.current) release();
    }, HOLD_AFTER_KEYBOARD_MS);
  };

  if (!held) return { lanes: live, holding: false, bind, noteKeyboard };
  return { lanes: heldShape(held, live), holding: true, bind, noteKeyboard };
}
