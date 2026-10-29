import {
  type Actor,
  type AgentActor,
  type BudgetAllocation,
  type CapabilityGrant,
  type Params,
  matchAnyPattern,
} from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { forbidden, invalidParams } from '../core/errors';
import { setSupervision } from '../inbox/supervision';

/**
 * The orchestrator preset (concept §3.1, §11): plan and create tasks, start and supervise
 * workers, read sessions / runs / workspaces / artifacts / events, build integrations.
 * Deliberately NOT included: integration.approve (humans only, enforced elsewhere too),
 * grant.*, budget.*, session.create/send, settings, project changes.
 */
export const ORCHESTRATOR_PERMISSIONS = [
  'task.*',
  'project.get',
  'session.list',
  'session.get',
  'session.messages',
  'run.list',
  'run.get',
  'run.cancel',
  'approval.list',
  'workspace.list',
  'workspace.get',
  'workspace.diff',
  'artifact.*',
  'integration.create',
  'integration.run',
  'integration.resolveWithAgent',
  'integration.get',
  'integration.list',
  'integration.wait',
  'events.list',
  'orchestrator.*',
] as const;

/** Delegation depth below an orchestrator: it may start workers, workers may not. */
export const ORCHESTRATOR_MAX_DEPTH = 1;

/** What the older orchestrator preset is granted with (defaults: 2 workers, the next run). */
export interface OrchestratorPresetInput {
  sessionId: string;
  /** Project to orchestrate; defaults to the session's. */
  projectId?: string;
  maxWorkers?: number;
  lifetime?: 'run' | 'session';
  /** Root budget for the session's runs; workers get slices of it. */
  budgetUsd?: number;
  expiresAt?: string;
}

/**
 * The older orchestrator preset (tasks, task.spawnWorker, the blocking waits) for one project,
 * optionally with a root budget. Humans only. No method grants it any more —
 * `session.grantOrchestration` is an alias of `session.delegate` (spec 20261029 §7.11 M12) —
 * but the executor still runs sessions that hold it (an existing grant, or one a human made
 * with grant.create), so tests of that path call this directly.
 */
export function grantOrchestratorPreset(
  ctx: DaemonContext,
  p: OrchestratorPresetInput,
  actor: Actor,
): { grant: CapabilityGrant; budget: BudgetAllocation | null } {
  if (actor.kind === 'agent') {
    throw forbidden('Orchestrator の権限を付与できるのは人間だけです');
  }
  return ctx.db.transaction(() => {
    const session = ctx.repos.sessions.require(p.sessionId);
    if (session.kind !== 'chat') {
      throw invalidParams('Orchestrator にできるのはチャットセッションだけです');
    }
    const projectId = p.projectId ?? session.projectId;
    if (!projectId) {
      throw invalidParams('どのプロジェクトを指揮するか projectId で指定してください');
    }
    const project = ctx.repos.projects.require(projectId);
    const grant = ctx.service('policy').createGrant(
      {
        subject: { kind: 'session', sessionId: session.id },
        permissions: [...ORCHESTRATOR_PERMISSIONS],
        scope: { projectIds: [project.id] },
        limits: { maxWorkers: p.maxWorkers ?? 2, maxDepth: ORCHESTRATOR_MAX_DEPTH },
        lifetime: p.lifetime ?? 'run',
        expiresAt: p.expiresAt ?? null,
        reason: `orchestrator: ${project.name}`,
      },
      actor,
    );
    const budget =
      p.budgetUsd === undefined
        ? null
        : ctx.service('budget').createRoot({
            subject: { kind: 'session', id: session.id },
            limitUsd: p.budgetUsd,
            actor,
          });
    return { grant, budget };
  });
}

/**
 * Active grants of a run that make it an orchestrator: they allow starting children
 * (session.spawn, the supervisor preset) or workers (task.spawnWorker, the older preset).
 */
export function orchestrationGrants(ctx: DaemonContext, actor: AgentActor): CapabilityGrant[] {
  return ctx
    .service('policy')
    .grantsFor(actor)
    .filter(
      (g) =>
        matchAnyPattern(g.permissions, 'session.spawn') ||
        matchAnyPattern(g.permissions, 'task.spawnWorker'),
    );
}

// ---------------------------------------------------------------------------
// Supervisor (session.delegate, spec 20261029 §3.9)
// ---------------------------------------------------------------------------

/**
 * The supervisor preset: start children (session.spawn) and talk to, stop, resume and
 * inspect them; read and send back their outputs; answer their questions; ask the human;
 * see the cost; record decisions. The session-tree scope keeps every session.* call inside
 * the supervisor's own tree. Not included: approvals of tool uses, accepting code (humans),
 * grants, budgets, settings, project changes.
 */
