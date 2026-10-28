import type { AccClient, Subscription } from '@acc/client';
import {
  type Approval,
  type Event,
  type Integration,
  type Message,
  type Project,
  type Run,
  type Session,
  type Task,
  type Workspace,
  isTerminalRunStatus,
} from '@acc/protocol';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { describeTool } from '../lib/tools';
import type { ActivityStore } from './activity';
import type { DeltaStore } from './deltas';
import type { EventLog } from './eventLog';
import type { RecentStore } from './recent';
import { qk } from './keys';

/** A message as the UI holds it: persisted, or optimistic (sent from this window). */
export type ChatMessage = Message & {
  /** Optimistic state; absent for persisted messages. */
  local?: { status: 'sending' | 'failed'; text: string; error?: string };
};

export interface Streams {
  deltas: DeltaStore;
  activity: ActivityStore;
  events: EventLog;
  recent: RecentStore;
}

type Entity = { id: string };

/** Upsert into a cached collection. No-op while the collection was never fetched. */
export function upsertIn<T extends Entity>(
  qc: QueryClient,
  key: QueryKey,
  entity: T,
  compare?: (a: T, b: T) => number,
): void {
  qc.setQueryData<T[]>(key, (cur) => {
    if (!cur) return cur;
    const i = cur.findIndex((x) => x.id === entity.id);
    const next = i === -1 ? [entity, ...cur] : cur.map((x, j) => (j === i ? entity : x));
    return compare ? [...next].sort(compare) : next;
  });
}

export function patchIn<T extends Entity>(
  qc: QueryClient,
  key: QueryKey,
  id: string,
  fn: (cur: T) => T,
): void {
  qc.setQueryData<T[]>(key, (cur) => {
    if (!cur) return cur;
    let hit = false;
    const next = cur.map((x) => {
      if (x.id !== id) return x;
      hit = true;
      return fn(x);
    });
    return hit ? next : cur;
  });
}

export function removeFrom<T extends Entity>(qc: QueryClient, key: QueryKey, id: string): void {
  qc.setQueryData<T[]>(key, (cur) => (cur ? cur.filter((x) => x.id !== id) : cur));
}

const byActivityDesc = (a: Session, b: Session) => b.lastActivityAt.localeCompare(a.lastActivityAt);
const byCreatedDesc = (a: { createdAt: string }, b: { createdAt: string }) =>
  b.createdAt.localeCompare(a.createdAt);

function bumpSession(qc: QueryClient, sessionId: string, ts: string): void {
  qc.setQueryData<Session[]>(qk.sessions, (cur) => {
    if (!cur) return cur;
    const next = cur.map((s) =>
      s.id === sessionId && s.lastActivityAt < ts ? { ...s, lastActivityAt: ts } : s,
    );
    return next.sort(byActivityDesc);
  });
}

function setRun(qc: QueryClient, run: Run): void {
  upsertIn<Run>(qc, qk.runs, run, byCreatedDesc);
  qc.setQueryData(qk.run(run.id), run);
  // Keep session.activeRunId consistent even if session.updated arrives later.
  patchIn<Session>(qc, qk.sessions, run.sessionId, (s) => {
    if (!isTerminalRunStatus(run.status)) return s.activeRunId === run.id ? s : { ...s, activeRunId: run.id };
    return s.activeRunId === run.id ? { ...s, activeRunId: null } : s;
  });
}

/**
 * Apply one daemon event to the query cache and live stores. Pure with respect to its
 * inputs (no network), so it is unit tested directly.
 */
