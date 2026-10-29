import {
  type AgentActor,
  type CapabilityGrant,
  type Message,
  type Project,
  type Run,
  type Session,
  api,
} from '@acc/protocol';
import type { RunExecutor } from '../contracts';
import type { DaemonContext } from '../core/context';
import { subtreeIds } from '../home/tree';
import { WAKE_MARKER, currentState, isLegacyOrchestrator } from '../inbox';
import { INJECTED_PREFIX } from '../inbox/wake';
import {
  type LoopTool,
  apiTools,
  paramsJsonSchema,
  runToolLoop,
  toChatMessages,
  toolNameForMethod,
} from '../llm';
import { chatHistory, requireChatModel } from '../sessions/chat';
import { orchestrationGrants } from './grant';

/** Model calls per orchestrator run of the older preset (blocking waits; now the daemon's limit). */
export const ORCHESTRATOR_MAX_TURNS = 80;

/** Marker the prompt puts before the project id (the mock orchestrator reads it too). */
export const PROJECT_ID_LABEL = 'projectId:';
/** Marker of whether the project has a repository ("yes" / "no"; read by the mock). */
export const REPOSITORY_LABEL = 'repository:';
/** Heading of the session-tree snapshot in a supervisor's system prompt. */
export const TREE_HEADING = '現在の会話の木';

/**
 * First words of the system message the daemon posts to an older-preset orchestrator after a
 * restart cut off its run (orchestrator/resume.ts). Supervisors get a wake (`resume`) instead.
 */
export const ORCHESTRATOR_RESUME_NOTICE =
  'デーモンの再起動により Orchestrator の実行が中断されました';

/**
 * System prompt of a supervisor run (spec 20261029 §3.2, §3.9): a neutral core — split the
 * goal, start children, end the run, be woken, report — plus a code fragment only when the
 * project has a repository. Tool descriptions come from the Control API contract.
 */
export function buildSupervisorPrompt(input: {
  project: Project | null;
  grant: CapabilityGrant | null;
  maxModelCalls: number;
}): string {
  const { project, grant } = input;
  const maxChildren = grant?.limits.maxChildren ?? grant?.limits.maxWorkers;
  const lines = [
    'You lead other agents ("children") in AI Agent Command Center through the Control API tools. You split the goal into pieces of work, give each piece to a child with session.spawn, follow up and report. You do not do the pieces yourself.',
    '',
  ];
  if (project) {
    lines.push(
      'Project',
      `- ${PROJECT_ID_LABEL} ${project.id}`,
      `- name: ${project.name}`,
      `- ${REPOSITORY_LABEL} ${project.repoPath ? 'yes' : 'no'}`,
      '',
    );
  }
  lines.push(
    'How you run (enforced by the daemon, not by you)',
    '- A run ends as soon as you answer without calling a tool. Never wait or poll.',
    `- You are woken by a message that starts with "${WAKE_MARKER}" when a child finishes, fails, needs a human or is stopped, when a question is answered, or after a restart. The user can write to you at any time.`,
    `- A message starting with "${INJECTED_PREFIX}" arrived while you were working: take it into account.`,
    `- At most ${maxChildren ?? 'a few'} unfinished children at a time. Children cannot start children.`,
    `- At most ${input.maxModelCalls} model calls per run; repeating the same call or the same text three times stops you.`,
    '- Only a human approves tool uses, accepts code changes and raises budgets.',
    '',
    'How to work',
    '1. Split the goal into independent pieces. Start each with session.spawn: a short title (what the child does), the goal and doneWhen criteria. In the same reply, record the plan with orchestrator.recordDecision (one line). Then tell the user in one or two sentences who does what and end the run.',
    "2. When woken, read the update; use session.tree for the whole picture. Answer a child's question with attention.respond when the goal already answers it; otherwise leave it to the human. Send a child back with artifact.review (redo) or session.send when its output misses the goal.",
    '3. While some children still work, answer in one line (e.g. how many are done) and end the run.',
    '4. When every child has finished, write the final report without calling tools: what was produced (the output titles), what failed or waits for a human, and what the human should decide.',
    '5. "いま何してる？" → session.tree, then a short answer. "止めて" → session.stop for the children that work, then confirm.',
  );
  if (project?.repoPath) {
    lines.push(
      '',
      'Code (this project has a repository)',
      `- A child spawned with workspace {"kind":"worktree","projectId":"${project.id}"} works in its own git worktree; its changes are committed when it finishes and wait for a human to accept them.`,
      "- To combine several children's code changes, use integration.create (their task ids) and integration.run, then report; a human approves the result.",
    );
  }
  lines.push('', 'Always write to the user in Japanese.');
  return lines.join('\n');
}

