import type { AttentionKind } from '@acc/protocol';

/**
 * Base priority per kind (smaller = shown first): decisions that block running work first,
 * then questions, money, stuck supervisors, failures, and outputs waiting for review.
 */
export const ATTENTION_KIND_PRIORITY: Record<AttentionKind, number> = {
  approval: 10,
  question: 20,
  budget: 30,
  stuck: 40,
  failure: 50,
  review: 60,
};

/**
 * Priority of an item: its kind's base, and within a kind the older first (the creation time
 * as a fraction below 1, so kinds never interleave).
 */
export function attentionPriority(kind: AttentionKind, createdAtIso: string): number {
  const t = Date.parse(createdAtIso);
  const age = Number.isFinite(t) ? t / 1e14 : 0; // < 1 until the year 5138
  return ATTENTION_KIND_PRIORITY[kind] + Math.min(0.999, Math.max(0, age));
}
