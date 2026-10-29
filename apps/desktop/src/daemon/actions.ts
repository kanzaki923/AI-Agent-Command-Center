import {
  type Approval,
  type ApprovalRemember,
  type ParamsInput,
  type PermissionRule,
  type Run,
  type SendDelivery,
  type Session,
  type SessionKind,
  type WorkspaceSpec,
  isTerminalRunStatus,
} from '@acc/protocol';
import { toast, toastError } from '../store/toast';
import { useUi } from '../store/ui';
import { qk } from './keys';
import { messagesQuery } from './queries';
import type { AppRuntime } from './runtime';
import { type ChatMessage, patchIn, removeFrom, upsertIn } from './sync';

/**
 * User operations. All optimistic where it is safe (§1.2: visual response within 16ms),
 * reconciled by the event stream, and reverted with a toast on failure.
 */

export async function respondApproval(
  rt: AppRuntime,
  approval: Approval,
  decision: 'approve' | 'reject',
  note?: string,
  /** Approving a tool use: also allow matching uses for the rest of the run / task / project. */
  remember: ApprovalRemember = 'once',
): Promise<boolean> {
  const qc = rt.queryClient;
  const resolved: Approval = {
    ...approval,
    status: decision === 'approve' ? 'approved' : 'rejected',
    resolvedBy: { kind: 'human', client: 'desktop' },
    resolvedAt: new Date().toISOString(),
    resolutionNote: note ?? null,
  };
  removeFrom(qc, qk.approvals, approval.id);
  qc.setQueryData<Approval[]>(qk.resolvedApprovals, (cur) => [resolved, ...(cur ?? [])]);
  try {
    await rt.client.call('approval.respond', {
      approvalId: approval.id,
      decision,
      ...(note ? { note } : {}),
      ...(decision === 'approve' && remember !== 'once' ? { remember } : {}),
    });
    return true;
  } catch (err) {
    upsertIn(qc, qk.approvals, approval, (a, b) => a.createdAt.localeCompare(b.createdAt));
    qc.setQueryData<Approval[]>(qk.resolvedApprovals, (cur) => cur?.filter((x) => x.id !== approval.id));
    toastError(err, decision === 'approve' ? '承認できませんでした' : '拒否できませんでした');
    return false;
  }
}

/** Revoke a remembered approval (optimistic: it leaves the list at once). */
export async function revokePermissionRule(rt: AppRuntime, rule: PermissionRule): Promise<boolean> {
  const qc = rt.queryClient;
  const key = qk.permissionRules(rule.projectId);
  removeFrom(qc, key, rule.id);
  try {
    await rt.client.call('permissionRule.revoke', { ruleId: rule.id });
    return true;
  } catch (err) {
    upsertIn(qc, key, rule, (a, b) => b.createdAt.localeCompare(a.createdAt));
    toastError(err, '取り消せませんでした');
    return false;
  }
}

let localSeq = 0;

function optimisticMessage(sessionId: string, text: string): ChatMessage {
  localSeq++;
  return {
    id: `local_${Date.now().toString(36)}_${localSeq}`,
    sessionId,
    runId: null,
    role: 'user',
    content: [{ type: 'text', text }],
    author: { kind: 'human', client: 'desktop' },
    model: null,
    createdAt: new Date().toISOString(),
    delivery: 'delivered',
    meta: null,
    usage: null,
    local: { status: 'sending', text },
  };
}

/** Optimistic send: the message shows in the same frame; failures keep the text (§6). */
export async function sendMessage(
  rt: AppRuntime,
  sessionId: string,
  text: string,
  opts: {
    model?: string | null;
    reuseLocalId?: string;
    /** Agent run in progress: stop at the next step and take this message now. */
    interrupt?: boolean;
    /** How the daemon handed it over (started / queued after the run / injected at a boundary). */
    onDelivery?: (delivery: SendDelivery) => void;
  } = {},
): Promise<boolean> {
  const qc = rt.queryClient;
  const key = qk.messages(sessionId);
  // Never loaded (e.g. "AI に頼む" into a chat not opened yet): load the history first. A
  // cache entry holding only the new message would look fresh (staleTime: Infinity) and the
  // chat would never fetch what came before.
  if (qc.getQueryState(key)?.status !== 'success') {
    await qc.ensureQueryData(messagesQuery(rt, sessionId)).catch(() => undefined);
  }
  let msg: ChatMessage;
  if (opts.reuseLocalId) {
    msg = { ...optimisticMessage(sessionId, text), id: opts.reuseLocalId };
    qc.setQueryData<ChatMessage[]>(key, (cur) =>
      (cur ?? []).map((m) => (m.id === opts.reuseLocalId ? msg : m)),
    );
  } else {
    msg = optimisticMessage(sessionId, text);
    qc.setQueryData<ChatMessage[]>(key, (cur) => [...(cur ?? []), msg]);
  }
  try {
    const res = await rt.client.call('session.send', {
      sessionId,
      content: text,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.interrupt ? { interrupt: true } : {}),
    });
    const delivery = res.delivery === 'queued' ? 'queued' : 'delivered';
    qc.setQueryData<ChatMessage[]>(key, (cur) => {
      if (!cur) return cur;
      // message.created may already have replaced the optimistic copy.
      if (cur.some((m) => m.id === res.messageId)) return cur.filter((m) => m.id !== msg.id);
      return cur.map((m) =>
        m.id === msg.id ? { ...m, id: res.messageId, runId: res.runId, delivery, local: undefined } : m,
      );
    });
    opts.onDelivery?.(res.delivery);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    qc.setQueryData<ChatMessage[]>(key, (cur) =>
      cur?.map((m) =>
        m.id === msg.id ? { ...m, local: { status: 'failed', text, error: reason } } : m,
      ),
    );
    return false;
  }
}

