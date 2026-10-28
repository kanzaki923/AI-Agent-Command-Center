import type { Approval, Run, Session, SessionKind } from '@acc/protocol';
import { toast, toastError } from '../store/toast';
import { qk } from './keys';
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
    });
    return true;
  } catch (err) {
    upsertIn(qc, qk.approvals, approval, (a, b) => a.createdAt.localeCompare(b.createdAt));
    qc.setQueryData<Approval[]>(qk.resolvedApprovals, (cur) => cur?.filter((x) => x.id !== approval.id));
    toastError(err, decision === 'approve' ? '承認できませんでした' : '拒否できませんでした');
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
    local: { status: 'sending', text },
  };
}

/** Optimistic send: the message shows in the same frame; failures keep the text (§6). */
export async function sendMessage(
  rt: AppRuntime,
  sessionId: string,
  text: string,
  opts: { model?: string | null; reuseLocalId?: string } = {},
): Promise<boolean> {
  const qc = rt.queryClient;
  const key = qk.messages(sessionId);
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
    });
    qc.setQueryData<ChatMessage[]>(key, (cur) => {
      if (!cur) return cur;
      // message.created may already have replaced the optimistic copy.
      if (cur.some((m) => m.id === res.messageId)) return cur.filter((m) => m.id !== msg.id);
      return cur.map((m) =>
        m.id === msg.id ? { ...m, id: res.messageId, runId: res.runId, local: undefined } : m,
      );
    });
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

export async function createSession(
  rt: AppRuntime,
  input: { projectId?: string | null; kind?: SessionKind; title?: string; model?: string | null },
): Promise<Session | null> {
  try {
    const s = await rt.client.call('session.create', {
      kind: input.kind ?? 'chat',
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.model ? { model: input.model } : {}),
    });
    upsertIn(rt.queryClient, qk.sessions, s, (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    rt.queryClient.setQueryData<ChatMessage[]>(qk.messages(s.id), (cur) => cur ?? []);
    return s;
  } catch (err) {
    toastError(err, 'セッションを作成できませんでした');
    return null;
  }
}

/**
 * "このTaskを実行": start a worker for the task (worktree + agent session + run). The same
 * Control API method an orchestrator uses. Returns the worker session id.
 */
export async function runTask(rt: AppRuntime, taskId: string): Promise<string | null> {
  try {
    const r = await rt.client.call('task.spawnWorker', { taskId });
    return r.sessionId;
  } catch (err) {
    toastError(err, 'Task を実行できませんでした');
    return null;
  }
}

/**
 * "Orchestrator にする": give this chat the orchestrator preset for its project (concept
 * §3.1). Run lifetime: the next message runs as an orchestrator, then it is a chat again.
 */
export async function makeOrchestrator(rt: AppRuntime, session: Session): Promise<boolean> {
  try {
    await rt.client.call('session.grantOrchestration', { sessionId: session.id, lifetime: 'run' });
    await rt.queryClient.invalidateQueries({ queryKey: qk.grants(session.id) });
    toast({ title: '次のメッセージは Orchestrator として実行されます', tone: 'success', sticky: false });
    return true;
  } catch (err) {
    toastError(err, 'Orchestrator にできませんでした');
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

export async function retryRun(rt: AppRuntime, run: Run): Promise<void> {
  try {
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
      title: `「${session.title || 'セッション'}」をアーカイブしました`,
      tone: 'info',
      sticky: false,
      action: {
        label: '元に戻す',
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
