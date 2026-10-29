/**
 * T1 Supervisor: inbox, wakes, stop / resume, delegation (spec 20261029 §2.2, §3.2).
 * Schemas are fixed by the Core track; T1 implements them.
 */
import { z } from 'zod';
import {
  AttentionId,
  GrantId,
  InboxItemId,
  MessageId,
  ProjectId,
  RunId,
  SessionId,
  Timestamp,
} from '../common';
import { BudgetAllocation, CapabilityGrant } from '../domain';
import { type MethodDef, params } from '../method';

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** Why a session should be woken (the only way a supervisor gets new work). */
export const InboxItemKind = z.enum(['user_message', 'child_update', 'answer', 'budget', 'resume']);
export type InboxItemKind = z.infer<typeof InboxItemKind>;
export const InboxItemStatus = z.enum(['pending', 'consumed', 'dropped']);
export type InboxItemStatus = z.infer<typeof InboxItemStatus>;

export const InboxItemRefs = z.object({
  messageId: MessageId.optional(),
  childSessionId: SessionId.optional(),
  attentionId: AttentionId.optional(),
  runId: RunId.optional(),
});
export type InboxItemRefs = z.infer<typeof InboxItemRefs>;

export const InboxItem = z.object({
  id: InboxItemId,
  /** Session to wake. */
  sessionId: SessionId,
  kind: InboxItemKind,
  refs: InboxItemRefs,
  status: InboxItemStatus,
  consumedByRunId: RunId.nullable(),
  createdAt: Timestamp,
});
export type InboxItem = z.infer<typeof InboxItem>;

/** How `session.send` handed the message over. */
export const SendDelivery = z.enum(['started', 'queued', 'injected']);
export type SendDelivery = z.infer<typeof SendDelivery>;

export const supervisorDomain = {
  InboxItemKind,
  InboxItemStatus,
  InboxItemRefs,
  InboxItem,
  SendDelivery,
} as const;

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

export const supervisorMethods = {
  'session.stop': {
    params: params({
      sessionId: SessionId,
      tree: z.boolean().default(true).describe('Also stop every descendant session (default true)'),
      reason: z.string().max(1000).optional(),
    }),
    result: z.object({
      stoppedSessionIds: z.array(SessionId),
      cancelledRunIds: z.array(RunId),
    }),
    description:
      'Stop a session (and, by default, its descendants): active runs are cancelled, their work is paused (resumable with session.resume) and the session is not woken until resumed.',
    mutates: true,
  },
  'session.resume': {
    params: params({
      sessionId: SessionId,
      tree: z.boolean().default(true).describe('Also resume stopped descendants (default true)'),
      message: z
        .string()
        .max(50_000)
        .optional()
        .describe('Extra instruction delivered when the work restarts'),
    }),
    result: z.object({
      resumedSessionIds: z.array(SessionId),
      runIds: z.array(RunId),
    }),
    description:
      'Resume a stopped session (and its stopped descendants): paused work restarts where it left off and supervision is active again.',
    mutates: true,
  },
  'session.delegate': {
    params: params({
      sessionId: SessionId,
      maxChildren: z.int().min(1).max(16).default(4),
      budgetUsd: z.number().positive().max(10_000).default(3),
      projectId: ProjectId.nullable()
        .optional()
        .describe("Defaults to the session's project; null delegates without a project"),
      allowSchedules: z.boolean().default(true),
      lifetime: z.enum(['session', 'work']).default('session'),
      expiresAt: Timestamp.optional(),
    }),
    result: z.object({ grant: CapabilityGrant, budget: BudgetAllocation.nullable() }),
    description:
      'Let a session lead other agents: grants the supervisor preset (spawn children, talk to them, stop / resume them, review their outputs, schedules) with maxChildren and a root budget. Humans only. Replaces session.grantOrchestration.',
    tool: false,
    mutates: true,
  },
  'session.undelegate': {
    params: params({ sessionId: SessionId }),
    result: z.object({ revoked: z.array(GrantId) }),
    description: 'Revoke the supervisor grants of a session. Humans only.',
    tool: false,
    mutates: true,
  },
} as const satisfies Record<string, MethodDef>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const supervisorEvents = {
  /** Audit trail of the inbox (hidden from the default timeline). */
  'inbox.added': z.object({ item: InboxItem }),
  'inbox.consumed': z.object({ itemIds: z.array(InboxItemId), runId: RunId }),
} as const;