/**
 * Edit-and-resend of the last unanswered message (↑ in an empty composer, §6). The daemon
 * keeps history immutable, so the original stays (folded as 「編集前」 in this window) and
 * the edited text is sent as a new message. A chat run the original started and that is
 * still going is stopped first, so the answer belongs to the edited text.
 */
export async function resendEdited(
  rt: AppRuntime,
  sessionId: string,
  original: ChatMessage,
  text: string,
): Promise<boolean> {
  const qc = rt.queryClient;
  if (original.local?.status === 'failed') {
    return sendMessage(rt, sessionId, text, { reuseLocalId: original.id });
  }
  const runs = qc.getQueryData<Run[]>(qk.runs) ?? [];
  const run =
    runs.find((r) => r.triggerMessageId === original.id) ??
    (original.runId ? runs.find((r) => r.id === original.runId) : undefined);
  if (run && !isTerminalRunStatus(run.status)) {
    try {
      await rt.client.call('run.cancel', { runId: run.id, reason: 'メッセージを編集して送り直しました' });
    } catch (err) {
      toastError(err, '送り直せませんでした');
      return false;
    }
  }
  useUi.getState().markSuperseded(original.id);
  return sendMessage(rt, sessionId, text);
}

export async function createSession(
  rt: AppRuntime,
  input: {
    projectId?: string | null;
    kind?: SessionKind;
    title?: string;
    model?: string | null;
    workspace?: WorkspaceSpec;
  },
): Promise<Session | null> {
  try {
    const s = await rt.client.call('session.create', {
      kind: input.kind ?? 'chat',
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.workspace ? { workspace: input.workspace } : {}),
    });
    upsertIn(rt.queryClient, qk.sessions, s, (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    rt.queryClient.setQueryData<ChatMessage[]>(qk.messages(s.id), (cur) => cur ?? []);
    return s;
  } catch (err) {
    toastError(err, '会話を作れませんでした');
    return null;
  }
}

/**
 * A new conversation from its first message (home input, the Ctrl+N draft): create it, give
 * it to the AI to lead when asked (`delegate`), then send. The session is created only here,
 * at the first send (spec §5.3). Returns the session (null when creating failed).
 */
export async function startConversation(
  rt: AppRuntime,
  input: {
    text: string;
    projectId?: string | null;
    /** Where it works: nothing (default), a folder, or the project's code (an agent session). */
    workspace?: WorkspaceSpec;
    /** Start delegated (it leads children on its own) with the daemon's defaults. */
    delegate?: boolean;
    model?: string | null;
  },
): Promise<Session | null> {
  const workspace = input.workspace && input.workspace.kind !== 'none' ? input.workspace : undefined;
  const s = await createSession(rt, {
    kind: workspace ? 'agent' : 'chat',
    projectId: input.projectId ?? null,
    model: input.model ?? null,
    ...(workspace ? { workspace } : {}),
  });
  if (!s) return null;
  if (input.delegate) await delegateSession(rt, s.id);
  await sendMessage(rt, s.id, input.text, { model: input.model ?? null });
  void rt.queryClient.invalidateQueries({ queryKey: qk.home });
  return s;
}

/** Let a session lead other agents ("任せる"), with the daemon's defaults unless given. */
export async function delegateSession(
  rt: AppRuntime,
  sessionId: string,
  opts: Omit<ParamsInput<'session.delegate'>, 'sessionId'> = {},
): Promise<boolean> {
  try {
    await rt.client.call('session.delegate', { sessionId, ...opts });
    void rt.queryClient.invalidateQueries({ queryKey: qk.grants(sessionId) });
    return true;
  } catch (err) {
    toastError(err, '任せられませんでした');
    return false;
  }
}

/** Take the lead back ("任せるのをやめる"). */
export async function undelegateSession(rt: AppRuntime, sessionId: string): Promise<boolean> {
  try {
    await rt.client.call('session.undelegate', { sessionId });
    void rt.queryClient.invalidateQueries({ queryKey: qk.grants(sessionId) });
    return true;
  } catch (err) {
    toastError(err, '元に戻せませんでした');
    return false;
  }
}

/** Stop a session and (by default) everything still working under it. Resumable. */
export async function stopTree(rt: AppRuntime, sessionId: string, tree = true): Promise<boolean> {
  try {
    await rt.client.call('session.stop', { sessionId, tree });
    return true;
  } catch (err) {
    toastError(err, '止められませんでした');
    return false;
  }
}

/** Resume a stopped session (and its stopped descendants). */
export async function resumeTree(rt: AppRuntime, sessionId: string, tree = true): Promise<boolean> {
  try {
    await rt.client.call('session.resume', { sessionId, tree });
    return true;
  } catch (err) {
    toastError(err, '再開できませんでした');
    return false;
  }
}

export async function cancelRun(rt: AppRuntime, run: Run): Promise<void> {
  try {
    await rt.client.call('run.cancel', { runId: run.id });
  } catch (err) {
    toastError(err, '停止できませんでした');
  }
}

/**
 * Retry / resume a run. A worker's run goes through its task (`task.retry`): the task moves
 * back to running with the new run, so finishing it lands the task in review as usual —
 * run.retry would start a run the task does not know about (it stays ready / failed).
 */
export async function retryRun(rt: AppRuntime, run: Run): Promise<void> {
  try {
    if (run.kind === 'agent' && run.taskId) {
      await rt.client.call('task.retry', { taskId: run.taskId });
      return;
    }
    await rt.client.call('run.retry', { runId: run.id });
  } catch (err) {
    toastError(err, '再試行できませんでした');
  }
}

export async function renameSession(rt: AppRuntime, session: Session, title: string): Promise<void> {
  const prev = session.title;
  patchIn<Session>(rt.queryClient, qk.sessions, session.id, (s) => ({ ...s, title }));
  try {
    await rt.client.call('session.update', { sessionId: session.id, title });
  } catch (err) {
    patchIn<Session>(rt.queryClient, qk.sessions, session.id, (s) => ({ ...s, title: prev }));
    toastError(err, '名前を変更できませんでした');
  }
}

/** Optimistic model switch; rolled back when the daemon refuses (it would run the old one). */
export async function setSessionModel(rt: AppRuntime, session: Session, model: string): Promise<void> {
  const prev = session.model;
  patchIn<Session>(rt.queryClient, qk.sessions, session.id, (s) => ({ ...s, model }));
  try {
    await rt.client.call('session.update', { sessionId: session.id, model });
  } catch (err) {
    patchIn<Session>(rt.queryClient, qk.sessions, session.id, (s) =>
      s.model === model ? { ...s, model: prev } : s,
    );
    toastError(err, 'モデルを変更できませんでした');
  }
}

export async function setPinned(rt: AppRuntime, session: Session, pinned: boolean): Promise<void> {
  patchIn<Session>(rt.queryClient, qk.sessions, session.id, (s) => ({ ...s, pinned }));
  try {
    await rt.client.call('session.update', { sessionId: session.id, pinned });
  } catch (err) {
    patchIn<Session>(rt.queryClient, qk.sessions, session.id, (s) => ({ ...s, pinned: !pinned }));
    toastError(err);
  }
}

/** Archive with a 5s undo toast (§8.5). */
export async function archiveSession(rt: AppRuntime, session: Session): Promise<void> {
  removeFrom(rt.queryClient, qk.sessions, session.id);
  try {
    await rt.client.call('session.archive', { sessionId: session.id, archived: true });
    toast({
      title: `「${session.title || '会話'}」をアーカイブしました`,
      tone: 'info',
      sticky: false,
      action: {
        label: '元に戻す',
        undo: true,
        run: () => {
          void rt.client
            .call('session.archive', { sessionId: session.id, archived: false })
            .then((s) =>
              upsertIn(rt.queryClient, qk.sessions, s, (a, b) =>
                b.lastActivityAt.localeCompare(a.lastActivityAt),
              ),
            )
            .catch((err: unknown) => toastError(err));
        },
      },
    });
  } catch (err) {
    upsertIn(rt.queryClient, qk.sessions, session);
    toastError(err, 'アーカイブできませんでした');
  }
}