/**
 * The older orchestrator prompt (session.grantOrchestration): tasks, workers in git
 * worktrees and the blocking task.wait / integration.wait. Kept for that preset only.
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
    '5. If the integration ends in "conflict", call integration.resolveWithAgent once (an integrator agent resolves it on the integration branch, then the integration resumes and is verified) and wait again. If it is still in conflict, stop and ask the human.',
    '6. If the integration tests fail, find the task that caused it and send it back to its worker with task.retry (pass integrationId so the worker sees the failing output), wait for it, then run the integration again. Ask the human when it is unclear or keeps failing.',
    '7. If a task failed, do not integrate blindly: explain what failed and propose the next step (task.retry can resume a task on its worktree).',
    '8. Record each key decision (decomposition, starting workers, integrating, resolving, stopping) with orchestrator.recordDecision: one line and a short rationale.',
    '9. Finish with a short report for the human: what was done, task ids, the integration id and its test result, and exactly what they need to review or approve.',
    `10. A system message starting with "${ORCHESTRATOR_RESUME_NOTICE}" means the daemon restarted while you were working: read the current state with task.list (and integration.list), resume interrupted tasks (status ready, statusReason "interrupted") with task.retry, and continue the plan from there instead of starting over.`,
    '',
    'Always write to the user in Japanese.',
  );
  return lines.join('\n');
}

/** One line per session of the supervisor's tree (state, outputs), for its system prompt. */
export function treeSnapshot(ctx: DaemonContext, session: Session): string {
  const { repos } = ctx;
  const ids = subtreeIds(ctx, session.id);
  const depth = new Map<string, number>([[session.id, 0]]);
  const lines = [TREE_HEADING];
  for (const id of ids) {
    const s = repos.sessions.get(id);
    if (!s) continue;
    const d = s.parentSessionId ? (depth.get(s.parentSessionId) ?? 0) + 1 : 0;
    depth.set(id, d);
    const outputs = repos.artifacts
      .find({ where: { session_id: id }, direction: 'desc', limit: 10 })
      .filter((a) => a.role === 'output')
      .slice(0, 3)
      .map((a) => `「${a.title}」(${a.id})`);
    const self = id === session.id ? '（この会話）' : '';
    lines.push(
      `${'  '.repeat(d)}- [${s.id}] 「${s.title || '無題'}」${self} state=${currentState(ctx, s)}${outputs.length > 0 ? ` outputs=${outputs.join(',')}` : ''}`,
    );
  }
  if (ids.length <= 1) lines.push('  （子はまだいません）');
  return lines.join('\n');
}

/** The session's first user message (the goal that started it). */
function firstUserMessage(ctx: DaemonContext, sessionId: string): Message | undefined {
  return ctx.repos.messages.find({
    where: { session_id: sessionId },
    sql: { clause: "json_extract(data, '$.role') = 'user'" },
    orderBy: 'id',
    direction: 'asc',
    limit: 1,
  })[0];
}

/**
 * What a supervisor run sends (spec §3.2): the system prompt with the tree snapshot, the
 * first request, then the latest `contextMessages` messages. Wake messages (stored as system
 * messages) go as user turns so every provider keeps them in order.
 */
