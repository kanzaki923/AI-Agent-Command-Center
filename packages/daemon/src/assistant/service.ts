import { type Actor, type Message, type Params, type Session, api } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { assertRosterModel, rosterPromptBlock } from '../llm/roster';
import { budgetExceeded, forbidden, limitExceeded } from '../core/errors';
import { dayOf, fromMicro } from '../cost/ledger';
import { delegateSession } from '../orchestrator/grant';
import {
  ASSISTANT_MAX_SCHEDULES,
  ASSISTANT_PERMISSIONS,
  ASSISTANT_REASON,
  ASSISTANT_SYSTEM,
  ASSISTANT_TITLE,
  MAX_TREES_PER_MESSAGE,
} from './permissions';
import type { AssistantNotifier } from './notify';
import { HINT_LABEL, MODEL_HINT_LABEL, buildAssistantPrompt, statusBlock } from './prompt';

/** Longest title taken from a request (the rest is in the conversation). */
export const REQUEST_TITLE_MAX = 40;

/**
 * A new conversation is named by what was asked: the first line of the request, cut at
 * REQUEST_TITLE_MAX characters.
 */
export function titleFromRequest(text: string): string {
  const line = text.trim().split(/\r?\n/)[0]!.trim();
  const chars = [...line];
  return chars.length > REQUEST_TITLE_MAX
    ? `${chars.slice(0, REQUEST_TITLE_MAX - 1).join('')}…`
    : line;
}

/**
 * The assistant (right-hand spec §1): one chat with a grant that reaches every tree. The
 * grant (`reason: assistant`, `scope.allSessions`) is what makes the session the assistant
 * and how it is found again; the chat executor asks this service for its model, its system
 * prompt (with the status of every tree) and its daily limit. Available as
 * `ctx.service('assistant')`.
 */
export class AssistantService {
  /** Speaks up when a tree ends or fails (notify.ts). Set by the module. */
  notifier!: AssistantNotifier;
  private cachedId: string | null = null;
  /** Roots started per run of the assistant (`MAX_TREES_PER_MESSAGE`). */
  private readonly started = new Map<string, number>();

  constructor(private readonly ctx: DaemonContext) {}

  /** Forget run counters when runs end. Returns the unsubscribe. */
  start(): () => void {
    return this.ctx.bus.subscribe({ types: ['run.status_changed'] }, (e) => {
      if (e.type === 'run.status_changed' && e.payload.to !== 'running') {
        this.started.delete(e.payload.runId);
      }
    });
  }

  /** The id of the assistant session when it exists (never creates it). */
  currentId(): string | null {
    if (this.cachedId && this.ctx.repos.sessions.get(this.cachedId)) return this.cachedId;
    const grant = this.ctx.repos.grants.findOne({
      where: { revoked_at: null, subject_kind: 'session' },
      sql: { clause: "json_extract(data, '$.reason') = ?", params: [ASSISTANT_REASON] },
    });
    const id = grant?.subject.kind === 'session' ? grant.subject.sessionId : null;
    this.cachedId = id && this.ctx.repos.sessions.get(id) ? id : null;
    return this.cachedId;
  }

  isAssistant(sessionId: string): boolean {
    return this.currentId() === sessionId;
  }

  /** The assistant session, created with its grant on first use. */
  ensure(): Session {
    const id = this.currentId();
    if (id) return this.ctx.repos.sessions.require(id);
    const { ctx } = this;
    return ctx.db.transaction(() => {
      const created = ctx
        .service('sessions')
        .create({ kind: 'chat', title: ASSISTANT_TITLE }, ASSISTANT_SYSTEM);
      // No model of its own: it follows settings.assistant.model / defaultModel until the
      // human picks one in its conversation (sessions/chat.ts resolveChatModel).
      const session = ctx.repos.sessions.update(created.id, (s) => ({ ...s, model: null }));
      ctx.service('policy').createGrant(
        {
          subject: { kind: 'session', sessionId: session.id },
          permissions: [...ASSISTANT_PERMISSIONS],
          scope: { allSessions: true },
          limits: { maxDepth: 0, maxSchedules: ASSISTANT_MAX_SCHEDULES },
          lifetime: 'session',
          reason: ASSISTANT_REASON,
        },
        ASSISTANT_SYSTEM,
      );
      this.cachedId = session.id;
      return session;
    });
  }