export const SUPERVISOR_PERMISSIONS = [
  'session.spawn',
  'session.send',
  'session.stop',
  'session.resume',
  'session.tree',
  'session.get',
  'session.messages',
  'session.update',
  'artifact.list',
  'artifact.get',
  'artifact.read',
  'artifact.review',
  'attention.list',
  'attention.respond',
  'human.ask',
  'cost.summary',
  'orchestrator.recordDecision',
  'project.get',
] as const;

/** Added when the supervisor may create schedules (`allowSchedules`). */
export const SUPERVISOR_SCHEDULE_PERMISSIONS = ['schedule.*'] as const;

/** Added only for a project with a repository: combining several children's code changes. */
export const SUPERVISOR_CODE_PERMISSIONS = [
  'integration.create',
  'integration.run',
  'integration.get',
  'integration.list',
  'integration.resolveWithAgent',
  'workspace.diff',
] as const;

/** Schedules a supervisor may own by default (GrantLimits.maxSchedules). */
export const SUPERVISOR_MAX_SCHEDULES = 5;

/** Recorded as the grant's reason. */
export const SUPERVISOR_REASON = 'supervisor';

export function supervisorPermissions(opts: { schedules: boolean; code: boolean }): string[] {
  return [
    ...SUPERVISOR_PERMISSIONS,
    ...(opts.schedules ? SUPERVISOR_SCHEDULE_PERMISSIONS : []),
    ...(opts.code ? SUPERVISOR_CODE_PERMISSIONS : []),
  ];
}

/** Active session grants that make the session a supervisor (they allow session.spawn). */
export function supervisorGrantsOf(ctx: DaemonContext, sessionId: string): CapabilityGrant[] {
  return ctx.service('policy').sessionGrantsAllowing(sessionId, 'session.spawn');
}

/**
 * session.delegate (humans only): let a chat lead children with one click — the supervisor
 * preset limited to the session's project (or none), `maxChildren` unfinished children at
 * once, depth 1 (children cannot spawn), and a root budget for the session's own runs and
 * its children. Delegating again replaces the previous supervisor grant (new limits); an
 * active budget of the session is kept.
 */
export function delegateSession(
  ctx: DaemonContext,
  p: Params<'session.delegate'>,
  actor: Actor,
): { grant: CapabilityGrant; budget: BudgetAllocation | null } {
  if (actor.kind === 'agent') {
    throw forbidden('会話を任せる設定ができるのは人間だけです');
  }
  return ctx.db.transaction(() => {
    const session = ctx.repos.sessions.require(p.sessionId);
    if (session.kind !== 'chat') {
      throw invalidParams('任せられるのは普通の会話だけです');
    }
    if (session.archivedAt) throw invalidParams('アーカイブ済みの会話には任せられません');
    const projectId = p.projectId === undefined ? session.projectId : p.projectId;
    const project = projectId ? ctx.repos.projects.require(projectId) : null;
    const policy = ctx.service('policy');
    for (const g of supervisorGrantsOf(ctx, session.id)) {
      policy.revoke(g.id, actor, 'replaced by session.delegate');
    }
    const grant = policy.createGrant(
      {
        subject: { kind: 'session', sessionId: session.id },
        permissions: supervisorPermissions({
          schedules: p.allowSchedules,
          code: !!project?.repoPath,
        }),
        // Without a project, the session-tree scope is what limits it.
        scope: project ? { projectIds: [project.id] } : {},
        limits: {
          maxChildren: p.maxChildren,
          maxSchedules: p.allowSchedules ? SUPERVISOR_MAX_SCHEDULES : 0,
          maxDepth: ORCHESTRATOR_MAX_DEPTH,
        },
        lifetime: p.lifetime,
        expiresAt: p.expiresAt ?? null,
        reason: SUPERVISOR_REASON,
      },
      actor,
    );
    const existing = ctx.repos.budgets.findOne({
      where: { subject_kind: 'session', subject_id: session.id, status: 'active' },
    });
    const budget =
      existing ??
      ctx.service('budget').createRoot({
        subject: { kind: 'session', id: session.id },
        limitUsd: p.budgetUsd,
        actor,
      });
    setSupervision(ctx, session.id, 'active', actor);
    return { grant, budget };
  });
}

/** session.undelegate (humans only): revoke the session's supervisor grants. */
export function undelegateSession(
  ctx: DaemonContext,
  sessionId: string,
  actor: Actor,
): { revoked: string[] } {
  if (actor.kind === 'agent') {
    throw forbidden('任せる設定を外せるのは人間だけです');
  }
  return ctx.db.transaction(() => {
    ctx.repos.sessions.require(sessionId);
    const policy = ctx.service('policy');
    const revoked: string[] = [];
    for (const g of supervisorGrantsOf(ctx, sessionId)) {
      policy.revoke(g.id, actor, 'session.undelegate');
      revoked.push(g.id);
    }
    return { revoked };
  });
}
