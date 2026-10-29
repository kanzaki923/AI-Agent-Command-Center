import type {
  AttentionKind,
  RunStatus,
  Session,
  SessionKind,
  SessionState,
  Supervision,
  TaskStatus,
} from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { ACTIVE_RUN_STATUSES } from '../runs/manager';
import { subtreeIds } from './tree';

/** Everything the state of one session is derived from (spec 20261029 §3.7). */
export interface StateFacts {
  kind: SessionKind;
  /** Kinds of the open attention items on this session. */
  openAttention: AttentionKind[];
  /** Status of the session's latest run, if any. */
  lastRunStatus: RunStatus | null;
  /** Status of the session's task (its own, or the one assigned to it), if any. */
  taskStatus: TaskStatus | null;
  /** A descendant has an active run or a task waiting to start. */
  descendantBusy: boolean;
  hasChildren: boolean;
  supervision: Supervision;
}

const ASKS_A_HUMAN: readonly AttentionKind[] = ['question', 'approval', 'budget', 'stuck'];

/**
 * The §3.7 table, first match wins: needs_you > failed > working > supervising > queued >
 * review > stopped > done > idle. Pure; the Home track (T7) owns and extends it.
 */
export function deriveSessionState(f: StateFacts): SessionState {
  if (f.openAttention.some((k) => ASKS_A_HUMAN.includes(k))) return 'needs_you';
  if (f.openAttention.includes('failure')) return 'failed';
  if (f.lastRunStatus === 'running' || f.lastRunStatus === 'awaiting_approval') return 'working';
  const runActive = f.lastRunStatus === 'created' || f.lastRunStatus === 'queued';
  if (!runActive && f.descendantBusy) return 'supervising';
  if (runActive || f.taskStatus === 'pending' || f.taskStatus === 'ready') return 'queued';
  if (f.taskStatus === 'review' || f.openAttention.includes('review')) return 'review';
  if (f.taskStatus === 'paused' || f.supervision === 'paused') return 'stopped';
  if (
    f.taskStatus === 'done' ||
    (f.lastRunStatus === 'completed' && !f.hasChildren && f.kind === 'agent')
  ) {
    return 'done';
  }
  return 'idle';
}

/** Read the facts of one session (a handful of indexed queries). */
export function readStateFacts(ctx: DaemonContext, session: Session): StateFacts {
  const { repos } = ctx;
  const openAttention = repos.attention
    .find({ where: { session_id: session.id, status: 'open' } })
    .map((a) => a.kind);
  const lastRun = repos.runs.findOne({ where: { session_id: session.id } });
  const task =
    (session.taskId ? repos.tasks.get(session.taskId) : undefined) ??
    repos.tasks.findOne({ where: { assignee_session_id: session.id } });
  const descendants = subtreeIds(ctx, session.id).slice(1);
  const descendantBusy =
    descendants.length > 0 &&
    (repos.runs.count({
      where: { session_id: descendants, status: [...ACTIVE_RUN_STATUSES] },
    }) > 0 ||
      repos.tasks.count({
        where: { assignee_session_id: descendants, status: ['pending', 'ready'] },
      }) > 0);
  return {
    kind: session.kind,
    openAttention,
    lastRunStatus: lastRun?.status ?? null,
    taskStatus: task?.status ?? null,
    descendantBusy,
    hasChildren: descendants.length > 0,
    supervision: session.supervision,
  };
}

/**
 * Startup backfill (spec §1.12-1, run once): derive every session's state and write the ones
 * that differ, without events (`stateSince` = its last activity).
 */
export function backfillSessionStates(ctx: DaemonContext): number {
  let changed = 0;
  ctx.db.transaction(() => {
    for (const { id } of ctx.db.all<{ id: string }>('SELECT id FROM sessions')) {
      const session = ctx.repos.sessions.get(id);
      if (!session) continue;
      const state = deriveSessionState(readStateFacts(ctx, session));
      if (state === session.state) continue;
      ctx.repos.sessions.update(id, (s) => ({ ...s, state, stateSince: s.lastActivityAt }));
      changed += 1;
    }
  });
  return changed;
}
