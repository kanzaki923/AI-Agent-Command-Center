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
  'integration.get',
  'integration.list',
  'integration.wait',
  'events.list',
  'orchestrator.*',
] as const;

/** Delegation depth below an orchestrator: it may start workers, workers may not. */
export const ORCHESTRATOR_MAX_DEPTH = 1;

/**
 * session.grantOrchestration: give a chat session the orchestrator preset for one project
 * (optionally with a root budget its runs spend from and slice for workers). Humans only —
 * agents delegate with grant.create, under the subset rules.
 */
export function grantOrchestration(
  ctx: DaemonContext,
  p: Params<'session.grantOrchestration'>,
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
        limits: { maxWorkers: p.maxWorkers, maxDepth: ORCHESTRATOR_MAX_DEPTH },
        lifetime: p.lifetime,
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

/** Active grants of a run that make it an orchestrator (they allow starting workers). */
export function orchestrationGrants(ctx: DaemonContext, actor: AgentActor): CapabilityGrant[] {
  return ctx
    .service('policy')
    .grantsFor(actor)
    .filter((g) => matchAnyPattern(g.permissions, 'task.spawnWorker'));
}
