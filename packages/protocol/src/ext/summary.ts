/**
 * Conversation summaries (snapshot 20261105_session-summaries_handoff.md): a running summary
 * the daemon keeps beside every long conversation, for recalling and finding it later. The
 * conversation's own model never reads it.
 */
import { z } from 'zod';
import { MessageId, SessionId, Timestamp } from '../common';
import { type MethodDef, params } from '../method';

/** Longest summary (characters). */
export const SUMMARY_MAX_CHARS = 1500;

export const SessionSummary = z.object({
  sessionId: SessionId,
  text: z.string(),
  /** The last message folded into it (messages after it are not in the summary yet). */
  upToMessageId: MessageId,
  /** Messages folded in so far. */
  messages: z.int().nonnegative(),
  updatedAt: Timestamp,
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const summaryMethods = {
  'session.summary': {
    params: params({ sessionId: SessionId }),
    result: z.object({ summary: SessionSummary.nullable() }),
    description:
      'The running summary of a long conversation (null while it is short or has none yet): what it is about, what was decided, what is open.',
  },
} as const satisfies Record<string, MethodDef>;

export const summaryEvents = {
  'session.summary_updated': z.object({ sessionId: SessionId, messages: z.int().nonnegative() }),
} as const;
