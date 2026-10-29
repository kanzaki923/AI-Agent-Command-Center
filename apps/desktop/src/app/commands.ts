import type { Approval, Run, Session } from '@acc/protocol';
import { cancelRun, respondApproval, retryRun, startConversation } from '../daemon/actions';
import { homeSnapshot } from '../daemon/home';
import { qk } from '../daemon/keys';
import type { AppRuntime } from '../daemon/runtime';
import { sessionTitle } from '../lib/states';
import { useConfirm } from '../store/confirm';
import { toast } from '../store/toast';
import { type Mode, useUi } from '../store/ui';

/**
 * App-level commands shared by shortcuts, the palette and buttons (one implementation per
 * action). They read the current state at call time instead of closing over render data.
 */

export function switchMode(_rt: AppRuntime, mode: Mode): void {
  const ui = useUi.getState();
  if (mode === 'home') ui.goHome();
  else if (mode === 'timeline') ui.openTimeline();
  else if (ui.focusSessionId) ui.openSession(ui.focusSessionId);
  else ui.openDraft();
}

/**
 * Ctrl+N: a new conversation. Nothing is created yet (spec §5.3): the draft screen opens and
 * the first send creates the session.
 */
export function newChat(_rt?: AppRuntime): void {
  useUi.getState().openDraft();
  focusComposerSoon();
}

/** Esc at the bottom of the ladder: a child conversation goes to its parent, the rest home. */
export function goUp(rt: AppRuntime): void {
  const ui = useUi.getState();
  if (ui.mode === 'session' && ui.focusSessionId) {
    const s = rt.queryClient.getQueryData<Session[]>(qk.sessions)?.find((x) => x.id === ui.focusSessionId);
    if (s?.parentSessionId) {
      ui.openSession(s.parentSessionId);
      return;
    }
  }
  ui.goHome();
}

/**
 * Ctrl+J / the title bar's ✋N: the home screen with the next attention item selected (the
 * first one when nothing there is selected yet).
 */
export function goToAttention(rt: AppRuntime, dir: 1 | -1 = 1): string | null {
  const ui = useUi.getState();
  const items = homeSnapshot(rt)?.attention ?? [];
  if (items.length === 0) {
    toast({ title: '出番はありません', tone: 'info', sticky: false, key: 'no-attention' });
    return null;
  }
  const at = ui.mode === 'home' ? items.findIndex((a) => a.id === ui.selectedId) : -1;
  const next = at === -1 ? (dir === 1 ? items[0]! : items[items.length - 1]!) : items[(at + dir + items.length) % items.length]!;
  if (ui.mode !== 'home' || ui.reviewIntegrationId) ui.goHome();
  ui.select(next.id, true);
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-attention-row="${CSS.escape(next.id)}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
  });
  return next.id;
}

export function focusComposerSoon(): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>('[data-composer-input]')?.focus();
  });
}

export async function approve(
  rt: AppRuntime,
  approval: Approval,
  remember?: 'run' | 'task' | 'project',
): Promise<void> {
  await respondApproval(rt, approval, 'approve', undefined, remember ?? 'once');
}

export async function reject(rt: AppRuntime, approval: Approval, note?: string): Promise<void> {
  await respondApproval(rt, approval, 'reject', note);
}

/**
 * Stop a run. Chat runs stop immediately; an agent's run asks first, since stopping loses
 * what it was in the middle of.
 */
export async function stop(rt: AppRuntime, run: Run): Promise<void> {
  if (run.kind === 'chat') {
    await cancelRun(rt, run);
    return;
  }
  const session = rt.queryClient.getQueryData<Session[]>(qk.sessions)?.find((s) => s.id === run.sessionId);
  useConfirm.getState().ask({
    title: `「${session ? sessionTitle(session) : '作業'}」を止めますか？`,
    body: 'あとで再開できます。',
    confirmLabel: '止める',
    onConfirm: () => void cancelRun(rt, run),
  });
}

export async function retry(rt: AppRuntime, run: Run): Promise<void> {
  await retryRun(rt, run);
}

/**
 * Palette "AI に頼む": the sentence becomes the first message of a new conversation, which
 * opens (GUI and natural language reach the same features, concept §3.2).
 */
export async function askAi(rt: AppRuntime, text: string): Promise<void> {
  const ui = useUi.getState();
  const s = await startConversation(rt, { text, projectId: ui.projectId });
  if (s) ui.openSession(s.id);
}
