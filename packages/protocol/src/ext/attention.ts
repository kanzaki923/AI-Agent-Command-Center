/**
 * T4 Attention: "your turn" items and questions to humans (spec 20261029 §1.6, §2.2, §3.6).
 * Schemas are fixed by the Core track; T4 implements them.
 */
import { z } from 'zod';
import {
  Actor,
  ApprovalId,
  ArtifactId,
  AttentionId,
  BudgetId,
  Cursor,
  IntegrationId,
  Limit,
  RunId,
  SessionId,
  TaskId,
  Timestamp,
  page,
} from '../common';
import { type MethodDef, params } from '../method';

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export const AttentionKind = z.enum([
  'question',
  'approval',
  'failure',
  'review',
  'budget',
  'stuck',
]);
export type AttentionKind = z.infer<typeof AttentionKind>;
export const AttentionStatus = z.enum(['open', 'resolved', 'dismissed']);
export type AttentionStatus = z.infer<typeof AttentionStatus>;

export const AttentionChoice = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(40),
  tone: z.enum(['primary', 'neutral', 'danger']),
});
export type AttentionChoice = z.infer<typeof AttentionChoice>;

/** What the attention is about; also the dedupe key (no two open items for the same cause). */
export const AttentionRefs = z.object({
  approvalId: ApprovalId.optional(),
  runId: RunId.optional(),
  artifactId: ArtifactId.optional(),
  integrationId: IntegrationId.optional(),
  budgetId: BudgetId.optional(),
  askedBySessionId: SessionId.optional(),
  taskId: TaskId.optional(),
});
export type AttentionRefs = z.infer<typeof AttentionRefs>;

export const AttentionResolution = z.object({
  choiceId: z.string().nullable(),
  text: z.string().nullable(),
  by: Actor,
});
export type AttentionResolution = z.infer<typeof AttentionResolution>;

/** Something a human (or a supervisor, for questions) has to act on. One line + buttons. */
export const Attention = z.object({
  id: AttentionId,
  kind: AttentionKind,
  status: AttentionStatus,
  sessionId: SessionId,
  rootSessionId: SessionId,
  /** One line, <= 80 chars, no ids or JSON (e.g. "pnpm add zod を実行"). */
  title: z.string(),
  /** Shown only when expanded. */
  detail: z.string().nullable(),
  choices: z.array(AttentionChoice).max(4),
  /** Whether a free-text reply is accepted. */
  allowText: z.boolean(),
  /** Sort order (smaller first), decided by the daemon from kind and age. */
  priority: z.number(),
  refs: AttentionRefs,
  resolution: AttentionResolution.nullable(),
  createdAt: Timestamp,
  resolvedAt: Timestamp.nullable(),
});
export type Attention = z.infer<typeof Attention>;

/** Choices the daemon attaches per kind (questions carry the asker's own choices). */
export const ATTENTION_DEFAULT_CHOICES = {
  question: [],
  approval: [
    { id: 'approve', label: '許可', tone: 'primary' },
    { id: 'reject', label: '拒否', tone: 'danger' },
  ],
  failure: [
    { id: 'retry', label: '再試行', tone: 'primary' },
    { id: 'stop', label: '終える', tone: 'neutral' },
  ],
  review: [
    { id: 'accept', label: '採用', tone: 'primary' },
    { id: 'redo', label: 'やり直し', tone: 'neutral' },
  ],
  budget: [
    { id: 'add_1', label: '+$1', tone: 'primary' },
    { id: 'add_5', label: '+$5', tone: 'neutral' },
    { id: 'stop', label: '止める', tone: 'danger' },
  ],
  stuck: [
    { id: 'continue', label: '続ける', tone: 'primary' },
    { id: 'stop', label: '止める', tone: 'danger' },
  ],
} as const satisfies Record<AttentionKind, AttentionChoice[]>;

/** Whether a kind accepts a free-text reply by default. */
export const ATTENTION_ALLOWS_TEXT = {
  question: true,
  approval: false,
  failure: true,
  review: true,
  budget: false,
  stuck: true,
} as const satisfies Record<AttentionKind, boolean>;

export const attentionDomain = {
  AttentionKind,
  AttentionStatus,
  AttentionChoice,
  AttentionRefs,
  AttentionResolution,
  Attention,
  ATTENTION_DEFAULT_CHOICES,
  ATTENTION_ALLOWS_TEXT,
} as const;

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

export const attentionMethods = {
  'human.ask': {
    params: params({
      question: z.string().min(1).max(200).describe('One line, as the person should read it'),
      choices: z
        .array(z.string().min(1).max(40))
        .max(4)
        .optional()
        .describe('Up to 4 short answers to pick from'),
      allowText: z.boolean().default(true).describe('Accept a free-text answer too'),
      detail: z.string().max(2000).optional().describe('Background shown when expanded'),
    }),
    result: z.object({ attentionId: AttentionId, status: z.literal('asked') }),
    description:
      'Ask a human a question and return immediately (non-blocking). The answer arrives later as a message in this session, which starts a new run. If you cannot continue without the answer, finish your current work here and say what you are waiting for.',
    mutates: true,
  },
  'attention.list': {
    params: params({
      status: z.array(AttentionStatus).optional().describe('Default: open only'),
      rootSessionId: SessionId.optional(),
      sessionId: SessionId.optional(),
      limit: Limit(200, 50),
      cursor: Cursor.optional(),
    }),
    result: page(Attention),
    description:
      'List items waiting for a human (questions, approvals, failures, ...), by priority.',
  },
  'attention.respond': {
    params: params({
      attentionId: AttentionId,
      choiceId: z.string().min(1).max(40).optional(),
      text: z.string().min(1).max(20_000).optional(),
    }),
    result: Attention,
    description:
      'Answer an attention item with one of its choices and/or text. Agents may only answer questions asked inside their own tree.',
    mutates: true,
  },
  'attention.dismiss': {
    params: params({ attentionId: AttentionId }),
    result: Attention,
    description: 'Dismiss an attention item without acting on it. Humans only.',
    tool: false,
    mutates: true,
  },
} as const satisfies Record<string, MethodDef>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const attentionEvents = {
  'attention.opened': z.object({ attention: Attention }),
  'attention.resolved': z.object({ attention: Attention }),
} as const;
