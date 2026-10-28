import type {
  Approval,
  Artifact,
  ArtifactKind,
  CapabilityGrant,
  Integration,
  ModelInfo,
  Project,
  Run,
  Session,
  SettingsView,
  SystemInfo,
  Task,
  Workspace,
  WorkspaceDiff,
} from '@acc/protocol';
import { useQuery } from '@tanstack/react-query';
import { useStore } from 'zustand';
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

export function useGrants(sessionId: string | null | undefined) {
  const rt = useRuntime();
  return useQuery<CapabilityGrant[]>({
    queryKey: qk.grants(sessionId ?? ''),
    queryFn: () => rt.callOr('grant.list', { sessionId: sessionId! }, { items: [] }).then((r) => r.items),
    enabled: !!sessionId,
  });
}

export function useMessages(sessionId: string | null | undefined) {
  const rt = useRuntime();
  return useQuery<ChatMessage[]>({
    queryKey: qk.messages(sessionId ?? ''),
    queryFn: () =>
      rt.client.call('session.messages', { sessionId: sessionId!, limit: 500 }).then((r) => r.items),
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

export function useStreaming(sessionId: string | null | undefined): StreamingMessage[] {
  const rt = useRuntime();
  const byMessage = useStore(rt.streams.deltas.store, (s) => s.byMessage);
  return sessionId ? streamingForSession({ byMessage }, sessionId) : EMPTY;
}

export function useActivity(runId: string | null | undefined): ActivityEntry | undefined {
  const rt = useRuntime();
  return useStore(rt.streams.activity.store, (s) => (runId ? s.byRun[runId] : undefined));
}

export function useEventLogVersion(): number {
  const rt = useRuntime();
  return useStore(rt.streams.events.store, (s) => s.version);
}
