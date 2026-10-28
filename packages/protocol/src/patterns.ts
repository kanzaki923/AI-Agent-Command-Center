import type { EventRefs, EventFilter } from './events';

/**
 * Match a dot-separated name against a pattern.
 * - `*` alone matches everything.
 * - A trailing `.*` matches one or more remaining segments (`task.*` matches `task.create`).
 * - `*` in the middle matches exactly one segment (`*.list` matches `task.list`).
 */
export function matchPattern(pattern: string, name: string): boolean {
  if (pattern === '*' || pattern === name) return true;
  const p = pattern.split('.');
  const n = name.split('.');
  for (let i = 0; i < p.length; i++) {
    const seg = p[i];
    const isLast = i === p.length - 1;
    if (seg === '*' && isLast) return n.length > i;
    if (i >= n.length) return false;
    if (seg !== '*' && seg !== n[i]) return false;
  }
  return p.length === n.length;
}

export function matchAnyPattern(patterns: readonly string[], name: string): boolean {
  return patterns.some((p) => matchPattern(p, name));
}

/** Whether an event (envelope refs + type) passes a filter. Empty filter matches everything. */
export function eventMatchesFilter(
  event: EventRefs & { type: string },
  filter: EventFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.projectId && event.projectId !== filter.projectId) return false;
  if (filter.sessionId && event.sessionId !== filter.sessionId) return false;
  if (filter.runId && event.runId !== filter.runId) return false;
  if (filter.taskId && event.taskId !== filter.taskId) return false;
  if (filter.types && filter.types.length > 0 && !matchAnyPattern(filter.types, event.type))
    return false;
  return true;
}
