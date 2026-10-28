import type { Approval, Integration, Run, Session, Task } from '@acc/protocol';
import { cancelRun, createSession, respondApproval, retryRun, sendMessage } from '../daemon/actions';
import { qk } from '../daemon/keys';
import { cancelTask } from '../daemon/orchestration';
import type { AppRuntime } from '../daemon/runtime';
import { type BoardItem, buildBoard, nextAttention, roleOf, untitled } from '../model/board';
import { useConfirm } from '../store/confirm';
import { toast } from '../store/toast';
import { type Mode, useUi } from '../store/ui';

/**
 * App-level commands shared by shortcuts, the palette and buttons (one implementation per
 * action). They read the current state at call time instead of closing over render data.
 */

export function currentBoard(rt: AppRuntime): BoardItem[] {
  const qc = rt.queryClient;
  return buildBoard({
    sessions: qc.getQueryData<Session[]>(qk.sessions) ?? [],
    runs: qc.getQueryData<Run[]>(qk.runs) ?? [],
    approvals: qc.getQueryData<Approval[]>(qk.approvals) ?? [],
    tasks: qc.getQueryData<Task[]>(qk.tasks) ?? [],
    integrations: qc.getQueryData<Integration[]>(qk.integrations) ?? [],
    projectId: useUi.getState().projectId,
  });
}

export function switchMode(rt: AppRuntime, mode: Mode): void {
  const ui = useUi.getState();
  if (mode === 'focus' && !ui.focusSessionId) {
    // Nothing focused yet: take the selection, else the most recent session.
    const target = ui.selectedId ?? rt.queryClient.getQueryData<Session[]>(qk.sessions)?.[0]?.id;
    if (target && target.startsWith('ses_')) {
      ui.openSession(target);
      return;
    }
  }
  ui.setMode(mode);
}

export async function newChat(rt: AppRuntime, opts: { kind?: 'chat' | 'agent' } = {}): Promise<Session | null> {
  const ui = useUi.getState();
  const s = await createSession(rt, { projectId: ui.projectId, kind: opts.kind ?? 'chat' });
  if (s) {
    ui.openSession(s.id);
    focusComposerSoon();
  }
  return s;
}

/** Ctrl+J / Ctrl+Shift+J: move to the next item that needs a human (§7.2). */
export function goToAttention(
  rt: AppRuntime,
  dir: 1 | -1 = 1,
  only?: BoardItem['state'],
): BoardItem | null {
  const ui = useUi.getState();
  const all = currentBoard(rt);
  const items = only ? all.filter((i) => i.state === only) : all;
  const target = nextAttention(items, ui.selectedId, dir);
  if (!target) {
    toast({
      title: only === 'awaiting_approval' ? '承認待ちはありません' : '要対応の項目はありません',
      tone: 'info',
      sticky: false,
      key: 'no-attention',
    });
    return null;
  }
  ui.select(target.id, true);
  // The attention cards live in the agent view of the Command board.
  if (ui.commandView !== 'agents') ui.setCommandView('agents');
  if (ui.mode !== 'command' || ui.reviewIntegrationId) ui.setMode('command');
  // Land on the approval card itself so Y / N work immediately.
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-board-item="${CSS.escape(target.id)}"]`);
    el?.focus({ preventScroll: false });
    el?.scrollIntoView({ block: 'nearest' });
  });
  return target;
}

export function focusComposerSoon(): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>('[data-composer-input]')?.focus();
  });
}

export async function approve(rt: AppRuntime, approval: Approval): Promise<void> {
  await respondApproval(rt, approval, 'approve');
}

export async function reject(rt: AppRuntime, approval: Approval, note?: string): Promise<void> {
  await respondApproval(rt, approval, 'reject', note);
}

/**
 * Stop a run. Chat runs stop immediately; agent / orchestrator runs ask first (§9.3), since
 * stopping loses in-flight work context.
 */
export async function stop(rt: AppRuntime, run: Run): Promise<void> {
  if (run.kind === 'chat') {
    await cancelRun(rt, run);
    return;
  }
  const session = rt.queryClient.getQueryData<Session[]>(qk.sessions)?.find((s) => s.id === run.sessionId);
  const name = session ? `${roleOf(session, run)} · ${untitled(session)}` : 'この Run';
  useConfirm.getState().ask({
    title: `${name} を停止しますか？`,
    body: '作業内容は worktree に残ります。あとで再開できます。',
    confirmLabel: '停止する',
    onConfirm: () => void cancelRun(rt, run),
  });
}

/** "Task を中止" asks first: running workers stop with it (§9.3 wording). */
export function confirmCancelTask(rt: AppRuntime, task: Task): void {
  useConfirm.getState().ask({
    title: `Task「${task.title}」を中止しますか？`,
    body:
      task.status === 'running'
        ? '動いている Worker も停止します。worktree とブランチはそのまま残ります。'
        : 'この Task に依存する Task は進めなくなります。worktree とブランチはそのまま残ります。',
    confirmLabel: '中止する',
    danger: true,
    onConfirm: () => void cancelTask(rt, task),
  });
}

export async function retry(rt: AppRuntime, run: Run): Promise<void> {
  await retryRun(rt, run);
}

/**
 * Palette "AI に頼む": send the sentence to a chat (the focused chat, else the most recent
 * chat, else a new one) so GUI and natural language reach the same features (concept §3.2).
 */
export async function askAi(rt: AppRuntime, text: string): Promise<void> {
  const ui = useUi.getState();
  const sessions = rt.queryClient.getQueryData<Session[]>(qk.sessions) ?? [];
  const focused = sessions.find((s) => s.id === ui.focusSessionId && s.kind === 'chat');
  const recent = sessions.find((s) => s.kind === 'chat' && !s.archivedAt);
  let target: Session | null = focused ?? recent ?? null;
  if (!target) target = await createSession(rt, { projectId: ui.projectId, kind: 'chat' });
  if (!target) return;
  ui.openSession(target.id);
  await sendMessage(rt, target.id, text);
}