export function applyEvent(qc: QueryClient, streams: Streams, event: Event): void {
  streams.events.add(event);
  switch (event.type) {
    case 'project.created':
    case 'project.updated':
      upsertIn<Project>(qc, qk.projects, event.payload.project, byCreatedDesc);
      return;

    case 'session.created':
    case 'session.updated':
      upsertIn<Session>(qc, qk.sessions, event.payload.session, byActivityDesc);
      qc.setQueryData(['session.get', event.payload.session.id], event.payload.session);
      return;
    case 'session.archived':
      if (event.payload.archived) removeFrom(qc, qk.sessions, event.payload.sessionId);
      else void qc.invalidateQueries({ queryKey: qk.sessions });
      return;

    case 'message.created': {
      const m = event.payload.message;
      streams.deltas.finishMessage(m.id);
      qc.setQueryData<ChatMessage[]>(qk.messages(m.sessionId), (cur) => {
        if (!cur) return cur;
        if (cur.some((x) => x.id === m.id)) return cur.map((x) => (x.id === m.id ? m : x));
        // Replace the optimistic copy of a message this window sent.
        const text = m.content.find((p) => p.type === 'text')?.text;
        const i =
          m.role === 'user' && m.author.kind === 'human'
            ? cur.findIndex((x) => x.local?.status === 'sending' && x.local.text === text)
            : -1;
        if (i !== -1) return cur.map((x, j) => (j === i ? m : x));
        return [...cur, m];
      });
      bumpSession(qc, m.sessionId, m.createdAt);
      if (m.role === 'assistant' && m.runId) {
        const call = m.content.find((p) => p.type === 'tool_call');
        if (!call) streams.activity.set(m.runId, null);
      }
      return;
    }

    case 'run.created':
      setRun(qc, event.payload.run);
      return;
    case 'run.status_changed': {
      const { runId, to, reason } = event.payload;
      const patch = (r: Run): Run => ({
        ...r,
        status: to,
        statusReason: reason,
        updatedAt: event.ts,
        startedAt: r.startedAt ?? (to === 'running' ? event.ts : null),
        endedAt: isTerminalRunStatus(to) ? (r.endedAt ?? event.ts) : r.endedAt,
      });
      patchIn<Run>(qc, qk.runs, runId, patch);
      qc.setQueryData<Run>(qk.run(runId), (r) => (r ? patch(r) : r));
      if (to === 'awaiting_approval') streams.activity.set(runId, '承認を待っています');
      if (to === 'completed') streams.recent.completed(runId);
      if (to === 'failed') streams.recent.failed(runId);
      if (isTerminalRunStatus(to)) {
        streams.deltas.finishRun(runId);
        streams.activity.set(runId, null);
        const run = qc.getQueryData<Run[]>(qk.runs)?.find((r) => r.id === runId);
        if (run) setRun(qc, patch(run));
      }
      return;
    }
    case 'run.updated': {
      const run = event.payload.run;
      setRun(qc, run);
      // The executor's own "what is it doing" line (RunController.setActivity).
      if (event.payload.changes.includes('activity') && !isTerminalRunStatus(run.status)) {
        streams.activity.set(run.id, run.activity ?? null);
      }
      return;
    }
    case 'run.completed':
    case 'run.failed':
      if (event.type === 'run.completed') streams.recent.completed(event.payload.run.id);
      else streams.recent.failed(event.payload.run.id);
      streams.deltas.finishRun(event.payload.run.id);
      streams.activity.set(event.payload.run.id, null);
      setRun(qc, event.payload.run);
      return;

    case 'tool.called':
      streams.activity.set(
        event.payload.runId,
        describeTool(event.payload.name, event.payload.input).activity,
      );
      return;
    case 'tool.result':
      return;

    case 'approval.requested':
      upsertIn<Approval>(qc, qk.approvals, event.payload.approval, (a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
      if (event.payload.approval.runId)
        streams.activity.set(event.payload.approval.runId, '承認を待っています');
      return;
    case 'approval.resolved': {
      const a = event.payload.approval;
      removeFrom(qc, qk.approvals, a.id);
      qc.setQueryData<Approval[]>(qk.resolvedApprovals, (cur) => [
        a,
        ...(cur ?? []).filter((x) => x.id !== a.id),
      ]);
      return;
    }

    case 'task.created':
    case 'task.updated':
      upsertIn<Task>(qc, qk.tasks, event.payload.task, byCreatedDesc);
      return;

    case 'workspace.created':
    case 'workspace.updated':
      upsertIn<Workspace>(qc, qk.workspaces, event.payload.workspace, byCreatedDesc);
      qc.setQueryData(qk.workspace(event.payload.workspace.id), event.payload.workspace);
      void qc.invalidateQueries({ queryKey: qk.diff(event.payload.workspace.id) });
      return;
    case 'workspace.removed':
      removeFrom(qc, qk.workspaces, event.payload.workspaceId);
      return;

    case 'artifact.created': {
      const art = event.payload.artifact;
      void qc.invalidateQueries({ queryKey: ['artifact.list'] });
      if (art.workspaceId) void qc.invalidateQueries({ queryKey: qk.diff(art.workspaceId) });
      return;
    }

    case 'integration.created':
    case 'integration.updated':
      upsertIn<Integration>(qc, qk.integrations, event.payload.integration, byCreatedDesc);
      return;

    case 'grant.created':
    case 'grant.revoked':
      void qc.invalidateQueries({ queryKey: ['grant.list'] });
      return;
    case 'policy.denied':
      return;

    case 'budget.updated':
      void qc.invalidateQueries({ queryKey: ['budget.get'] });
      return;

    case 'settings.updated':
      void qc.invalidateQueries({ queryKey: qk.settings });
      void qc.invalidateQueries({ queryKey: qk.models });
      return;

    case 'orchestrator.decision':
      return;
    default: {
      // A new event type must be handled (or deliberately ignored) above.
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/**
 * run.interrupted usually arrives in bulk (daemon restart): no per-row emphasis, one
 * summary toast instead (§3.2).
 */
export function createInterruptNotifier(notify: (count: number) => void, windowMs = 400) {
  let count = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (e: Event) => {
    if (e.type !== 'run.status_changed' || e.payload.to !== 'interrupted') return;
    count++;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      notify(count);
      count = 0;
      timer = null;
    }, windowMs);
  };
}

/**
 * The single live subscription of the app. Events patch the cache; deltas go to the
 * streaming store. On reconnect the client replays missed events by seq, and we also
 * refetch everything once so lists that were never patched catch up.
 */
export function startSync(
  client: AccClient,
  qc: QueryClient,
  streams: Streams,
  onInterrupted: (count: number) => void = () => {},
): () => void {
  const interrupted = createInterruptNotifier(onInterrupted);
  let sub: Subscription | null = client.subscribe({
    deltas: true,
    onEvent: (e) => {
      applyEvent(qc, streams, e);
      interrupted(e);
    },
    onDelta: (d) => {
      streams.deltas.push(d);
      streams.activity.set(d.runId, '回答を生成中');
    },
    onError: (err) => console.warn('[acc] event subscription error', err),
  });
  let wasDown = false;
  const off = client.onStateChange((s) => {
    if (s === 'reconnecting') wasDown = true;
    if (s === 'open' && wasDown) {
      wasDown = false;
      void qc.invalidateQueries();
    }
  });
  return () => {
    off();
    sub?.unsubscribe();
    sub = null;
  };
}
