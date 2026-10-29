import {
  ATTENTION_ALLOWS_TEXT,
  ATTENTION_DEFAULT_CHOICES,
  type Actor,
  type Attention,
  type AttentionKind,
  type AttentionRefs,
  type AttentionResolution,
} from '@acc/protocol';
import type { AttentionResolutionInput, AttentionService, OpenAttentionInput } from '../contracts';
import type { DaemonContext } from '../core/context';
import { conflict } from '../core/errors';
import { attentionPriority } from './priority';
import { respondToAttention } from './respond';
import { oneLine } from './text';

/** The refs keys (fixed by the protocol; also the JSON paths matched in SQL). */
const REF_KEYS = [
  'approvalId',
  'runId',
  'artifactId',
  'integrationId',
  'budgetId',
  'askedBySessionId',
  'taskId',
] as const satisfies readonly (keyof AttentionRefs)[];

/** The given refs only (undefined keys dropped), in a fixed key order. */
function definedRefs(refs: AttentionRefs): [keyof AttentionRefs, string][] {
  return REF_KEYS.flatMap((k) => (refs[k] ? [[k, refs[k]] as [keyof AttentionRefs, string]] : []));
}

function sameRefs(a: AttentionRefs, b: AttentionRefs): boolean {
  return JSON.stringify(definedRefs(a)) === JSON.stringify(definedRefs(b));
}

function toResolution(input: AttentionResolutionInput): AttentionResolution {
  return { choiceId: input.choiceId ?? null, text: input.text ?? null, by: input.by };
}

/**
 * Attention items ("your turn", spec 20261029 §1.6, §3.6): the only writer of the
 * `attention` table. Items are opened by the module that saw the cause (approvals here,
 * failures and reviews by the child-run handling, budgets by the ledger, stuck runs by the
 * supervisor) and resolved when the cause goes away (sync.ts) or when someone responds.
 */
export class AttentionManager implements AttentionService {
  constructor(private readonly ctx: DaemonContext) {}

  /**
   * Open an item. An open item of the same kind, session and refs is returned instead of a
   * duplicate (a question also needs the same title: one run may ask several). A budget item
   * without a budget (the daily limit, the LiteLLM key) is one for the whole app.
   */
  open(input: OpenAttentionInput): Attention | null {
    const { ctx } = this;
    const session = ctx.repos.sessions.get(input.sessionId);
    if (!session) return null;
    const title = oneLine(input.title);
    if (!title) return null;
    return ctx.db.transaction(() => {
      const existing = this.findDuplicate(input.kind, session.id, input.refs, title);
      if (existing) return existing;
      const now = ctx.clock.iso();
      const choices = (input.choices ?? [...ATTENTION_DEFAULT_CHOICES[input.kind]]).slice(0, 4);
      const attention = ctx.repos.attention.insert({
        id: ctx.ids.next('attention'),
        kind: input.kind,
        status: 'open',
        sessionId: session.id,
        rootSessionId: session.rootSessionId,
        title,
        detail: input.detail?.trim() ? input.detail.trim() : null,
        choices,
        allowText: input.allowText ?? ATTENTION_ALLOWS_TEXT[input.kind],
        priority: attentionPriority(input.kind, now),
        refs: Object.fromEntries(definedRefs(input.refs)),
        resolution: null,
        createdAt: now,
        resolvedAt: null,
      });
      this.emit('attention.opened', attention, input.actor);
      return attention;
    });
  }

  resolveWhere(
    refs: AttentionRefs,
    resolution: AttentionResolutionInput,
    kinds?: readonly AttentionKind[],
  ): Attention[] {
    return this.resolveMatching(refs, resolution, kinds);
  }

  /** Resolve the open items whose refs include all of `refs` (optionally of some kinds only). */
  resolveMatching(
    refs: AttentionRefs,
    resolution: AttentionResolutionInput,
    kinds?: readonly AttentionKind[],
  ): Attention[] {
    const pairs = definedRefs(refs);
    // Never "everything": a match needs at least one ref.
    if (pairs.length === 0) return [];
    return this.resolveFound(
      {
        clause: pairs.map(([k]) => `json_extract(data, '$.refs.${k}') = ?`).join(' AND '),
        params: pairs.map(([, v]) => v),
      },
      resolution,
      kinds,
    );
  }

  /** Resolve a session's open items of the given kinds (its work moved on). */
  resolveSession(
    sessionId: string,
    kinds: readonly AttentionKind[],
    resolution: AttentionResolutionInput,
  ): Attention[] {
    return this.resolveFound({ clause: 'session_id = ?', params: [sessionId] }, resolution, kinds);
  }

  /**
   * Close one open item (`resolved`: acted on or the cause went away; `dismissed`: hidden
   * without acting). Throws conflict when it is no longer open.
   */
  close(
    attentionId: string,
    status: 'resolved' | 'dismissed',
    resolution: AttentionResolutionInput,
  ): Attention {
    const { ctx } = this;
    return ctx.db.transaction(() => {
      const cur = ctx.repos.attention.require(attentionId);
      if (cur.status !== 'open') {
        throw conflict('この出番はすでに対応済みです', { status: cur.status });
      }
      const attention = ctx.repos.attention.update(attentionId, (a) => ({
        ...a,
        status,
        resolution: toResolution(resolution),
        resolvedAt: ctx.clock.iso(),
      }));
      this.emit('attention.resolved', attention, resolution.by);
      return attention;
    });
  }

  respond(
    attentionId: string,
    input: { choiceId?: string | null; text?: string | null },
    actor: Actor,
  ): Promise<Attention> {
    return respondToAttention(this.ctx, this, attentionId, input, actor);
  }

  private resolveFound(
    sql: { clause: string; params: string[] },
    resolution: AttentionResolutionInput,
    kinds?: readonly AttentionKind[],
  ): Attention[] {
    const { ctx } = this;
    return ctx.db.transaction(() =>
      ctx.repos.attention
        .find({
          where: { status: 'open', ...(kinds ? { kind: [...kinds] } : {}) },
          sql,
          direction: 'asc',
        })
        .map((a) => this.close(a.id, 'resolved', resolution)),
    );
  }

  private findDuplicate(
    kind: AttentionKind,
    sessionId: string,
    refs: AttentionRefs,
    title: string,
  ): Attention | undefined {
    const global = kind === 'budget' && !refs.budgetId;
    return this.ctx.repos.attention
      .find({
        where: { status: 'open', kind, ...(global ? {} : { session_id: sessionId }) },
        direction: 'asc',
      })
      .find(
        (a) =>
          (global ? !a.refs.budgetId : sameRefs(a.refs, refs)) &&
          (kind !== 'question' || a.title === title),
      );
  }

  private emit(
    type: 'attention.opened' | 'attention.resolved',
    attention: Attention,
    actor: Actor,
  ): void {
    // Session and project only: an item belongs to the conversation (a run's or task's own
    // event list keeps its approval events, not their attention twins).
    this.ctx.bus.emit({
      type,
      actor,
      payload: { attention },
      refs: {
        sessionId: attention.sessionId,
        runId: null,
        taskId: null,
        projectId: this.ctx.repos.sessions.get(attention.sessionId)?.projectId ?? null,
      },
    });
  }
}
