import type { Attention, AttentionKind, Event, Session } from '@acc/protocol';
import type { QueryClient } from '@tanstack/react-query';
import { qk } from '../daemon/keys';
import type { AppRuntime } from '../daemon/runtime';
import { type OsNotification, notify, windowFocused } from '../lib/notify';
import { sessionTitle } from '../lib/states';
import { type Toast, toast } from '../store/toast';
import { type Mode, useUi } from '../store/ui';

/**
 * Attention notifications: an item that needs the human (attention.opened) is said once,
 * where it will be seen — an OS notification while the window is in the background, an
 * in-app toast while it is in front but the item is not on screen. Never more than one per
 * kind per 10 seconds (later ones fold into a count).
 */

export interface AttentionView {
  mode: Mode;
  focusSessionId: string | null;
  reviewIntegrationId: string | null;
  notifyOs: boolean;
  notifyInApp: boolean;
}

export interface AttentionDeps {
  qc: QueryClient;
  view: () => AttentionView;
  focused: () => boolean;
  os: (n: OsNotification) => void;
  toast: (t: Omit<Toast, 'id'>) => void;
  open: (item: Attention) => void;
  now?: () => number;
  windowMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/** Older events are replays (reconnect, history): they were news a while ago, not now. */
const STALE_MS = 120_000;
export const COALESCE_MS = 10_000;

const KIND_TITLE: Record<AttentionKind, (n: number) => string> = {
  question: (n) => (n > 1 ? `質問が ${n} 件あります` : '質問があります'),
  approval: (n) => (n > 1 ? `確認が ${n} 件あります` : '確認を求めています'),
  failure: (n) => (n > 1 ? `${n} 件が失敗しました` : '失敗しました'),
  review: (n) => (n > 1 ? `確認待ちが ${n} 件あります` : '確認できます'),
  budget: () => '予算に達しました',
  stuck: (n) => (n > 1 ? `${n} 件が止まっています` : '止まっています'),
};

/** Whether the item is on screen right now (then it is not news). */
export function isVisible(item: Attention, v: AttentionView): boolean {
  if (v.reviewIntegrationId) return false;
  // The home screen lists every open item at its top.
  if (v.mode === 'home') return true;
  return v.mode === 'session' && v.focusSessionId === item.sessionId;
}

/** Wire the notifier to the app (main.tsx): live events in, toasts / OS notifications out. */
export function installAttention(rt: AppRuntime): () => void {
  const notifier = createAttentionNotifier({
    qc: rt.queryClient,
    view: () => {
      const s = useUi.getState();
      return {
        mode: s.mode,
        focusSessionId: s.focusSessionId,
        reviewIntegrationId: s.reviewIntegrationId,
        notifyOs: s.notifyOs,
        notifyInApp: s.notifyInApp,
      };
    },
    focused: windowFocused,
    os: (n) => void notify(n),
    toast: (t) => toast(t),
    open: (item) => useUi.getState().openSession(item.sessionId),
  });
  const off = rt.onEvent((e) => notifier.handle(e));
  return () => {
    off();
    notifier.dispose();
  };
}

export function createAttentionNotifier(deps: AttentionDeps) {
  const now = deps.now ?? Date.now;
  const windowMs = deps.windowMs ?? COALESCE_MS;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const windows = new Map<string, { timer: unknown; pending: Attention[] }>();

  const sessionName = (id: string) => {
    const s = deps.qc.getQueryData<Session[]>(qk.sessions)?.find((x) => x.id === id);
    return s ? sessionTitle(s) : null;
  };

  const deliver = (channel: 'os' | 'app', items: Attention[]) => {
    const first = items[0]!;
    const many = items.length > 1;
    const title = KIND_TITLE[first.kind](items.length);
    const where = sessionName(first.sessionId);
    const body = many
      ? items
          .slice(0, 3)
          .map((i) => i.title)
          .join('、') + (items.length > 3 ? ' ほか' : '')
      : [where, first.title].filter(Boolean).join(' — ');
    if (channel === 'os') {
      deps.os({ title, body, tag: `acc-${first.kind}`, onClick: () => deps.open(first) });
    } else {
      deps.toast({
        key: `attention-${first.kind}`,
        title,
        detail: body,
        tone: first.kind === 'failure' ? 'error' : 'info',
        showDetail: true,
        sticky: false,
        action: { label: '開く', run: () => deps.open(first) },
      });
    }
  };

  /** A quiet period after a notification; what arrives meanwhile is summed up at its end. */
  const openWindow = (key: string, channel: 'os' | 'app') => {
    const w = { timer: null as unknown, pending: [] as Attention[] };
    windows.set(key, w);
    w.timer = setTimer(() => {
      windows.delete(key);
      if (w.pending.length === 0) return;
      deliver(channel, w.pending);
      openWindow(key, channel);
    }, windowMs);
  };

  /** First of a kind goes out now; more within the window fold into one summary. */
  const push = (channel: 'os' | 'app', item: Attention) => {
    const key = `${channel}:${item.kind}`;
    const w = windows.get(key);
    if (w) {
      w.pending.push(item);
      return;
    }
    deliver(channel, [item]);
    openWindow(key, channel);
  };

  return {
    handle(e: Event): void {
      if (e.type !== 'attention.opened') return;
      if (now() - Date.parse(e.ts) > STALE_MS) return;
      const item = e.payload.attention;
      const v = deps.view();
      if (!deps.focused()) {
        if (v.notifyOs) push('os', item);
        return;
      }
      if (v.notifyInApp && !isVisible(item, v)) push('app', item);
    },
    dispose(): void {
      for (const w of windows.values()) clearTimer(w.timer);
      windows.clear();
    },
  };
}
