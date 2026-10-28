import { useMemo } from 'react';
import { useStore } from 'zustand';
import { useRuntime } from '../daemon/runtime';
import {
  useIntegrations,
  usePendingApprovals,
  useRuns,
  useSessions,
  useTasks,
} from '../daemon/queries';
import { useUi } from '../store/ui';
import { type BoardItem, buildBoard } from './board';

const NONE: never[] = [];

export interface BoardData {
  items: BoardItem[];
  /** True until sessions arrived once (skeleton after 150ms, §8.3). */
  loading: boolean;
}

/** All Command-board inputs, filtered by the project switcher. */
export function useBoard(): BoardData {
  const rt = useRuntime();
  const lingering = useStore(rt.streams.recent.store, (s) => s.completed);
  const projectId = useUi((s) => s.projectId);
  const sessions = useSessions();
  const runs = useRuns();
  const approvals = usePendingApprovals();
  const tasks = useTasks();
  const integrations = useIntegrations();
  const s = sessions.data ?? NONE;
  const r = runs.data ?? NONE;
  const a = approvals.data ?? NONE;
  const t = tasks.data ?? NONE;
  const i = integrations.data ?? NONE;
  const items = useMemo(
    () => buildBoard({ sessions: s, runs: r, approvals: a, tasks: t, integrations: i, projectId, lingering }),
    [s, r, a, t, i, projectId, lingering],
  );
  return { items, loading: sessions.isPending };
}
