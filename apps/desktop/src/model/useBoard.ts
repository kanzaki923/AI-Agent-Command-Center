import { useMemo } from 'react';
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
export function useBoard(opts: { now?: number } = {}): BoardData {
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
  const { now } = opts;
  const items = useMemo(
    () => buildBoard({ sessions: s, runs: r, approvals: a, tasks: t, integrations: i, projectId, now }),
    [s, r, a, t, i, projectId, now],
  );
  return { items, loading: sessions.isPending };
}
