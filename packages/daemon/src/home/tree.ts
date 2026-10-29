import { TERMINAL_TASK_STATUSES } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { ACTIVE_RUN_STATUSES } from '../runs/manager';

/**
 * The session and its descendants (ids, the session first). Reads only the session's tree
 * (`root_session_id`), so it costs one indexed query whatever the number of trees.
 */
export function subtreeIds(ctx: DaemonContext, sessionId: string): string[] {
  const session = ctx.repos.sessions.get(sessionId);
  if (!session) return [];
  const rows = ctx.db.all<{ id: string; parent_session_id: string | null }>(
    'SELECT id, parent_session_id FROM sessions WHERE root_session_id = ?',
    [session.rootSessionId],
  );
  const children = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.parent_session_id) continue;
    const list = children.get(r.parent_session_id) ?? [];
    list.push(r.id);
    children.set(r.parent_session_id, list);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [sessionId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    queue.push(...(children.get(id) ?? []));
  }
  return out;
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/**
 * Whether a session's work has settled (spec 20261029 §1.8): no active run, open attention,
 * unfinished task (assigned to, or created by, a session of the subtree) or pending inbox
 * item in the session or any descendant. Grants with lifetime `work` end then.
 */
export function isWorkSettled(ctx: DaemonContext, sessionId: string): boolean {
  const ids = subtreeIds(ctx, sessionId);
  if (ids.length === 0) return true;
  const { repos } = ctx;
  if (repos.runs.count({ where: { session_id: ids, status: [...ACTIVE_RUN_STATUSES] } }) > 0) {
    return false;
  }
  if (repos.attention.count({ where: { session_id: ids, status: 'open' } }) > 0) return false;
  if (repos.inboxItems.count({ where: { session_id: ids, status: 'pending' } }) > 0) return false;
  const terminal = [...TERMINAL_TASK_STATUSES];
  const unfinished = repos.tasks.count({
    sql: {
      clause: `status NOT IN (${placeholders(terminal.length)})
        AND (assignee_session_id IN (${placeholders(ids.length)})
          OR json_extract(data, '$.createdBy.sessionId') IN (${placeholders(ids.length)}))`,
      params: [...terminal, ...ids, ...ids],
    },
  });
  return unfinished === 0;
}
