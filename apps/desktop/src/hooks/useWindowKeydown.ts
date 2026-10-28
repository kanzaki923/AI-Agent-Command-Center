import { useEffect, useEffectEvent } from 'react';

/**
 * Listen to keydown on `window` (keyboard shortcuts that work without a focused element).
 * The handler always sees the latest render's values via useEffectEvent.
 */
export function useWindowKeydown(handler: (e: KeyboardEvent) => void, capture = false): void {
  const onKey = useEffectEvent(handler);
  // useEffect is required: window keydown is a DOM event source outside React's tree.
  useEffect(() => {
    const fn = (e: KeyboardEvent) => onKey(e);
    window.addEventListener('keydown', fn, { capture });
    return () => window.removeEventListener('keydown', fn, { capture });
  }, [capture]);
}
