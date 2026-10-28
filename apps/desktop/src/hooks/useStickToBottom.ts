import { useCallback, useRef, useState } from 'react';

/** Within this distance from the bottom the view follows new content (§6.1). */
export const STICK_THRESHOLD_PX = 48;
/** A scroll event this soon after wheel/key/pointer input counts as the user's. */
const USER_INTENT_MS = 800;

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

export interface StickToBottom {
  /** Ref callback for the scroll container. */
  scrollRef: (el: HTMLElement | null) => void;
  /** Ref callback for the element whose size grows with content. */
  contentRef: (el: HTMLElement | null) => void;
  following: boolean;
  /** When follow mode was left (ms), null while following. */
  unfollowedAt: number | null;
  /** Content arrived while not following (show "↓ 新しいメッセージ"). */
  hasUnseen: boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** Stop following (before a programmatic jump up the history). */
  release: () => void;
  /** The scroll container (for virtualizers); call from callbacks, not during render. */
  getElement: () => HTMLElement | null;
}

export function distanceFromBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/**
 * Auto-scroll that follows streaming content until the user scrolls up (§6.1). Following
 * is decided from user input events (wheel, keys, scrollbar drag), never from our own
 * programmatic scrolls. DOM listeners live in ref callbacks (React 19 ref cleanup), so no
 * effects are needed.
 */
export function useStickToBottom(): StickToBottom {
  const [following, setFollowingState] = useState(true);
  const [hasUnseen, setHasUnseen] = useState(false);
  const followingRef = useRef(true);
  const scrollEl = useRef<HTMLElement | null>(null);
  const intentAt = useRef(0);
  const [unfollowedAt, setUnfollowedAt] = useState<number | null>(null);

  const setFollowing = useCallback((v: boolean) => {
    if (followingRef.current !== v) setUnfollowedAt(v ? null : Date.now());
    followingRef.current = v;
    setFollowingState(v);
    if (v) setHasUnseen(false);
  }, []);

  const pin = useCallback(() => {
    const el = scrollEl.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const scrollRef = useCallback(
    (el: HTMLElement | null) => {
      scrollEl.current = el;
      if (!el) return;
      const markIntent = () => {
        intentAt.current = Date.now();
      };
      const onWheel = (e: WheelEvent) => {
        markIntent();
        // Scrolling up leaves follow mode immediately, even before the scroll event.
        if (e.deltaY < 0 && followingRef.current) setFollowing(false);
      };
      const onKey = (e: KeyboardEvent) => {
        if (SCROLL_KEYS.has(e.key)) markIntent();
      };
      const onPointerDown = (e: PointerEvent) => {
        // Scrollbar drag: the pointer lands on the container itself.
        if (e.target === el) markIntent();
      };
      const onScroll = () => {
        if (Date.now() - intentAt.current > USER_INTENT_MS) return;
        const atBottom = distanceFromBottom(el) <= STICK_THRESHOLD_PX;
        if (atBottom !== followingRef.current) setFollowing(atBottom);
      };
      el.addEventListener('wheel', onWheel, { passive: true });
      el.addEventListener('keydown', onKey);
      el.addEventListener('pointerdown', onPointerDown);
      el.addEventListener('scroll', onScroll, { passive: true });
      return () => {
        el.removeEventListener('wheel', onWheel);
        el.removeEventListener('keydown', onKey);
        el.removeEventListener('pointerdown', onPointerDown);
        el.removeEventListener('scroll', onScroll);
      };
    },
    [setFollowing],
  );

  const contentRef = useCallback(
    (el: HTMLElement | null) => {
      if (!el || typeof ResizeObserver === 'undefined') return;
      let frame = 0;
      // Defer to the next frame: reacting inside the observer callback can trigger
      // "ResizeObserver loop completed with undelivered notifications".
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (followingRef.current) pin();
          else setHasUnseen(true);
        });
      });
      ro.observe(el);
      pin();
      return () => {
        cancelAnimationFrame(frame);
        ro.disconnect();
      };
    },
    [pin],
  );

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      setFollowing(true);
      const el = scrollEl.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior });
    },
    [setFollowing],
  );

  const getElement = useCallback(() => scrollEl.current, []);
  const release = useCallback(() => setFollowing(false), [setFollowing]);

  return { scrollRef, contentRef, following, unfollowedAt, hasUnseen, scrollToBottom, release, getElement };
}
