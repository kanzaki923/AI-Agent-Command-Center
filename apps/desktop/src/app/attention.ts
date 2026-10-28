import type { Event, Session } from '@acc/protocol';
import type { QueryClient } from '@tanstack/react-query';
import { qk } from '../daemon/keys';
import type { AppRuntime } from '../daemon/runtime';
import { type OsNotification, notify, windowFocused } from '../lib/notify';
import { headLines, shorten } from '../lib/tools';
import { untitled } from '../model/board';
import { type Toast, toast } from '../store/toast';
import { useUi } from '../store/ui';

/**
 * Attention notifications (ui-design §8.5): things that need the human, said once, where
 * they will be seen — an OS notification while the window is in the background, an in-app
 * toast while it is in front but the thing happened somewhere else. Never for what is on
 * screen, never more than one per kind per 10 seconds (later ones fold into a count).
 */

export type AttentionKind = 'approval' | 'failed' | 'integration' | 'report';

export interface AttentionItem {
  kind: AttentionKind;
  /** Session the item belongs to (where "開く" goes). */
  sessionId: string | null;
  integrationId: string | null;
  title: string;
  body: string | null;
}

export interface AttentionView {
  mode: 'command' | 'focus' | 'timeline';
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
  open: (item: AttentionItem) => void;
  now?: () => number;
  windowMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/** Older events are replays (reconnect, history): they were news a while ago, not now. */
const STALE_MS = 120_000;
export const COALESCE_MS = 10_000;

const KIND_TITLE: Record<AttentionKind, (n: number) => string> = {
  approval: (n) => (n > 1 ? `承認待ちが ${n} 件あります` : '承認を求めています'),
  failed: (n) => (n > 1 ? `${n} 件の Run が失敗しました` : 'Run が失敗しました'),
  integration: (n) => (n > 1 ? `統合候補が ${n} 件レビューを待っています` : '統合候補をレビューできます'),
  report: (n) => (n > 1 ? `Orchestrator から ${n} 件の報告があります` : 'Orchestrator が報告しました'),
};

const ACTION_LABEL: Record<AttentionKind, string> = {
  approval: '確認する',
  failed: '開く',
  integration: 'レビューを開始',
  report: '報告を読む',
};

/** Whether the item is on screen right now (then it is not news). */
export function isVisible(item: AttentionItem, v: AttentionView): boolean {
  if (item.integrationId && v.reviewIntegrationId === item.integrationId) return true;
  if (v.mode === 'focus' && item.sessionId && v.focusSessionId === item.sessionId) return true;
  // The Command board shows approvals, failures and integration cards in its attention zone.
  if (v.mode === 'command' && !v.reviewIntegrationId && item.kind !== 'report') return true;
  return false;
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
    open: (item) => {
      const ui = useUi.getState();
      if (item.integrationId) ui.openIntegration(item.integrationId);
      else if (item.sessionId) ui.openSession(item.sessionId);
    },
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
  /** Last orchestrator text per run (the report is its final message). */
  const lastText = new Map<string, string>();
  const windows = new Map<string, { timer: unknown; pending: AttentionItem[] }>();

  const sessionName = (id: string | null) => {
    if (!id) return null;
    const s = deps.qc.getQueryData<Session[]>(qk.sessions)?.find((x) => x.id === id);
    return s ? untitled(s) : null;
  };

  const deliver = (channel: 'os' | 'app', items: AttentionItem[]) => {
    const first = items[0]!;
    const many = items.length > 1;
    const title = KIND_TITLE[first.kind](items.length);
    const body = many
      ? items
          .slice(0, 3)
          .map((i) => i.title)
          .join('、') + (items.length > 3 ? ' ほか' : '')
      : [first.title, first.body].filter(Boolean).join(' — ');
    if (channel === 'os') {
      deps.os({ title, body, tag: `acc-${first.kind}`, onClick: () => deps.open(first) });
    } else {
      deps.toast({
        key: `attention-${first.kind}`,
        title,
        detail: body,
        tone: first.kind === 'failed' ? 'error' : 'info',
        showDetail: true,
        // Decisions stay until handled (§8.5); a report is information.
        sticky: false,
        action: { label: many ? '次の要対応へ' : ACTION_LABEL[first.kind], run: () => deps.open(first) },
      });
    }
  };

  /** A quiet period after a notification; what arrives meanwhile is summed up at its end. */
  const openWindow = (key: string, channel: 'os' | 'app') => {
    const w = { timer: null as unknown, pending: [] as AttentionItem[] };
    windows.set(key, w);
    w.timer = setTimer(() => {
      windows.delete(key);
      if (w.pending.length === 0) return;
      deliver(channel, w.pending);
      openWindow(key, channel);
    }, windowMs);
  };

  /** First of a kind goes out now; more within the window fold into one summary. */
  const push = (channel: 'os' | 'app', item: AttentionItem) => {
    const key = `${channel}:${item.kind}`;
    const w = windows.get(key);
    if (w) {
      w.pending.push(item);
      return;
    }
    deliver(channel, [item]);
    openWindow(key, channel);
  };

  const raise = (item: AttentionItem) => {
    const v = deps.view();
    if (!deps.focused()) {
      if (v.notifyOs) push('os', item);
      return;
    }
    if (v.notifyInApp && !isVisible(item, v)) push('app', item);
  };

  const itemOf = (e: Event): AttentionItem | null => {
    switch (e.type) {
      case 'approval.requested': {
        const a = e.payload.approval;
        if (a.integrationId) return null; // integration approvals are announced as "ready"
        const where = sessionName(a.sessionId);
        return { kind: 'approval', sessionId: a.sessionId, integrationId: null, title: where ?? a.title, body: where ? a.title : null };
      }
      case 'run.failed': {
        const r = e.payload.run;
        return {
          kind: 'failed',
          sessionId: r.sessionId,
          integrationId: null,
          title: sessionName(r.sessionId) ?? 'Run',
          body: shorten(headLines(e.payload.error.message, 1), 100),
        };
      }
      case 'integration.updated': {
        const i = e.payload.integration;
        if (!e.payload.changes.includes('status') || i.status !== 'awaiting_approval') return null;
        return { kind: 'integration', sessionId: null, integrationId: i.id, title: i.title, body: null };
      }
      case 'run.completed': {
        const r = e.payload.run;
        if (r.kind !== 'orchestrator') return null;
        const text = lastText.get(r.id) ?? null;
        lastText.delete(r.id);
        return {
          kind: 'report',
          sessionId: r.sessionId,
          integrationId: null,
          title: sessionName(r.sessionId) ?? 'Orchestrator',
          body: text ? shorten(headLines(text, 2).replace(/\n/g, ' '), 140) : null,
        };
      }
      default:
        return null;
    }
  };

  return {
    handle(e: Event): void {
      if (e.type === 'message.created') {
        const m = e.payload.message;
        const text = m.content.find((p) => p.type === 'text')?.text;
        if (m.role === 'assistant' && m.runId && text?.trim()) {
          lastText.set(m.runId, text);
          if (lastText.size > 200) lastText.delete(lastText.keys().next().value!);
        }
        return;
      }
      if (now() - Date.parse(e.ts) > STALE_MS) return;
      const item = itemOf(e);
      if (item) raise(item);
    },
    dispose(): void {
      for (const w of windows.values()) clearTimer(w.timer);
      windows.clear();
    },
  };
}