  /**
   * The two system messages of a run. The first never changes between runs (the role and
   * the own prompt of the session), so with the tools it is a stable prefix a prompt cache
   * can hold; the second carries what changes (the hint of the last message, the status of
   * every tree).
   */
  systemPrompts(session: Session, history: readonly Message[]): [string, string] {
    const last = [...history].reverse().find((m) => m.role === 'user');
    const meta = last?.meta?.kind === 'hint' ? last.meta : null;
    const hint =
      [
        meta?.text ? `${HINT_LABEL} ${meta.text}` : null,
        meta?.model ? `${MODEL_HINT_LABEL} ${meta.model}` : null,
      ]
        .filter(Boolean)
        .join('\n') || null;
    const fixed = [
      buildAssistantPrompt({
        maxTrees: MAX_TREES_PER_MESSAGE,
        models: rosterPromptBlock(
          this.ctx.settings.get(),
          this.ctx.hasService('pricing') ? this.ctx.service('pricing').lookup : null,
        ),
      }),
      session.systemPrompt,
    ]
      .filter(Boolean)
      .join('\n\n');
    const changing = [hint, statusBlock(this.ctx)].filter(Boolean).join('\n\n');
    return [fixed, changing];
  }

  /**
   * The model the person chose for the request a run of the assistant answers (`session.send`
   * workModel on the message that started the run), or null.
   */
  private chosenModel(runId: string): string | null {
    const run = this.ctx.repos.runs.get(runId);
    const msg = run?.triggerMessageId ? this.ctx.repos.messages.get(run.triggerMessageId) : null;
    if (!msg || msg.author.kind !== 'human' || msg.meta?.kind !== 'hint') return null;
    return msg.meta.model ?? null;
  }

  /** `settings.assistant.dailyUsd`: the own calls of the assistant stop for the day at the limit. */
  assertWithinDailyLimit(): void {
    const { ctx } = this;
    const settings = ctx.settings.get();
    const limit = settings.assistant.dailyUsd;
    const id = this.currentId();
    if (limit === null || !id) return;
    const day = dayOf(ctx.clock.iso(), settings.limits.timezone);
    const row = ctx.db.get<{ n: number | null }>(
      'SELECT SUM(cost_micro) AS n FROM usage_ledger WHERE day = ? AND session_id = ?',
      [day, id],
    );
    const used = fromMicro(row?.n ?? 0);
    if (used >= limit) {
      throw budgetExceeded(`右腕は今日の上限（$${limit}）に当たりました`, {
        limitUsd: limit,
        usedUsd: used,
      });
    }
  }

  /**
   * assistant.startWork (spec §1.2): a new root from the request — created, delegated when
   * asked, and sent the request as its first message. The calls of the assistant are
   * recorded under the `assistant` system actor (the root reads 右腕が始めた); a human calls
   * as themselves.
   */
  async startWork(p: Params<'assistant.startWork'>, actor: Actor): Promise<{ session: Session }> {
    const { ctx } = this;
    const viaAssistant = actor.kind === 'agent' && this.isAssistant(actor.sessionId);
    if (actor.kind === 'agent' && !viaAssistant) {
      throw forbidden('新しい会話を始められるのは人と右腕だけです');
    }
    // A model the person chose for this request wins over the assistant's pick (and over the
    // roster: it is theirs to choose).
    const personal = viaAssistant ? this.chosenModel(actor.runId) : null;
    const model = personal ?? p.model;
    if (p.model && !personal) {
      // The root is an agent when it works alone in a workspace (see below).
      const agent = !p.delegate && !!p.workspace && p.workspace.kind !== 'none';
      const runtime = ctx.settings.get().defaultRuntime ?? 'mock';
      assertRosterModel(ctx, actor, p.model, { agentRuntime: agent && runtime !== 'mock' });
    }
    if (actor.kind === 'agent') {
      const n = this.started.get(actor.runId) ?? 0;
      if (n >= MAX_TREES_PER_MESSAGE) {
        throw limitExceeded(
          `1 回に始められる会話は ${MAX_TREES_PER_MESSAGE} 本までです。残りは次の言葉で頼んでください`,
          { max: MAX_TREES_PER_MESSAGE },
        );
      }
      this.started.set(actor.runId, n + 1);
    }
    const creator: Actor = viaAssistant ? ASSISTANT_SYSTEM : actor;
    const chosen = p.workspace && p.workspace.kind !== 'none' ? p.workspace : undefined;
    // Only a conversation leads others: delegated, it stays a conversation in the chosen
    // project and its children get the workspace (code → worktrees) instead.
    const workspace = p.delegate ? undefined : chosen;
    const projectId =
      p.delegate && chosen?.kind === 'worktree' ? chosen.projectId : (p.projectId ?? undefined);
    const title = p.title?.trim() || titleFromRequest(p.text);
    const created = await ctx.call(creator, 'session.create', {
      kind: workspace ? 'agent' : 'chat',
      title,
      ...(projectId ? { projectId } : {}),
      ...(model ? { model } : {}),
      ...(workspace ? { workspace } : {}),
    });
    if (p.delegate) {
      delegateSession(
        ctx,
        api['session.delegate'].params.parse({ sessionId: created.id }),
        creator,
      );
    }
    await ctx.call(creator, 'session.send', {
      sessionId: created.id,
      content: p.text,
      ...(model ? { model } : {}),
    });
    return { session: ctx.repos.sessions.require(created.id) };
  }
}
