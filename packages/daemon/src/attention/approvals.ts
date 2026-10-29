import { type Approval, type AttentionRefs, ToolApprovalPayload } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { approvalTitleFor } from '../runtime/tools';
import { oneLine } from './text';

/**
 * Title of the attention item for an approval: one noun phrase naming what will happen
 * ("pnpm add zod を実行"), never "…を承認しますか" (spec 20261029 §3.6). Tool uses are titled
 * from their payload, so approvals stored with an older question-style title read the same.
 */
export function approvalAttentionTitle(ctx: DaemonContext, approval: Approval): string {
  if (approval.kind === 'tool_use') {
    const payload = ToolApprovalPayload.safeParse(approval.payload);
    if (payload.success) {
      const run = approval.runId ? ctx.repos.runs.get(approval.runId) : undefined;
      const workspaceId = run?.workspaceId ?? null;
      const cwd = workspaceId ? ctx.repos.workspaces.get(workspaceId)?.path : undefined;
      return oneLine(approvalTitleFor(payload.data.toolName, payload.data.input, cwd));
    }
  }
  return oneLine(approval.title.replace(/を?承認しますか[？?]?$/, '').trim() || approval.title);
}

/**
 * The session an approval belongs to: its own, else the integration's (the agent that
 * created it, or the session that started its first task). Null when there is none; such
 * approvals stay in `approval.list` only.
 */
export function approvalSessionId(ctx: DaemonContext, approval: Approval): string | null {
  if (approval.sessionId) return approval.sessionId;
  if (!approval.integrationId) return null;
  const integration = ctx.repos.integrations.get(approval.integrationId);
  if (!integration) return null;
  if (integration.createdBy.kind === 'agent') return integration.createdBy.sessionId;
  for (const taskId of integration.taskIds) {
    const task = ctx.repos.tasks.get(taskId);
    if (task?.createdBy.kind === 'agent') return task.createdBy.sessionId;
  }
  return null;
}

/** Refs of an approval's attention item (also its dedupe key). */
export function approvalRefs(approval: Approval): AttentionRefs {
  return {
    approvalId: approval.id,
    ...(approval.runId ? { runId: approval.runId } : {}),
    ...(approval.integrationId ? { integrationId: approval.integrationId } : {}),
  };
}
