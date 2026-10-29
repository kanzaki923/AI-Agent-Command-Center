import {
  type Approval,
  type Artifact,
  type ArtifactKind,
  type BudgetAllocation,
  type CapabilityGrant,
  type Integration,
  type ModelInfo,
  type PermissionRule,
  type Project,
  type Run,
  type Session,
  type SettingsView,
  type SystemInfo,
  type Task,
  type Workspace,
  type WorkspaceDiff,
  isTerminalRunStatus,
} from '@acc/protocol';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { ActivityEntry } from './activity';
import { type StreamingMessage, streamingForSession } from './deltas';
import { isNotImplemented } from './errors';
import { qk } from './keys';
import { type AppRuntime, useRuntime } from './runtime';
import type { ChatMessage } from './sync';

const EMPTY: never[] = [];

/** Collect pages of a list method (bounded: the UI shows the most recent items). */
async function collect<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
  max = 400,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    out.push(...page.items);
    if (!page.nextCursor || out.length >= max) return out;
    cursor = page.nextCursor;
  }
}

export function useInfo() {
  const rt = useRuntime();
  return useQuery<SystemInfo>({ queryKey: qk.info, queryFn: () => rt.client.call('system.info') });
}

export function useSettings() {
  const rt = useRuntime();
  return useQuery<SettingsView>({
    queryKey: qk.settings,
    queryFn: () => rt.client.call('settings.get'),
  });
}

export function useModels() {
  const rt = useRuntime();
  return useQuery<{ models: ModelInfo[]; source: 'litellm' | 'config' | 'mock' | 'none' }>({
    queryKey: qk.models,
    queryFn: () =>
      rt.callOr('models.list', {}, { models: [], source: 'config' }).then((r) =>
        r.models.length === 0 && r.source === 'config' ? { ...r, source: 'none' as const } : r,
      ),
  });
}

export function useProjects() {
  const rt = useRuntime();
  return useQuery<Project[]>({
    queryKey: qk.projects,
    queryFn: () => rt.client.call('project.list', {}).then((r) => r.items),
  });
}

export function useSessions() {
  const rt = useRuntime();
  return useQuery<Session[]>({
    queryKey: qk.sessions,
    queryFn: () =>
      collect((cursor) => rt.client.call('session.list', { limit: 200, ...(cursor ? { cursor } : {}) })),
  });
}

/**
 * Recent runs. Falls back to `run.get` of each session's active run while `run.list` is
 * not implemented, so live runs still show up.
 */
export async function fetchRuns(rt: AppRuntime): Promise<Run[]> {
  try {
    return await collect((cursor) =>
      rt.client.call('run.list', { limit: 200, ...(cursor ? { cursor } : {}) }),
    );
  } catch (err) {
    if (!isNotImplemented(err)) throw err;
    rt.markUnimplemented('run.list');
    const sessions =
      rt.queryClient.getQueryData<Session[]>(qk.sessions) ??
      (await collect((cursor) =>
        rt.client.call('session.list', { limit: 200, ...(cursor ? { cursor } : {}) }),
      ));
    const ids = sessions.map((s) => s.activeRunId).filter((x): x is string => !!x);
    const runs = await Promise.all(ids.map((runId) => rt.client.call('run.get', { runId }).catch(() => null)));
    return runs.filter((r): r is Run => !!r);
  }
}

export function useRuns() {
  const rt = useRuntime();
  return useQuery<Run[]>({ queryKey: qk.runs, queryFn: () => fetchRuns(rt) });
}

/**
 * One run out of the shared run list. Re-renders only when that run changes (the list
 * updates on every run.updated of every run).
 */
export function useRunFromList(runId: string | null | undefined): Run | null {
  const rt = useRuntime();
  return (
    useQuery<Run[], Error, Run | null>({
      queryKey: qk.runs,
      queryFn: () => fetchRuns(rt),
      select: (runs) => (runId ? (runs.find((r) => r.id === runId) ?? null) : null),
    }).data ?? null
  );
}

/** The runs of one session (same identity until one of them changes: structural sharing). */
export function useSessionRuns(sessionId: string): Run[] {
  const rt = useRuntime();
  return (
    useQuery<Run[], Error, Run[]>({
      queryKey: qk.runs,
      queryFn: () => fetchRuns(rt),
      select: (runs) => runs.filter((r) => r.sessionId === sessionId),
    }).data ?? EMPTY_RUNS
  );
}
const EMPTY_RUNS: Run[] = [];

export function useRun(runId: string | null | undefined) {
  const rt = useRuntime();
  return useQuery<Run>({
    queryKey: qk.run(runId ?? ''),
    queryFn: () => rt.client.call('run.get', { runId: runId! }),
    enabled: !!runId,
  });
}

export function usePendingApprovals() {
  const rt = useRuntime();
  return useQuery<Approval[]>({
    queryKey: qk.approvals,
    queryFn: () =>
      rt
        .callOr('approval.list', { status: ['pending'], limit: 200 }, { items: [], nextCursor: null })
        .then((r) => [...r.items].sort((a, b) => a.createdAt.localeCompare(b.createdAt))),
  });
}

