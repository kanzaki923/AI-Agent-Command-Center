import {
  ATTENTION_ALLOWS_TEXT,
  ATTENTION_DEFAULT_CHOICES,
  type AttentionKind,
  type AttentionRefs,
  type Session,
} from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { attentionPriority } from './priority';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TITLE = 80;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE - 1)}…` : flat;
}

/**
 * Startup backfill (spec 20261029 §1.12-3, run once): attention items for what was already
 * waiting on a human before attention existed — pending approvals, and failed / review tasks
 * of sessions that are not archived, from the last 7 days. No events: nothing happened, the
 * items only become visible. Returns how many were created.
 */
export function backfillAttention(ctx: DaemonContext): number {
  const { repos } = ctx;
  const now = ctx.clock.iso();
  const since = new Date(ctx.clock.now() - WINDOW_MS).toISOString();
  const sessions = new Map<string, Session | null>();
  const liveSession = (id: string | null): Session | null => {
    if (!id) return null;
    if (!sessions.has(id)) sessions.set(id, repos.sessions.get(id) ?? null);
    const s = sessions.get(id) ?? null;
    return s && !s.archivedAt ? s : null;
  };
  let created = 0;
  const open = (kind: AttentionKind, session: Session, title: string, refs: AttentionRefs) => {
    repos.attention.insert({
      id: ctx.ids.next('attention'),
      kind,
      status: 'open',
      sessionId: session.id,
      rootSessionId: session.rootSessionId,
      title: oneLine(title),
      detail: null,
      choices: [...ATTENTION_DEFAULT_CHOICES[kind]],
      allowText: ATTENTION_ALLOWS_TEXT[kind],
      priority: attentionPriority(kind, now),
      refs,
      resolution: null,
      createdAt: now,
      resolvedAt: null,
    });
    created += 1;
  };

  ctx.db.transaction(() => {
    for (const ap of repos.approvals.find({
      where: { status: 'pending' },
      sql: { clause: 'created_at >= ?', params: [since] },
      direction: 'asc',
    })) {
      const session = liveSession(ap.sessionId);
      if (!session) continue;
      open('approval', session, ap.title, {
        approvalId: ap.id,
        ...(ap.runId ? { runId: ap.runId } : {}),
        ...(ap.integrationId ? { integrationId: ap.integrationId } : {}),
      });
    }

    for (const task of repos.tasks.find({
      where: { status: ['failed', 'review'] },
      sql: { clause: 'updated_at >= ?', params: [since] },
      direction: 'asc',
    })) {
      const session = liveSession(task.assigneeSessionId);
      if (!session) continue;
      const lastRun = repos.runs.findOne({ where: { task_id: task.id } });
      const refs: AttentionRefs = { taskId: task.id, ...(lastRun ? { runId: lastRun.id } : {}) };
      if (task.status === 'failed') open('failure', session, `「${task.title}」が失敗`, refs);
      else open('review', session, `「${task.title}」の確認`, refs);
    }
  });
  return created;
}
