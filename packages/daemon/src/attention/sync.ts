import type { Actor, Approval, AttentionKind, Event } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { approvalAttentionTitle, approvalRefs, approvalSessionId } from './approvals';
import type { AttentionManager } from './service';

/** Free budget (USD) above which a budget item counts as answered. */
const BUDGET_FREE_EPSILON = 0.005;

/** What a new run, or a task moving on, makes moot. */
const WORK_RESUMED: readonly AttentionKind[] = ['failure', 'stuck'];
/** What archiving a session makes moot (approvals end with their runs). */
const ARCHIVED_MOOT: readonly AttentionKind[] = [
  'question',
  'failure',
  'review',
  'budget',
  'stuck',
];

const TYPES = [
  'approval.requested',
  'approval.resolved',
  'run.created',
  'task.updated',
  'artifact.updated',
  'integration.updated',
  'budget.updated',
  'session.archived',
] as const;

/**
 * Keep attention in step with its causes (spec 20261029 §1.6, §3.6), from committed events
 * only (the attention module does not touch the runs, tasks or budget code):
 * - an approval request opens an `approval` item; its answer (or cancellation) resolves it;
 * - a new run in a session resolves its `failure` / `stuck` items (retried, resumed or given
 *   a new instruction);
 * - a task leaving `review` resolves its `review` items; running again or finished resolves
 *   its `failure` / `stuck` items too;
 * - an accepted / rejected output, or an applied / rejected / cancelled integration, resolves
 *   its `review` items;
 * - a budget with money left again (raised) resolves its `budget` items;
 * - archiving a session resolves what was left open on it.
 * Returns the unsubscribe function.
 */
export function syncAttention(ctx: DaemonContext, manager: AttentionManager): () => void {
  return ctx.bus.subscribe({ types: [...TYPES] }, (event) => {
    try {
      handle(ctx, manager, event);
    } catch (err) {
      ctx.log.warn('attention sync failed', { type: event.type, error: (err as Error).message });
    }
  });
}

function handle(ctx: DaemonContext, manager: AttentionManager, event: Event): void {
  const by: Actor = event.actor;
  switch (event.type) {
    case 'approval.requested':
      openForApproval(ctx, manager, event.payload.approval, by);
      return;
    case 'approval.resolved': {
      const ap = event.payload.approval;
      const choiceId =
        ap.status === 'approved' ? 'approve' : ap.status === 'rejected' ? 'reject' : null;
      manager.resolveMatching(
        { approvalId: ap.id },
        { choiceId, text: ap.resolutionNote, by: ap.resolvedBy ?? by },
        ['approval'],
      );
      return;
    }
    case 'run.created':
      manager.resolveSession(event.payload.run.sessionId, WORK_RESUMED, { by });
      return;
    case 'task.updated': {
      const { task, changes } = event.payload;
      if (!changes.includes('status')) return;
      if (task.status !== 'review')
        manager.resolveMatching({ taskId: task.id }, { by }, ['review']);
      if (task.status === 'running' || task.status === 'done' || task.status === 'cancelled') {
        manager.resolveMatching({ taskId: task.id }, { by }, WORK_RESUMED);
      }
      return;
    }
    case 'artifact.updated': {
      const { artifact } = event.payload;
      const state = artifact.review.state;
      if (state !== 'accepted' && state !== 'rejected') return;
      manager.resolveMatching(
        { artifactId: artifact.id },
        { choiceId: state === 'accepted' ? 'accept' : 'redo', by: artifact.review.by ?? by },
        ['review'],
      );
      return;
    }
    case 'integration.updated': {
      const { integration, changes } = event.payload;
      if (!changes.includes('status')) return;
      if (!['applied', 'rejected', 'cancelled'].includes(integration.status)) return;
      manager.resolveMatching(
        { integrationId: integration.id },
        { choiceId: integration.status === 'applied' ? 'accept' : null, by },
        ['review'],
      );
      return;
    }
    case 'budget.updated': {
      const b = event.payload.budget;
      const free = b.limitUsd - b.allocatedUsd - b.reservedUsd - b.spentUsd;
      if (b.status !== 'released' && free <= BUDGET_FREE_EPSILON) return;
      manager.resolveMatching({ budgetId: b.id }, { by }, ['budget']);
      return;
    }
    case 'session.archived':
      if (event.payload.archived) {
        manager.resolveSession(event.payload.sessionId, ARCHIVED_MOOT, { by });
      }
      return;
    default:
      return;
  }
}

/** An approval request becomes an `approval` item of its session (one line + 許可 / 拒否). */
export function openForApproval(
  ctx: DaemonContext,
  manager: AttentionManager,
  approval: Approval,
  actor: Actor,
): void {
  if (approval.status !== 'pending') return;
  const sessionId = approvalSessionId(ctx, approval);
  if (!sessionId) return;
  manager.open({
    kind: 'approval',
    sessionId,
    title: approvalAttentionTitle(ctx, approval),
    detail: approval.detail,
    refs: approvalRefs(approval),
    actor,
  });
}
