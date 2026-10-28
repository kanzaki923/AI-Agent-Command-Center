import { useRef, useState } from 'react';

export const HOLD_AFTER_KEYBOARD_MS = 2000;
export const HOLD_MAX_MS = 4000;

type Snapshot = Map<string, { group: string; index: number }>;

export interface DeferredReorder<T> {
  /** Items in display order (frozen groups while holding). */
  items: T[];
  /** Group each item is displayed in. */
  groupOf: (item: T) => string;
  /** Items whose group changed while holding (shown as `· 更新 N件`). */
  pending: number;
  holding: boolean;
  /** Spread onto the list container. */
  bind: { onPointerEnter: () => void; onPointerLeave: () => void };
  /** Call when the selection moved by keyboard. */
  noteKeyboard: () => void;
}

/**
 * Reorder hold (ui-design §3.2): while the pointer is over the list, or within 2s of a
 * keyboard selection, items keep the group/position they had (max 4s), so the row under
 * the user's hand never runs away. Driven by events only — no effects.
 */
export function useDeferredReorder<T>(
  items: T[],
  getId: (item: T) => string,
  getGroup: (item: T) => string,
): DeferredReorder<T> {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const timers = useRef<{ max?: ReturnType<typeof setTimeout>; key?: ReturnType<typeof setTimeout> }>({});
  const pointerInside = useRef(false);

  const release = () => {
    clearTimeout(timers.current.max);
    clearTimeout(timers.current.key);
    timers.current = {};
    setSnapshot(null);
  };

  const capture = () => {
    if (timers.current.max) return; // already holding
    const snap: Snapshot = new Map();
    const counters = new Map<string, number>();
    for (const it of items) {
      const g = getGroup(it);
      const n = counters.get(g) ?? 0;
      counters.set(g, n + 1);
      snap.set(getId(it), { group: g, index: n });
    }
    setSnapshot(snap);
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

  if (!snapshot) {
    return { items, groupOf: getGroup, pending: 0, holding: false, bind, noteKeyboard };
  }

  let pending = 0;
  const groupOf = (it: T) => snapshot.get(getId(it))?.group ?? getGroup(it);
  for (const it of items) {
    const s = snapshot.get(getId(it));
    if (s && s.group !== getGroup(it)) pending++;
  }
  const ordered = items
    .map((it, i) => ({ it, i, s: snapshot.get(getId(it)) }))
    .sort((a, b) => {
      // Within a frozen group keep the old index; new items go after, in live order.
      const ai = a.s ? a.s.index : 1e6 + a.i;
      const bi = b.s ? b.s.index : 1e6 + b.i;
      return ai - bi;
    })
    .map((x) => x.it);
  return { items: ordered, groupOf, pending, holding: true, bind, noteKeyboard };
}
