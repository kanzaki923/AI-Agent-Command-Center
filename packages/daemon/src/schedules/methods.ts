import {
  type Actor,
  type AgentActor,
  type Params,
  type Schedule,
  type ScheduleRunSpec,
  DEFAULT_SCHEDULE_RUN,
  matchAnyPattern,
} from '@acc/protocol';
import { type CallScope, defineMethod } from '../api/registry';
import type { DaemonContext } from '../core/context';
import { ApiError, conflict, forbidden, invalidParams, limitExceeded } from '../core/errors';
import { type Scheduler, truncate } from './scheduler';
import { nextFires, nextRunAfter, normalizeTrigger } from './time';

/** Schedules an AI may keep running at once when its grant names no `maxSchedules`. */
export const DEFAULT_MAX_SCHEDULES = 5;
const DEFAULT_TITLE_CHARS = 40;

type RunInput = NonNullable<Params<'schedule.create'>['run']>;

function mergeRun(base: ScheduleRunSpec, input: RunInput | undefined): ScheduleRunSpec {
  const out = { ...base };
  for (const [k, v] of Object.entries(input ?? {})) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** A title from the first line of the prompt (shown on the schedule and on each firing). */
export function defaultTitle(prompt: string): string {
  const line = prompt.split('\n').find((l) => l.trim()) ?? prompt;
  return truncate(line.trim().replace(/\s+/g, ' '), DEFAULT_TITLE_CHARS) || '繰り返し';
}

/** Projects and sessions a schedule touches (owner session, worktree project). */
function scheduleScope(
  ctx: DaemonContext,
  sessionId: string | null,
  run?: { workspace?: ScheduleRunSpec['workspace'] | undefined },
): CallScope {
  const owner = sessionId ? ctx.repos.sessions.get(sessionId) : undefined;
  const projectIds = new Set<string>();
  if (owner?.projectId) projectIds.add(owner.projectId);
  if (run?.workspace?.kind === 'worktree') projectIds.add(run.workspace.projectId);
  return { projectIds: [...projectIds], sessionIds: sessionId ? [sessionId] : [] };
}

function existingScope(ctx: DaemonContext, scheduleId: string, run?: RunInput): CallScope {
  const s = ctx.repos.schedules.get(scheduleId);
  if (!s) return { projectIds: [] };
  const scope = scheduleScope(ctx, s.sessionId, run ?? s.run);
  if (run?.workspace === undefined) {
    const existing = scheduleScope(ctx, s.sessionId, s.run);
    scope.projectIds = [...new Set([...scope.projectIds, ...existing.projectIds])];
  }
  return scope;
}

/** Agents never let a fired child lead children of its own (spec §3.11). */
function assertNoSupervise(actor: Actor, run: RunInput | undefined): void {
  if (actor.kind === 'agent' && run?.supervise) {
    throw forbidden('AI が作る繰り返しでは、子に子を起こさせることはできません');
  }
}

/** A human-made schedule may spend root budgets; agents only change schedules an AI made. */
function assertAgentMayChange(actor: Actor, s: Schedule): void {
  if (actor.kind === 'agent' && s.createdBy.kind !== 'agent') {
    throw forbidden('人が作った繰り返しは、AI からは変更・実行できません');
  }
}

function assertWorkspace(ctx: DaemonContext, run: ScheduleRunSpec): void {
  if (run.mode === 'agent' && run.workspace.kind === 'worktree') {
    const project = ctx.repos.projects.require(run.workspace.projectId);
    if (!project.repoPath)
      throw invalidParams('コードの作業場所には、リポジトリのあるプロジェクトが必要です');
  }
}

/** Live (still going to fire) schedules an AI session created. */
function liveSchedulesOf(ctx: DaemonContext, sessionId: string): number {
  return ctx.repos.schedules.count({
    where: { enabled: true, next_run_at: { not: null } },
    sql: {
      clause:
        "json_extract(data, '$.createdBy.kind') = 'agent' AND json_extract(data, '$.createdBy.sessionId') = ?",
      params: [sessionId],
    },
  });
}

/** `limits.maxSchedules` of the grant that lets the agent create schedules (default 5). */
function assertScheduleLimit(ctx: DaemonContext, actor: AgentActor): void {
  const grant = ctx
    .service('policy')
    .grantsFor(actor)
    .find((g) => matchAnyPattern(g.permissions, 'schedule.create'));
  const max = grant?.limits.maxSchedules ?? DEFAULT_MAX_SCHEDULES;
  const live = liveSchedulesOf(ctx, actor.sessionId);
  if (live >= max) {
    throw limitExceeded(`AI が作れる繰り返しは ${max} 本までです（いま ${live} 本）`, {
      maxSchedules: max,
      live,
    });
  }
}

function emitCreated(ctx: DaemonContext, schedule: Schedule, actor: Actor): void {
  ctx.bus.emit({
    type: 'schedule.created',
    actor,
    payload: { schedule },
    refs: { sessionId: schedule.sessionId },
  });
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function scheduleMethods(ctx: DaemonContext, scheduler: Scheduler) {
  const defaultTz = () => ctx.settings.get().limits.timezone;

  return [
    defineMethod('schedule.create', {
      scope: (p) => scheduleScope(ctx, p.sessionId, p.run),
      handler: (p, call) => {
        const owner = ctx.repos.sessions.require(p.sessionId);
        if (owner.archivedAt) throw conflict('アーカイブされた会話には繰り返しを付けられません');
        assertNoSupervise(call.actor, p.run);
        if (call.actor.kind === 'agent') assertScheduleLimit(ctx, call.actor);
        const trigger = normalizeTrigger(p.trigger, defaultTz());
        const run = mergeRun(DEFAULT_SCHEDULE_RUN, p.run);
        assertWorkspace(ctx, run);
        const nowMs = ctx.clock.now();
        if (p.expiresAt && Date.parse(p.expiresAt) <= nowMs) {
          throw invalidParams('終わりの日時が過去です');
        }
        const enabled = p.enabled ?? true;
        const expiresAt = p.expiresAt ? new Date(p.expiresAt).toISOString() : null;
        const nextRunAt = nextRunAfter({ trigger, expiresAt }, nowMs);
        if (nextRunAt === null) throw invalidParams('この設定では一度も実行されません');
        const now = ctx.clock.iso();
        const schedule = ctx.db.transaction(() => {
          const s = ctx.repos.schedules.insert({
            id: ctx.ids.next('schedule'),
            sessionId: owner.id,
            title: p.title ?? defaultTitle(p.prompt),
            prompt: p.prompt,
            trigger,
            run,
            catchUp: p.catchUp ?? 'latest',
            maxLatenessMin: p.maxLatenessMin ?? 720,
            enabled,
            nextRunAt: enabled ? iso(nextRunAt) : null,
            lastRun: null,
            expiresAt,
            createdBy: call.actor,
            createdAt: now,
            updatedAt: now,
          });
          emitCreated(ctx, s, call.actor);
          return s;
        });
        scheduler.rearm();
        return schedule;
      },
    }),

    defineMethod('schedule.list', {
      scope: (p) => {
        const sessionId = p.sessionId ?? p.rootSessionId;
        return sessionId ? scheduleScope(ctx, sessionId) : { projectIds: [] };
      },
      handler: (p, call) => {
        let owners: string[] | undefined;
        if (p.sessionId) owners = [p.sessionId];
        if (p.rootSessionId) {
          const tree = ctx.repos.sessions
            .find({ where: { root_session_id: p.rootSessionId } })
            .map((s) => s.id);
          owners = owners ? owners.filter((id) => tree.includes(id)) : tree;
        }
        let items = ctx.repos.schedules.find({
          where: {
            ...(owners ? { session_id: owners } : {}),
            ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
          },
        });
        const actor = call.actor;
        if (actor.kind === 'agent' && !owners) {
          // Without a filter an agent sees only its own session tree.
          const policy = ctx.service('policy');
          items = items.filter((s) => policy.isInSessionTree(s.sessionId, actor.sessionId));
        }
        items.sort(
          (a, b) =>
            (a.nextRunAt ?? '￿').localeCompare(b.nextRunAt ?? '￿') ||
            a.createdAt.localeCompare(b.createdAt),
        );
        return { items };
      },
    }),

    defineMethod('schedule.get', {
      scope: (p) => existingScope(ctx, p.scheduleId),
      handler: (p) => ctx.repos.schedules.require(p.scheduleId),
    }),

    defineMethod('schedule.update', {
      scope: (p) => existingScope(ctx, p.scheduleId, p.run),
      handler: (p, call) => {
        const cur = ctx.repos.schedules.require(p.scheduleId);
        assertAgentMayChange(call.actor, cur);
        assertNoSupervise(call.actor, p.run);
        const next: Schedule = {
          ...cur,
          ...(p.title !== undefined ? { title: p.title } : {}),
          ...(p.prompt !== undefined ? { prompt: p.prompt } : {}),
          ...(p.trigger ? { trigger: normalizeTrigger(p.trigger, defaultTz()) } : {}),
          run: mergeRun(cur.run, p.run),
          ...(p.catchUp !== undefined ? { catchUp: p.catchUp } : {}),
          ...(p.maxLatenessMin !== undefined ? { maxLatenessMin: p.maxLatenessMin } : {}),
          ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
          ...(p.expiresAt !== undefined
            ? { expiresAt: p.expiresAt === null ? null : new Date(p.expiresAt).toISOString() }
            : {}),
        };
        if (p.run) assertWorkspace(ctx, next.run);
        const fields = [
          'title',
          'prompt',
          'trigger',
          'run',
          'catchUp',
          'maxLatenessMin',
          'enabled',
          'expiresAt',
        ] as const;
        const changes: string[] = fields.filter(
          (f) => JSON.stringify(cur[f]) !== JSON.stringify(next[f]),
        );
        const timing = changes.some((c) => c === 'trigger' || c === 'enabled' || c === 'expiresAt');
        if (timing) {
          if (!next.enabled) {
            next.nextRunAt = null;
          } else {
            const nowMs = ctx.clock.now();
            const at = nextRunAfter(next, nowMs);
            if (at === null) throw invalidParams('この設定では、これ以上実行されません');
            // Re-enabling does not catch up on what was missed while disabled.
            next.nextRunAt = iso(at);
            if (call.actor.kind === 'agent' && cur.nextRunAt === null) {
              assertScheduleLimit(ctx, call.actor);
            }
          }
          if (next.nextRunAt !== cur.nextRunAt) changes.push('nextRunAt');
        }
        if (changes.length === 0) return cur;
        next.updatedAt = ctx.clock.iso();
        const saved = ctx.db.transaction(() => {
          const s = ctx.repos.schedules.update(cur.id, () => next);
          scheduler.emitUpdated(s, changes, call.actor);
          return s;
        });
        scheduler.rearm();
        return saved;
      },
    }),

    defineMethod('schedule.delete', {
      scope: (p) => existingScope(ctx, p.scheduleId),
      handler: (p, call) => {
        const cur = ctx.repos.schedules.require(p.scheduleId);
        assertAgentMayChange(call.actor, cur);
        ctx.db.transaction(() => {
          ctx.repos.schedules.delete(cur.id);
          ctx.bus.emit({
            type: 'schedule.deleted',
            actor: call.actor,
            payload: { scheduleId: cur.id },
            refs: { sessionId: cur.sessionId },
          });
        });
        scheduler.rearm();
        return { ok: true as const };
      },
    }),

    defineMethod('schedule.runNow', {
      scope: (p) => existingScope(ctx, p.scheduleId),
      handler: async (p, call) => {
        const cur = ctx.repos.schedules.require(p.scheduleId);
        assertAgentMayChange(call.actor, cur);
        const r = await scheduler.fireDetailed(cur.id, ctx.clock.iso());
        if (r.outcome === 'started' && r.sessionId) return { sessionId: r.sessionId };
        throw new ApiError(r.code ?? 'internal', r.error ?? '始められませんでした', {
          outcome: r.outcome,
        });
      },
    }),

    defineMethod('schedule.preview', {
      handler: (p) => {
        const trigger = normalizeTrigger(p.trigger, defaultTz());
        return { times: nextFires(trigger, ctx.clock.now(), p.count).map((t) => iso(t)!) };
      },
    }),
  ];
}
