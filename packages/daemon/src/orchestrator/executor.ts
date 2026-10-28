import type { AgentActor, CapabilityGrant, Project } from '@acc/protocol';
import type { RunExecutor } from '../contracts';
import type { DaemonContext } from '../core/context';
import { apiTools, runToolLoop, toChatMessages } from '../llm';
import { chatHistory, requireChatModel } from '../sessions/chat';
import { orchestrationGrants } from './grant';

/** Model calls per orchestrator run (planning + supervising several workers takes many). */
export const ORCHESTRATOR_MAX_TURNS = 80;

/** Marker the prompt puts before the project id (the mock orchestrator reads it too). */
export const PROJECT_ID_LABEL = 'projectId:';

/**
 * System prompt of an orchestrator run: the role (plan, delegate, supervise, integrate —
 * never edit code), the project it works on and the limits the daemon enforces. Kept
 * short: the tool descriptions come from the Control API contract.
 */
export function buildOrchestratorPrompt(input: {
  project: Project | null;
  grant: CapabilityGrant | null;
}): string {
  const { project, grant } = input;
  const lines = [
    'You are the orchestrator in AI Agent Command Center. You lead coding agents ("workers") through the Control API tools. You never edit code yourself: you plan, delegate, supervise, integrate and report.',
    '',
  ];
  if (project) {
    lines.push(
      'Project',
      `- ${PROJECT_ID_LABEL} ${project.id}`,
      `- name: ${project.name}`,
      `- default branch: ${project.defaultBranch ?? '(repository default)'}`,
      `- test command: ${project.testCommand ?? '(none — integrations skip verification)'}`,
      '',
    );
  }
  const maxWorkers = grant?.limits.maxWorkers;
  lines.push(
    'Limits (enforced by the daemon, not by you)',
    `- at most ${maxWorkers ?? 'a few'} workers at the same time; workers cannot start workers`,
    '- only the human can approve an integration (integration.approve is not available to you)',
    '',
    'How to work',
    '1. Understand the goal. Split it into independent tasks that can run in parallel without editing the same files. Create each with task.create (projectId above) with a clear title, a description of what to change, and concrete acceptanceCriteria.',
    '2. Start one worker per ready task with task.spawnWorker. Each works in its own git worktree; its changes are committed and recorded as a diff when it finishes, and the task moves to review (or failed).',
    '3. Supervise with task.wait (mode "all", a long timeoutMs) instead of polling. Workers may be waiting for a human to approve a command — keep waiting; the snapshot shows pendingApprovals.',
    '4. When every task is in review, create one integration for them (integration.create with taskIds), start it (integration.run) and wait for it (integration.wait).',
    '5. If a task failed, or the integration ended in conflict or failed, do not integrate blindly: explain what failed and propose the next step.',
    '6. Record each key decision (decomposition, starting workers, integrating, stopping) with orchestrator.recordDecision: one line and a short rationale.',
    '7. Finish with a short report for the human: what was done, task ids, the integration id and its test result, and exactly what they need to review or approve.',
    '',
    'Always write to the user in Japanese.',
  );
  return lines.join('\n');
}

/**
 * Executor for `orchestrator` runs: a chat run with the orchestrator system prompt, the
 * Control API tools its grants allow (the same dispatcher as humans), and a larger turn
 * budget. Run kind `orchestrator` is chosen by session.send when the session's grants allow
 * task.spawnWorker — a normal chat becomes an orchestrator by capability, not by type.
 */
export function createOrchestratorExecutor(ctx: DaemonContext): RunExecutor {
  return async (ctl) => {
    const run = ctl.run;
    const session = ctx.repos.sessions.require(run.sessionId);
    const model = requireChatModel(ctx, run, session);
    const { project, grant } = orchestrationContext(ctx, ctl.actor, session.projectId);
    const prompt = [buildOrchestratorPrompt({ project, grant }), session.systemPrompt]
      .filter(Boolean)
      .join('\n\n');
    ctl.setActivity('計画を立てています');
    await runToolLoop({
      ctx,
      ctl,
      model,
      messages: toChatMessages(chatHistory(ctx, run, session), { systemPrompt: prompt }),
      tools: apiTools(ctx, ctl.actor),
      maxTurns: ORCHESTRATOR_MAX_TURNS,
    });
  };
}

function orchestrationContext(
  ctx: DaemonContext,
  actor: AgentActor,
  sessionProjectId: string | null,
): { project: Project | null; grant: CapabilityGrant | null } {
  const grants = orchestrationGrants(ctx, actor);
  const grant = grants[0] ?? null;
  const projectId = grant?.scope.projectIds?.[0] ?? sessionProjectId;
  const project = projectId ? (ctx.repos.projects.get(projectId) ?? null) : null;
  return { project, grant };
}
