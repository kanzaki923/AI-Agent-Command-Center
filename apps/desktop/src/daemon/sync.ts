import type { AccClient, Subscription } from '@acc/client';
import {
  type Approval,
  type Artifact,
  type BudgetAllocation,
  type CapabilityGrant,
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
import { type QueryClient, type QueryKey, notifyManager } from '@tanstack/react-query';
import { type ToolLookup, describeTool } from '../lib/tools';
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
const byCreatedAsc = (a: { createdAt: string }, b: { createdAt: string }) =>
  a.createdAt.localeCompare(b.createdAt);

/** `budget.get` result as cached under qk.budget(id). */
export interface BudgetNode {
  budget: BudgetAllocation;
  children: BudgetAllocation[];
}

/** The session a grant shows up on: its subject session, or the session of its subject run. */
export function grantSessionId(qc: QueryClient, g: CapabilityGrant): string | null {
  if (g.subject.kind === 'session') return g.subject.sessionId;
  const { runId } = g.subject;
  const run = qc.getQueryData<Run>(qk.run(runId)) ?? qc.getQueryData<Run[]>(qk.runs)?.find((r) => r.id === runId);
  return run?.sessionId ?? null;
}

/** Task titles from the cache, so tool calls name their task (`Worker を起動: 「…」`). */
export function taskLookup(qc: QueryClient): ToolLookup {
  return {
    taskTitle: (id) => qc.getQueryData<Task[]>(qk.tasks)?.find((t) => t.id === id)?.title,
  };
}

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
        describeTool(event.payload.name, event.payload.input, taskLookup(qc)).activity,
      );
      return;
    case 'tool.result':
      return;

    case 'tool.decided':
      // A denial is what the agent is reacting to right now: show it on its activity line
      // (the Timeline keeps every decision).
      if (event.runId && event.payload.decision === 'denied') {
        streams.activity.set(event.runId, `規則で拒否しました（${event.payload.toolName}）`);
      }
      return;

    case 'permission.rule_created':
    case 'permission.rule_revoked':
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
      // Patch the lists the UI keeps (per session and per project); others refetch lazily.
      if (art.sessionId) upsertIn<Artifact>(qc, qk.artifacts(art.sessionId, art.kind), art, byCreatedDesc);
      if (art.projectId) upsertIn<Artifact>(qc, qk.projectArtifacts(art.projectId, art.kind), art, byCreatedDesc);
      upsertIn<Artifact>(qc, qk.projectArtifacts('', art.kind), art, byCreatedDesc);
      qc.setQueryData(qk.artifact(art.id), art);
      if (art.workspaceId) void qc.invalidateQueries({ queryKey: qk.diff(art.workspaceId) });
      return;
    }

    case 'integration.created':
    case 'integration.updated':
      upsertIn<Integration>(qc, qk.integrations, event.payload.integration, byCreatedDesc);
      qc.setQueryData(['integration.get', event.payload.integration.id], event.payload.integration);
      return;

    case 'grant.created': {
      const g = event.payload.grant;
      const sessionId = grantSessionId(qc, g);
      if (sessionId) upsertIn<CapabilityGrant>(qc, qk.grants(sessionId), g, byCreatedAsc);
      return;
    }
    case 'grant.revoked': {
      // The payload only names the grant: patch it wherever it is cached.
      const { grantId } = event.payload;
      for (const [key, list] of qc.getQueriesData<CapabilityGrant[]>({ queryKey: ['grant.list'] })) {
        if (!list?.some((g) => g.id === grantId)) continue;
        patchIn<CapabilityGrant>(qc, key, grantId, (g) => (g.revokedAt ? g : { ...g, revokedAt: event.ts }));
      }
      return;
    }
    case 'policy.denied':
      // An agent tried something its grant does not allow: say so on its activity line
      // (the Timeline keeps the full audit record).
      if (event.runId) streams.activity.set(event.runId, `権限外の操作を拒否しました（${event.payload.permission}）`);
      return;

    case 'budget.updated': {
      const b = event.payload.budget;
      qc.setQueryData<BudgetNode>(qk.budget(b.id), (cur) => (cur ? { ...cur, budget: b } : cur));
      if (b.parentId) {
        qc.setQueryData<BudgetNode>(qk.budget(b.parentId), (cur) =>
          cur
            ? {
                ...cur,
                children: cur.children.some((c) => c.id === b.id)
                  ? cur.children.map((c) => (c.id === b.id ? b : c))
                  : [...cur.children, b],
              }
            : cur,
        );
      }
      if (b.subject.kind === 'session' && b.subject.id) {
        upsertIn<BudgetAllocation>(qc, qk.sessionBudgets(b.subject.id), b, byCreatedDesc);
      }
      return;
    }

    case 'settings.updated':
      void qc.invalidateQueries({ queryKey: qk.settings });
      void qc.invalidateQueries({ queryKey: qk.models });
      return;

    case 'orchestrator.decision':
      // The orchestrator's latest judgement doubles as its "what is it doing" line.
      if (event.runId) streams.activity.set(event.runId, event.payload.decision);
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
  schedule: (flush: () => void) => void = scheduleFrame,
  /** Sees every live event after it was applied (attention notifications). */
  observe: (e: Event) => void = () => {},
): () => void {
  const interrupted = createInterruptNotifier(onInterrupted);
  // Events are applied once per frame, in order, inside one query-cache batch: a burst
  // (ten runs starting, a reconnect replay) re-renders the UI once, not once per event
  // (ui-design §10). Optimistic actions do not wait for this; they patch the cache directly.
  const queue: Event[] = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (queue.length === 0) return;
    const batch = queue.splice(0);
    notifyManager.batch(() => {
      for (const e of batch) {
        applyEvent(qc, streams, e);
        interrupted(e);
      }
    });
    for (const e of batch) {
      try {
        observe(e);
      } catch (err) {
        console.warn('[acc] event observer failed', err);
      }
    }
  };
  let sub: Subscription | null = client.subscribe({
    deltas: true,
    onEvent: (e) => {
      queue.push(e);
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
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
    flush();
  };
}

/**
 * Next animation frame, with a timer fallback: a hidden window gets no frames, but its
 * caches (and the attention count in the title / notifications) must still move.
 */
export function scheduleFrame(cb: () => void): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    cb();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  setTimeout(run, 50);
}