/** Resolved approvals are only known from events in this UI session (no fetch). */
export function useResolvedApprovals(): Approval[] {
  const rt = useRuntime();
  const q = useQuery<Approval[]>({
    queryKey: qk.resolvedApprovals,
    queryFn: () =>
      rt
        .callOr(
          'approval.list',
          { status: ['approved', 'rejected'], limit: 100 },
          { items: [], nextCursor: null },
        )
        .then((r) => r.items),
  });
  return q.data ?? EMPTY;
}

export function useTasks() {
  const rt = useRuntime();
  return useQuery<Task[]>({
    queryKey: qk.tasks,
    queryFn: () =>
      rt.callOr('task.list', { limit: 500 }, { items: [], nextCursor: null }).then((r) => r.items),
  });
}

export function useIntegrations() {
  const rt = useRuntime();
  return useQuery<Integration[]>({
    queryKey: qk.integrations,
    queryFn: () =>
      rt
        .callOr('integration.list', { limit: 100 }, { items: [], nextCursor: null })
        .then((r) => r.items),
  });
}

export function useWorkspaces() {
  const rt = useRuntime();
  return useQuery<Workspace[]>({
    queryKey: qk.workspaces,
    queryFn: () => rt.callOr('workspace.list', {}, { items: [] }).then((r) => r.items),
  });
}

export function useWorkspace(workspaceId: string | null | undefined) {
  const rt = useRuntime();
  return useQuery<Workspace | null>({
    queryKey: qk.workspace(workspaceId ?? ''),
    queryFn: () =>
      rt.client.call('workspace.get', { workspaceId: workspaceId! }).catch(() => null),
    enabled: !!workspaceId,
  });
}

export function useDiff(workspaceId: string | null | undefined) {
  const rt = useRuntime();
  return useQuery<WorkspaceDiff | null>({
    queryKey: qk.diff(workspaceId ?? ''),
    queryFn: () =>
      rt
        .callOr('workspace.diff', { workspaceId: workspaceId! }, null as unknown as WorkspaceDiff)
        .then((d) => d ?? null),
    enabled: !!workspaceId,
    staleTime: 5_000,
  });
}

export function useArtifacts(sessionId: string | null | undefined, kind: ArtifactKind) {
  const rt = useRuntime();
  return useQuery<Artifact[]>({
    queryKey: qk.artifacts(sessionId ?? '', kind),
    queryFn: () =>
      rt
        .callOr('artifact.list', { sessionId: sessionId!, kind, limit: 50 }, { items: [], nextCursor: null })
        .then((r) => r.items),
    enabled: !!sessionId,
  });
}

/**
 * Grants of a session (subject = the session, or its latest run), revoked ones included so
 * the chat can show when a capability ended. Live changes arrive through sync.ts.
 */
