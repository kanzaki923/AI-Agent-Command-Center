import {
  type Actor,
  type AgentActor,
  type CapabilityGrant,
  type EventRefs,
  type GrantLifetime,
  type GrantLimits,
  type GrantScope,
  type GrantSubject,
  TERMINAL_RUN_STATUSES,
  isTerminalRunStatus,
  matchAnyPattern,
} from '@acc/protocol';
import {
  GrantPolicyEngine,
  type PolicyDecision,
  type PolicyEngine,
  grantAllows,
  grantAppliesTo,
} from '../api/policy';
import type { CallScope } from '../api/registry';
import type { DaemonContext } from '../core/context';
import {
  ApiError,
  conflict,
  forbidden,
  invalidParams,
  limitExceeded,
  notFound,
} from '../core/errors';
import { anyPatternContains } from './patterns';

export interface CreateGrantInput {
  subject: GrantSubject;
  permissions: string[];
  scope?: GrantScope;
  limits?: GrantLimits;
  lifetime?: GrantLifetime;
  expiresAt?: string | null;
  /** Grant to delegate from. Required for agents unless one of their grants fits (auto-picked). */
  parentGrantId?: string | null;
  reason?: string | null;
}

export interface CreateGrantOptions {
  /**
   * Permission the parent grant must hold to delegate (rule a). `grant.create` for explicit
   * delegation; `task.spawnWorker` when a worker's grant is carved out while spawning it.
   */
  via?: string;
}

/** Reason recorded when a grant ends because its run ended. */
export const RUN_ENDED = 'run_ended';

const NON_TERMINAL_RUN_STATUSES = ['created', 'queued', 'running', 'awaiting_approval'] as const;

/**
 * Capability grants: creation with delegation rules, cascade revocation, run-lifetime expiry,
 * and the PolicyEngine used by the dispatcher (`ctx.policy`). Available as
 * `ctx.service('policy')`.
 *
 * Delegation rules (an agent, or anyone passing `parentGrantId`, creating a child grant):
 *   (a) the parent applies to the agent and holds `opts.via` (default `grant.create`)
 *   (b) every requested permission is contained in the parent's patterns
 *   (c) scope.projectIds ⊆ parent's (omitted = inherit the parent's)
 *   (d) limits <= parent's (omitted = inherit; maxDepth shrinks by one per level)
 *   (e) depth = parent.depth + 1 <= settings.maxDelegationDepth and parent.limits.maxDepth >= 1
 */
export class PolicyService implements PolicyEngine {
  private readonly base: GrantPolicyEngine;

  constructor(private readonly ctx: DaemonContext) {
    this.base = new GrantPolicyEngine((a) => this.activeGrantsFor(a), ctx.clock);
  }

  // -------------------------------------------------------------------------
  // PolicyEngine
  // -------------------------------------------------------------------------

  check(actor: Actor, permission: string, scope: CallScope | undefined): PolicyDecision {
    const decision = this.base.check(actor, permission, scope);
    if (!decision.allowed && actor.kind === 'agent') {
      this.recordDenial(actor, permission, decision.reason, scope);
    }
    return decision;
  }

  /** Same decision as `check`, without auditing a denial (e.g. to decide which tools to offer). */
  peek(actor: Actor, permission: string, scope: CallScope | undefined): PolicyDecision {
    return this.base.check(actor, permission, scope);
  }