export function supervisorMessages(
  ctx: DaemonContext,
  run: Run,
  session: Session,
  prompt: string,
  contextMessages: number,
) {
  const history = chatHistory(ctx, run, session);
  let recent = history.slice(-contextMessages);
  while (recent[0]?.role === 'tool') recent = recent.slice(1);
  const first = firstUserMessage(ctx, session.id);
  const picked = first && !recent.some((m) => m.id === first.id) ? [first, ...recent] : recent;
  const asTurns = picked.map((m) =>
    m.meta?.kind === 'wake' ? ({ ...m, role: 'user' } satisfies Message) : m,
  );
  return toChatMessages(asTurns, {
    systemPrompt: [prompt, session.systemPrompt, treeSnapshot(ctx, session)]
      .filter(Boolean)
      .join('\n\n'),
  });
}

/**
 * task.wait / integration.wait for the older preset only: they are no LLM tools any more
 * (`tool: false`, spec D8), but its flow still blocks on them.
 */
function legacyWaitTools(ctx: DaemonContext, actor: AgentActor): LoopTool[] {
  const { policy } = ctx;
  const allowed = (permission: string) =>
    (policy.peek
      ? policy.peek(actor, permission, undefined)
      : policy.check(actor, permission, undefined)
    ).allowed;
  return (['task.wait', 'integration.wait'] as const)
    .filter((m) => ctx.methods.has(m) && allowed(api[m].permission))
    .map((m) => ({
      name: toolNameForMethod(m),
      description: api[m].description,
      parameters: paramsJsonSchema(m),
      method: m,
      execute: (input, { signal }) => ctx.call(actor, m, (input ?? {}) as never, { signal }),
    }));
}

/**
 * Executor for `orchestrator` runs (a session that leads others). Supervisors
 * (session.delegate) run one short, event-driven turn: plan / react, then answer and end;
 * messages that arrive meanwhile are injected at step boundaries; the daemon's limits
 * (model calls, loops) fail the run. Sessions with the older preset keep their prompt and
 * the blocking waits.
 */
export function createOrchestratorExecutor(ctx: DaemonContext): RunExecutor {
  return async (ctl) => {
    const run = ctl.run;
    const session = ctx.repos.sessions.require(run.sessionId);
    const model = requireChatModel(ctx, run, session);
    const { project, grant } = orchestrationContext(ctx, ctl.actor, session.projectId);
    const limits = ctx.settings.get().supervisor;
    const inbox = ctx.hasService('supervisorInbox') ? ctx.service('supervisorInbox') : null;
    // Messages that waited for this run are already in its history.
    inbox?.drain(run.id);
    const common = {
      ctx,
      ctl,
      model,
      maxTurns: limits.maxModelCallsPerRun,
      failOnTurnLimit: true,
      ...(inbox ? { inject: () => inbox.injectedMessages(run.id) } : {}),
    };

    if (isLegacyOrchestrator(ctx, session.id)) {
      const prompt = [buildOrchestratorPrompt({ project, grant }), session.systemPrompt]
        .filter(Boolean)
        .join('\n\n');
      ctl.setActivity('計画を立てています');
      await runToolLoop({
        ...common,
        messages: toChatMessages(chatHistory(ctx, run, session), { systemPrompt: prompt }),
        tools: [...apiTools(ctx, ctl.actor), ...legacyWaitTools(ctx, ctl.actor)],
      });
      return;
    }

    ctl.setActivity(run.trigger === 'wake' ? '状況を確かめています' : '計画を立てています');
    const prompt = buildSupervisorPrompt({
      project,
      grant,
      maxModelCalls: limits.maxModelCallsPerRun,
    });
    await runToolLoop({
      ...common,
      messages: supervisorMessages(ctx, run, session, prompt, limits.contextMessages),
      tools: apiTools(ctx, ctl.actor),
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