export function useGrants(sessionId: string | null | undefined) {
  const rt = useRuntime();
  return useQuery<CapabilityGrant[]>({
    queryKey: qk.grants(sessionId ?? ''),
    queryFn: async () => {
      const runs = rt.queryClient.getQueryData<Run[]>(qk.runs) ?? [];
      const latest = runs.find((r) => r.sessionId === sessionId);
      const r = await rt.callOr(
        'grant.list',
        { sessionId: sessionId!, includeRevoked: true, ...(latest ? { runId: latest.id } : {}) },
        { items: [] },
      );
      return [...r.items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    enabled: !!sessionId,
  });
}

/**
 * Budgets whose subject is this session. There is no list-by-subject method, but
 * budget.updated events carry the subject's session as an envelope ref, so the event log
 * finds them; later changes are patched in by sync.ts.
 */
export function useSessionBudgets(sessionId: string | null | undefined) {
  const rt = useRuntime();
  return useQuery<BudgetAllocation[]>({
    queryKey: qk.sessionBudgets(sessionId ?? ''),
    queryFn: async () => {
      const latest = new Map<string, BudgetAllocation>();
      let since = 0;
      for (let page = 0; page < 20; page++) {
        const r = await rt.client.call('events.list', {
          sessionId: sessionId!,
          types: ['budget.updated'],
          since,
          limit: 1000,
        });
        for (const e of r.events) {
          if (e.type !== 'budget.updated') continue;
          const b = e.payload.budget;
          if (b.subject.kind === 'session' && b.subject.id === sessionId) latest.set(b.id, b);
        }
        since = r.lastSeq;
        if (!r.hasMore || r.events.length === 0) break;
      }
      return [...latest.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    enabled: !!sessionId,
  });
}

/**
 * Latest artifacts of one kind for a project, or across all projects when `projectId` is
 * null (diff stats per task, test results).
 */
export function useProjectArtifacts(projectId: string | null | undefined, kind: ArtifactKind) {
  const rt = useRuntime();
  return useQuery<Artifact[]>({
    queryKey: qk.projectArtifacts(projectId ?? '', kind),
    queryFn: () =>
      rt
        .callOr(
          'artifact.list',
          // Artifacts carry their full data (diff patches): keep the page small.
          { ...(projectId ? { projectId } : {}), kind, limit: 60 },
          { items: [], nextCursor: null },
        )
        .then((r) => r.items),
  });
}

export function useArtifact(artifactId: string | null | undefined) {
  const rt = useRuntime();
  return useQuery<Artifact | null>({
    queryKey: qk.artifact(artifactId ?? ''),
    queryFn: () => rt.client.call('artifact.get', { artifactId: artifactId! }),
    enabled: !!artifactId,
  });
}

/** Methods this daemon implements (system.info). Used to probe optional / newer methods. */
export function useMethods(): ReadonlySet<string> | null {
  const info = useInfo().data;
  return useMemo(() => (info ? new Set(info.methods) : null), [info]);
}

/** A session's history (the latest 500 messages). Shared by the chat and optimistic sends. */
export function messagesQuery(rt: AppRuntime, sessionId: string) {
  return {
    queryKey: qk.messages(sessionId),
    queryFn: async (): Promise<ChatMessage[]> => {
      const r = await rt.client.call('session.messages', { sessionId, limit: 500 });
      // Opened mid-answer: show what was already written right away (not only what streams
      // from now on). Skipped when the answer has been saved or its run ended meanwhile.
      const st = r.streaming;
      if (st && !r.items.some((m) => m.id === st.messageId)) {
        const run = rt.queryClient.getQueryData<Run[]>(qk.runs)?.find((x) => x.id === st.runId);
        if (!run || !isTerminalRunStatus(run.status)) rt.streams.deltas.seed(sessionId, st);
      }
      return r.items;
    },
  };
}

export function useMessages(sessionId: string | null | undefined) {
  const rt = useRuntime();
  return useQuery<ChatMessage[]>({
    ...messagesQuery(rt, sessionId ?? ''),
    enabled: !!sessionId,
  });
}

/** Load recent event history into the event log (Timeline, ログ tab). */
export function useEventHistory() {
  const rt = useRuntime();
  return useQuery<number>({
    queryKey: qk.eventHistory,
    queryFn: async () => {
      const info = await rt.client.call('system.info');
      const head = info.stats.lastEventSeq;
      let since = Math.max(0, head - 5000);
      for (;;) {
        const page = await rt.client.call('events.list', { since, limit: 1000 });
        rt.streams.events.addMany(page.events);
        since = page.lastSeq;
        if (!page.hasMore || page.events.length === 0) break;
      }
      return head;
    },
  });
}

/**
 * Streaming messages of one session. Deltas of other sessions arrive every frame; the
 * shallow compare keeps this from re-rendering the chat unless its own messages changed.
 */
export function useStreaming(sessionId: string | null | undefined): StreamingMessage[] {
  const rt = useRuntime();
  return useStore(
    rt.streams.deltas.store,
    useShallow((s) => (sessionId ? streamingForSession(s, sessionId) : EMPTY)),
  );
}

export function useActivity(runId: string | null | undefined): ActivityEntry | undefined {
  const rt = useRuntime();
  return useStore(rt.streams.activity.store, (s) => (runId ? s.byRun[runId] : undefined));
}

export function useEventLogVersion(): number {
  const rt = useRuntime();
  return useStore(rt.streams.events.store, (s) => s.version);
}

/** Changes only when an event of this session arrives (others' events do not re-render). */
export function useSessionEventVersion(sessionId: string): number {
  const rt = useRuntime();
  const log = rt.streams.events;
  // The counter lives beside the store and is updated before each store change.
  return useStore(log.store, () => log.sessionVersion(sessionId));
}

/**
 * Remembered tool approvals of a project (active ones, newest first). rule_created /
 * rule_revoked events keep the list current (sync.ts). An older daemon without the method
 * shows none.
 */
export function usePermissionRules(projectId: string | null | undefined) {
  const rt = useRuntime();
  return useQuery<PermissionRule[]>({
    queryKey: qk.permissionRules(projectId ?? ''),
    queryFn: () =>
      rt.callOr('permissionRule.list', { projectId: projectId! }, { items: [] }).then((r) => r.items),
    enabled: !!projectId,
  });
}

/**
 * Load a session's tool decisions (tool.decided) into the shared event log, so the chat can
 * show how each tool use was decided after a reload too; live ones arrive by the
 * subscription. Returns the session's event-log version (changes when one of its events
 * arrives).
 */
export function useToolDecisionHistory(sessionId: string | null | undefined): number {
  const rt = useRuntime();
  useQuery<number>({
    queryKey: qk.toolDecisions(sessionId ?? ''),
    queryFn: async () => {
      let since = 0;
      for (let page = 0; page < 10; page++) {
        const r = await rt.client.call('events.list', {
          sessionId: sessionId!,
          types: ['tool.decided'],
          since,
          limit: 1000,
        });
        rt.streams.events.addMany(r.events);
        since = r.lastSeq;
        if (!r.hasMore || r.events.length === 0) break;
      }
      return since;
    },
    enabled: !!sessionId,
  });
  const log = rt.streams.events;
  return useStore(log.store, () => (sessionId ? log.sessionVersion(sessionId) : 0));
}