  /** Emit `policy.denied` so refusals show up in the timeline next to tool calls. */
  recordDenial(
    actor: AgentActor,
    permission: string,
    reason: string,
    scope: CallScope | undefined,
  ): void {
    const projectIds = scope ? scope.projectIds : null;
    try {
      this.ctx.bus.emit({
        type: 'policy.denied',
        actor,
        payload: { permission, reason, projectIds },
        refs: {
          runId: actor.runId,
          sessionId: actor.sessionId,
          projectId: projectIds?.length === 1 ? projectIds[0] : null,
        },
      });
    } catch (err) {
      // Auditing must never turn a clean "forbidden" into an internal error.
      this.ctx.log.warn('failed to record policy denial', { err });
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Non-revoked grants whose subject is the actor's run or session (expiry not applied). */
  private activeGrantsFor(actor: AgentActor): CapabilityGrant[] {
    return this.ctx.repos.grants.find({
      where: { revoked_at: null },
      sql: {
        clause:
          "(subject_kind = 'run' AND subject_id = ?) OR (subject_kind = 'session' AND subject_id = ?)",
        params: [actor.runId, actor.sessionId],
      },
      direction: 'asc',
    });
  }

  isActive(grant: CapabilityGrant, nowIso = this.ctx.clock.iso()): boolean {
    return !grant.revokedAt && !(grant.expiresAt && grant.expiresAt <= nowIso);
  }

  /** Active (non-revoked, non-expired) grants that apply to this agent, oldest first. */
  grantsFor(actor: AgentActor): CapabilityGrant[] {
    const now = this.ctx.clock.iso();
    return this.activeGrantsFor(actor).filter(
      (g) => grantAppliesTo(g, actor) && this.isActive(g, now),
    );
  }

  /**
   * Active session-subject grants of a session that allow `permission` (project scope not
   * applied). Decides whether the session's next run starts as an orchestrator.
   */
  sessionGrantsAllowing(sessionId: string, permission: string): CapabilityGrant[] {
    const now = this.ctx.clock.iso();
    return this.ctx.repos.grants
      .find({
        where: { revoked_at: null, subject_kind: 'session', subject_id: sessionId },
        direction: 'asc',
      })
      .filter((g) => this.isActive(g, now) && matchAnyPattern(g.permissions, permission));
  }

  sessionAllows(sessionId: string, permission: string): boolean {
    return this.sessionGrantsAllowing(sessionId, permission).length > 0;
  }

  /** Every grant delegated (directly or transitively) from `grantId`. */
  descendants(grantId: string): CapabilityGrant[] {
    const out: CapabilityGrant[] = [];
    const queue = [grantId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const child of this.ctx.repos.grants.find({
        where: { parent_grant_id: id },
        direction: 'asc',
      })) {
        out.push(child);
        queue.push(child.id);
      }
    }
    return out;
  }

  /** Grants an agent may see: its own active grants and everything delegated from them. */
  visibleTo(actor: AgentActor): Set<string> {
    const ids = new Set<string>();
    for (const g of this.grantsFor(actor)) {
      ids.add(g.id);
      for (const d of this.descendants(g.id)) ids.add(d.id);
    }
    return ids;
  }

  list(q: { runId?: string; sessionId?: string; includeRevoked: boolean }, actor: Actor) {
    const or: string[] = [];
    const params: string[] = [];
    if (q.runId) {
      or.push("(subject_kind = 'run' AND subject_id = ?)");
      params.push(q.runId);
    }
    if (q.sessionId) {
      or.push("(subject_kind = 'session' AND subject_id = ?)");
      params.push(q.sessionId);
    }
    let items = this.ctx.repos.grants.find({
      ...(q.includeRevoked ? {} : { where: { revoked_at: null } }),
      ...(or.length > 0 ? { sql: { clause: or.join(' OR '), params } } : {}),
      direction: 'asc',
    });
    if (!q.includeRevoked) {
      const now = this.ctx.clock.iso();
      items = items.filter((g) => this.isActive(g, now));
    }
    if (actor.kind === 'agent') {
      const visible = this.visibleTo(actor);
      items = items.filter((g) => visible.has(g.id));
    }
    return items;
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  createGrant(
    input: CreateGrantInput,
    actor: Actor,
    opts: CreateGrantOptions = {},
  ): CapabilityGrant {
    const { ctx } = this;
    return this.audit(actor, opts.via ?? 'grant.create', () =>
      ctx.db.transaction(() => {
        const now = ctx.clock.iso();
        this.assertSubject(input.subject);
        if (input.expiresAt && input.expiresAt <= now) {
          throw invalidParams('expiresAt must be in the future');
        }
        const requested = {
          permissions: [...new Set(input.permissions)],
          scope: input.scope ?? {},
          limits: input.limits ?? {},
          expiresAt: input.expiresAt ?? null,
        };

        let resolved: {
          parent: CapabilityGrant | null;
          scope: GrantScope;
          limits: GrantLimits;
          expiresAt: string | null;
          depth: number;
        };
        if (actor.kind === 'agent') {
          resolved = this.resolveDelegation(actor, input.parentGrantId ?? null, requested, opts);
        } else if (input.parentGrantId) {
          // Humans/system may attach a grant below an existing one (so it is revoked with it);
          // the subset rules still apply, the "holds grant.create" rule does not.
          const parent = ctx.repos.grants.get(input.parentGrantId);
          if (!parent) throw notFound('grant', input.parentGrantId);
          const r = this.checkDelegation(parent, requested, null);
          if (!r.ok) throw r.error;
          resolved = { parent, ...r.value };
        } else {
          resolved = {
            parent: null,
            scope: requested.scope,
            limits: requested.limits,
            expiresAt: requested.expiresAt,
            depth: 0,
          };
        }

        const grant = ctx.repos.grants.insert({
          id: ctx.ids.next('grant'),
          subject: input.subject,
          parentGrantId: resolved.parent?.id ?? null,
          permissions: requested.permissions,
          scope: resolved.scope,
          limits: resolved.limits,
          depth: resolved.depth,
          lifetime: input.lifetime ?? 'run',
          expiresAt: resolved.expiresAt,
          revokedAt: null,
          reason: input.reason ?? null,
          grantedBy: actor,
          createdAt: now,
        });
        ctx.bus.emit({
          type: 'grant.created',
          actor,
          payload: { grant },
          refs: this.refsFor(grant.subject),
        });
        return grant;
      }),
    );
  }

  /**
   * Run `fn`; when it refuses an agent (forbidden / limit_exceeded), record `policy.denied`
   * after the failed transaction rolled back (so the audit event is not rolled back with it).
   */
  audit<T>(actor: Actor, permission: string, fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (
        actor.kind === 'agent' &&
        err instanceof ApiError &&
        (err.code === 'forbidden' || err.code === 'limit_exceeded')
      ) {
        this.recordDenial(actor, permission, err.message, undefined);
      }
      throw err;
    }
  }

  private assertSubject(subject: GrantSubject): void {
    const { repos } = this.ctx;
    if (subject.kind === 'session') {
      repos.sessions.require(subject.sessionId);
      return;
    }
    const run = repos.runs.require(subject.runId);
    if (isTerminalRunStatus(run.status)) {
      throw conflict(`run ${run.id} has already ended (${run.status}); grants would never apply`);
    }
  }

  private resolveDelegation(
    actor: AgentActor,
    parentGrantId: string | null,
    requested: Requested,
    opts: CreateGrantOptions,
  ) {
    const via = opts.via ?? 'grant.create';
    const own = this.grantsFor(actor);
    let candidates: CapabilityGrant[];
    if (parentGrantId) {
      const parent = own.find((g) => g.id === parentGrantId);
      if (!parent) {
        throw forbidden(
          `grant ${parentGrantId} is not an active grant of this run; agents can only delegate their own grants`,
        );
      }
      candidates = [parent];
    } else {
      candidates = own;
      if (candidates.length === 0) {
        throw forbidden('no active capability grant to delegate from');
      }
    }
    let firstError: ApiError | null = null;
    for (const parent of candidates) {
      const r = this.checkDelegation(parent, requested, via);
      if (r.ok) return { parent, ...r.value };
      firstError ??= r.error;
    }
    throw firstError!;
  }

  /** Rules (a)–(e). `via` null skips rule (a) (human/system attaching a child grant). */
  private checkDelegation(
    parent: CapabilityGrant,
    req: Requested,
    via: string | null,
  ):
    | {
        ok: true;
        value: { scope: GrantScope; limits: GrantLimits; expiresAt: string | null; depth: number };
      }
    | { ok: false; error: ApiError } {
    const fail = (error: ApiError) => ({ ok: false as const, error });
    if (!this.isActive(parent)) {
      return fail(conflict(`parent grant ${parent.id} is revoked or expired`));
    }
    // (a)
    if (via && !matchAnyPattern(parent.permissions, via)) {
      return fail(forbidden(`grant ${parent.id} does not allow delegation ("${via}" not granted)`));
    }
    // (e)
    const maxDepth = this.ctx.settings.get().maxDelegationDepth;
    const depth = parent.depth + 1;
    if (depth > maxDepth) {
      return fail(
        limitExceeded(
          `delegation depth ${depth} exceeds the maximum (${maxDepth}); this grant cannot delegate further`,
          { depth, maxDepth },
        ),
      );
    }
    if (parent.limits.maxDepth !== undefined && parent.limits.maxDepth < 1) {
      return fail(
        limitExceeded(`grant ${parent.id} has limits.maxDepth 0 and cannot delegate`, {
          depth,
          maxDepth: parent.limits.maxDepth,
        }),
      );
    }
    // (b)
    const notHeld = req.permissions.filter((p) => !anyPatternContains(parent.permissions, p));
    if (notHeld.length > 0) {
      return fail(
        forbidden(
          `cannot delegate permissions not held by grant ${parent.id}: ${notHeld.join(', ')}`,
          { notHeld },
        ),
      );
    }
    // (c)
    let scope: GrantScope = req.scope;
    const parentProjects = parent.scope.projectIds;
    if (parentProjects) {
      if (!req.scope.projectIds) {
        scope = { ...req.scope, projectIds: [...parentProjects] };
      } else {
        const outside = req.scope.projectIds.filter((p) => !parentProjects.includes(p));
        if (outside.length > 0) {
          return fail(
            forbidden(
              `cannot delegate access to projects outside grant ${parent.id}: ${outside.join(', ')}`,
              {
                outside,
              },
            ),
          );
        }
      }
    }
    // (d)
    const limits: GrantLimits = { ...req.limits };
    const pw = parent.limits.maxWorkers;
    if (pw !== undefined) {
      if (limits.maxWorkers === undefined) limits.maxWorkers = pw;
      else if (limits.maxWorkers > pw) {
        return fail(forbidden(`limits.maxWorkers ${limits.maxWorkers} exceeds the parent's ${pw}`));
      }
    }
    if (parent.limits.maxDepth !== undefined) {
      const allowed = parent.limits.maxDepth - 1;
      if (limits.maxDepth === undefined) limits.maxDepth = allowed;
      else if (limits.maxDepth > allowed) {
        return fail(forbidden(`limits.maxDepth ${limits.maxDepth} exceeds the allowed ${allowed}`));
      }
    }
    // Lifetime: never outlive the parent.
    let expiresAt = req.expiresAt;
    if (parent.expiresAt && (!expiresAt || expiresAt > parent.expiresAt)) {
      expiresAt = parent.expiresAt;
    }
    return { ok: true, value: { scope, limits, expiresAt, depth } };
  }

  // -------------------------------------------------------------------------
  // Revoke / expire
  // -------------------------------------------------------------------------

  /**
   * Revoke a grant and everything delegated from it. Agents may only revoke grants that
   * were delegated from one of their own grants. Idempotent.
   */
  revoke(grantId: string, actor: Actor, reason: string | null = null): CapabilityGrant {
    const { ctx } = this;
    return this.audit(actor, 'grant.revoke', () =>
      ctx.db.transaction(() => {
        const grant = ctx.repos.grants.require(grantId);
        if (actor.kind === 'agent') {
          const own = this.grantsFor(actor).map((g) => g.id);
          const allowed = own.some((id) => this.descendants(id).some((d) => d.id === grantId));
          if (!allowed) throw forbidden('agents can only revoke grants they delegated');
        }
        return this.revokeTree(grant, actor, reason);
      }),
    );
  }

  private revokeTree(grant: CapabilityGrant, actor: Actor, reason: string | null): CapabilityGrant {
    const { ctx } = this;
    const now = ctx.clock.iso();
    const revokeOne = (g: CapabilityGrant): CapabilityGrant => {
      if (g.revokedAt) return g;
      const next = ctx.repos.grants.update(g.id, (cur) => ({ ...cur, revokedAt: now }));
      ctx.bus.emit({
        type: 'grant.revoked',
        actor,
        payload: { grantId: g.id, reason },
        refs: this.refsFor(g.subject),
      });
      return next;
    };
    const result = revokeOne(grant);
    for (const d of this.descendants(grant.id)) revokeOne(d);
    return result;
  }

  /**
   * A run ended: revoke grants that live only as long as it — grants for that run, and
   * run-lifetime grants given to its session ("allow this chat's next run only") — plus
   * everything delegated from them.
   */
  expireForRun(runId: string, sessionId: string | null): CapabilityGrant[] {
    const { ctx } = this;
    const actor: Actor = { kind: 'system', component: 'policy' };
    return ctx.db.transaction(() => {
      const ended: CapabilityGrant[] = ctx.repos.grants.find({
        where: { revoked_at: null, subject_kind: 'run', subject_id: runId },
        direction: 'asc',
      });
      if (sessionId) {
        ended.push(
          ...ctx.repos.grants
            .find({
              where: { revoked_at: null, subject_kind: 'session', subject_id: sessionId },
              direction: 'asc',
            })
            .filter((g) => g.lifetime === 'run'),
        );
      }
      return ended.map((g) => this.revokeTree(g, actor, RUN_ENDED));
    });
  }

  /**
   * Startup sweep: runs that ended while nobody listened (e.g. interrupted by recovery
   * before modules registered) still hold run grants. Revoke those.
   */
  sweepEndedRuns(): number {
    const { ctx } = this;
    let count = 0;
    const runGrants = ctx.repos.grants.find({ where: { revoked_at: null, subject_kind: 'run' } });
    const runIds = [
      ...new Set(runGrants.map((g) => (g.subject.kind === 'run' ? g.subject.runId : ''))),
    ];
    for (const runId of runIds) {
      const run = ctx.repos.runs.get(runId);
      if (run && isTerminalRunStatus(run.status)) count += this.expireForRun(run.id, null).length;
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Limits
  // -------------------------------------------------------------------------

  /** Worker runs started by this run that have not ended yet. */
  activeWorkerCount(parentRunId: string): number {
    return this.ctx.repos.runs.count({
      where: { parent_run_id: parentRunId, status: [...NON_TERMINAL_RUN_STATUSES] },
    });
  }

  /**
   * Called by task.spawnWorker before starting a worker. Humans/system: no limits (returns
   * null). Agents: needs an active grant that allows `task.spawnWorker` (in the project, when
   * given), may still delegate (depth), and has room under `limits.maxWorkers`. Returns that
   * grant — pass it as `parentGrantId` when creating the worker's grant
   * (`createGrant(..., { via: 'task.spawnWorker' })`).
   *
   * Call it synchronously right before `runs.start` (no await in between) so two spawns
   * cannot both take the last slot.
   */
  assertCanSpawnWorker(
    actor: Actor,
    opts: { projectId?: string | null } = {},
  ): CapabilityGrant | null {
    if (actor.kind !== 'agent') return null;
    const permission = 'task.spawnWorker';
    const scope: CallScope | undefined = opts.projectId
      ? { projectIds: [opts.projectId] }
      : undefined;
    const now = this.ctx.clock.iso();
    const candidates = this.grantsFor(actor).filter(
      (g) => grantAllows(g, permission, scope, now).ok,
    );
    const deny = (error: ApiError): never => {
      this.recordDenial(actor, permission, error.message, scope);
      throw error;
    };
    if (candidates.length === 0) {
      deny(forbidden(`no capability grant allows "${permission}" for this run`));
    }
    const maxDepth = this.ctx.settings.get().maxDelegationDepth;
    const active = this.activeWorkerCount(actor.runId);
    let firstError: ApiError | null = null;
    for (const g of candidates) {
      if (g.depth + 1 > maxDepth || (g.limits.maxDepth !== undefined && g.limits.maxDepth < 1)) {
        firstError ??= limitExceeded(
          `this run's grant (depth ${g.depth}) cannot spawn workers: the maximum delegation depth is ${maxDepth}`,
          { depth: g.depth + 1, maxDepth },
        );
        continue;
      }
      if (g.limits.maxWorkers !== undefined && active >= g.limits.maxWorkers) {
        firstError ??= limitExceeded(
          `worker limit reached: ${active} of ${g.limits.maxWorkers} workers are still active`,
          { active, maxWorkers: g.limits.maxWorkers },
        );
        continue;
      }
      return g;
    }
    return deny(firstError!);
  }

  // -------------------------------------------------------------------------

  /** Envelope refs for a grant subject (so grant events show up under the run/session). */
  refsFor(subject: GrantSubject): Partial<EventRefs> {
    if (subject.kind === 'session') {
      const s = this.ctx.repos.sessions.get(subject.sessionId);
      return { sessionId: subject.sessionId, projectId: s?.projectId ?? null };
    }
    const run = this.ctx.repos.runs.get(subject.runId);
    return {
      runId: subject.runId,
      sessionId: run?.sessionId ?? null,
      projectId: run?.projectId ?? null,
      taskId: run?.taskId ?? null,
    };
  }
}

interface Requested {
  permissions: string[];
  scope: GrantScope;
  limits: GrantLimits;
  expiresAt: string | null;
}

/** Event types that mean "this run is over". */
export function isRunEndEvent(type: string, to?: string): boolean {
  if (type === 'run.completed' || type === 'run.failed') return true;
  return (
    type === 'run.status_changed' &&
    to !== undefined &&
    (TERMINAL_RUN_STATUSES as readonly string[]).includes(to)
  );
}

declare module '../core/context' {
  interface Services {
    policy: PolicyService;
  }
}
