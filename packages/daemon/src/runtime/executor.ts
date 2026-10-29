import { existsSync, statSync } from 'node:fs';
import type {
  Actor,
  ContentPart,
  Message,
  PermissionProfile,
  Run,
  Session,
  Task,
  ToolApprovalPayload,
  Workspace,
  WorkspaceKind,
} from '@acc/protocol';
import type { AgentEvent, AgentTool, RunController, RunExecutor } from '../contracts';
import type { DaemonContext } from '../core/context';
import { apiTools } from '../llm/tools';
import { abortError } from './async';
import { ToolGate } from './gate';
import { isInside } from './policy';
import { classifyToolRisk } from './risk';
import { RuntimeSessionStore } from './state';
import { approvalDetailFor, approvalTitleFor, truncate } from './tools';
import { ruleMatcher } from './rules';
import { spendCapUsd } from '../runs/usage';

/**
 * The "agent" RunExecutor: runs a coding-agent runtime in the run's workspace and turns its
 * AgentEvents into RunController calls (messages, deltas, tool events, approvals, usage).
 *
 * Wiring: `runtimeModule` registers it with `ctx.service('runs').registerExecutor('agent', ...)`
 * in its start hook when the runs service exists.
 */
export function createAgentExecutor(ctx: DaemonContext): RunExecutor {
  const sessions = new RuntimeSessionStore(ctx.db, ctx.clock);
  return (ctl) => executeAgentRun(ctx, sessions, ctl);
}

/** Persisted tool output is capped; the full output stays in the runtime's own transcript. */
const MAX_PERSISTED_OUTPUT = 20_000;

async function executeAgentRun(
  ctx: DaemonContext,
  store: RuntimeSessionStore,
  ctl: RunController,
): Promise<void> {
  const { run, signal } = ctl;
  // Runtimes report cost only afterwards (no per-call reservation): at least refuse to
  // start once the budget is used up. During the run, reportUsage stops it at the limit.
  ctl.assertBudgetLeft();
  const session = ctx.repos.sessions.require(run.sessionId);
  const task = run.taskId ? ctx.repos.tasks.require(run.taskId) : null;

  const workspaceId = run.workspaceId ?? session.workspaceId ?? task?.workspaceId ?? null;
  if (!workspaceId) throw new Error('この実行にはワークスペースが割り当てられていません');
  const workspaces = ctx.service('workspaces');
  const workspace = workspaces.get(workspaceId);
  if (ctx.hasService('workspaceManager'))
    ctx.service('workspaceManager').ensureScratchDir(workspace);
  const readRoots = agentReadRoots(ctx, run, workspace);

  const runtimes = ctx.service('runtimes');
  const runtimeId = run.runtime || session.runtime || runtimes.defaultId();
  const runtime = runtimes.get(runtimeId);
  const availability = await runtime.available();
  if (!availability.ok) throw new Error(availability.reason);

  // A spawned child's first message is its brief, already in the prompt through the task.
  const instructions = triggerText(ctx, run, session, { skipBrief: !!task && !!session.brief });
  const prompt = buildAgentPrompt({
    task,
    instructions,
    workspace: workspace.kind,
    readRoots,
    brief: !!session.brief,
  });
  if (!prompt) throw new Error('エージェントに渡す指示がありません');

  ctl.setActivity('エージェントを起動中');
  const model = run.model ?? session.model ?? null;
  const resumeSessionId = store.get(session.id, runtimeId);
  const gate = createToolGate(ctx, ctl, workspace.path, workspace.projectId, readRoots);

  // Runtime message ids -> our message ids (deltas and the final message share one id).
  const ids = new Map<string, string>();
  const persisted = new Set<string>();
  const idFor = (runtimeMessageId: string): string => {
    let id = ids.get(runtimeMessageId);
    if (!id || persisted.has(id)) {
      id = ctx.ids.next('message');
      ids.set(runtimeMessageId, id);
    }
    return id;
  };

  const events = runtime.run({
    runId: run.id,
    cwd: workspace.path,
    writeRoot: workspace.path,
    readRoots,
    // What the run may still spend (budget room, today's limit): runtimes stop at it.
    maxBudgetUsd: spendCapUsd(ctx, run),
    prompt,
    systemPrompt: session.systemPrompt ?? undefined,
    model,
    resumeSessionId,
    signal,
    tools: agentTools(ctx, ctl),
    gate,
    canUseTool: (req) =>
      ctl.requestApproval({
        kind: 'tool_use',
        title: approvalTitleFor(req.toolName, req.input, workspace.path),
        detail: approvalDetailFor(req.toolName, req.input, workspace.path) ?? req.title ?? null,
        payload: {
          toolName: req.toolName,
          input: req.input,
          risk: classifyToolRisk({ toolName: req.toolName, input: req.input, cwd: workspace.path }),
          ...(req.category ? { category: req.category } : {}),
          ...(req.reason ? { reason: req.reason } : {}),
          rememberAs: ruleMatcher(req.toolName, req.input, workspace.path)?.description ?? null,
        } satisfies ToolApprovalPayload,
      }),
  });

  const handleEvent = (ev: AgentEvent): void => {
    switch (ev.type) {
      case 'text_delta':
        ctl.emitDelta(idFor(ev.messageId), ev.text);
        return;
      case 'message': {
        const id = idFor(ev.messageId);
        persisted.add(id);
        ctl.appendMessage({ role: 'assistant', content: ev.content, id, model });
        return;
      }
      case 'tool_call':
        ctl.toolCalled({ toolCallId: ev.toolCallId, name: ev.name, input: ev.input });
        return;
      case 'tool_result': {
        const output = capOutput(ev.output);
        ctl.toolResult({
          toolCallId: ev.toolCallId,
          name: ev.name,
          output,
          isError: ev.isError ?? false,
        });
        const part: ContentPart = {
          type: 'tool_result',
          toolCallId: ev.toolCallId,
          name: ev.name,
          output,
          isError: ev.isError ?? false,
        };
        ctl.appendMessage({ role: 'tool', content: [part] });
        return;
      }
      case 'activity':
        ctl.setActivity(ev.text);
        return;
      case 'usage':
        ctl.reportUsage(ev.usage, {
          ...(ev.phase ? { phase: ev.phase } : {}),
          ...(ev.component ? { component: ev.component } : {}),
        });
        return;
      case 'session':
        rememberRuntimeSession(ctx, store, session.id, runtimeId, ev.runtimeSessionId, ctl.actor);
        return;
      case 'tool_decision':
        // Runtimes hand these to their gate, which records them.
        return;
    }
  };

  for await (const ev of events) {
    handleEvent(ev);
  }
  if (signal.aborted) throw abortError(signal);
  // Only git workspaces are committed; a user's folder and a scratch folder have no git.
  if (!isGitWorkspace(workspace.kind)) {
    ctl.setActivity(null);
    return;
  }

  ctl.setActivity('変更をコミット中');
  const title = task?.title ?? firstLine(instructions ?? prompt);
  const sha = await workspaces.commitAll(
    workspaceId,
    `${truncate(title, 72)}\n\nRun: ${run.id}`,
    ctl.actor,
  );
  if (sha) await recordDiffArtifact(ctx, ctl, workspaceId, title);
  ctl.setActivity(null);
}

/** The project's permission profile, else the global default (architecture.md §2.10). */
export function resolvePermissionProfile(
  ctx: DaemonContext,
  projectId: string | null,
): PermissionProfile {
  const project = projectId ? ctx.repos.projects.get(projectId) : undefined;
  return project?.permissionProfile ?? ctx.settings.get().defaultPermissionProfile;
}

/**
 * The run's tool permission gate: the profile, remembered approvals of the run / task /
 * project, Claude Code auto mode when the settings allow it, and recording through the run.
 */
function createToolGate(
  ctx: DaemonContext,
  ctl: RunController,
  cwd: string,
  workspaceProjectId: string | null,
  readRoots: string[],
): ToolGate {
  const settings = ctx.settings.get();
  const { run } = ctl;
  const projectId = run.projectId ?? workspaceProjectId;
  const gate = new ToolGate({
    cwd,
    profile: resolvePermissionProfile(ctx, projectId),
    autoMode: settings.autoMode.enabled
      ? { classifierModel: settings.autoMode.classifierModel, judge: settings.autoMode.judge }
      : null,
    policy: {
      protectedPaths: [ctx.paths.home],
      readRoots,
      ...(ctx.port ? { daemonPort: ctx.port } : {}),
    },
    // Remembered approvals are per project; a workspace outside any project has none.
    ...(ctx.hasService('permissionRules') && projectId
      ? {
          remembered: ctx
            .service('permissionRules')
            .matcher({ projectId, runId: run.id, taskId: run.taskId }, cwd),
        }
      : {}),
    record: (d) => ctl.recordToolDecision(d),
    onPermission: (p) => ctl.setPermission(p),
  });
  ctl.setPermission(gate.permission);
  return gate;
}

/**
 * Control API tools for the agent: what the run's grants allow (a worker spawned by an
 * orchestrator gets the read-only preset; a human-started run has no grant and no tools).
 * Calls go through the dispatcher as the run's actor, so grants are enforced there.
 */
function agentTools(ctx: DaemonContext, ctl: RunController): AgentTool[] {
  return apiTools(ctx, ctl.actor).flatMap((t) =>
    t.method
      ? [{ method: t.method, description: t.description, execute: (i, o) => t.execute(i, o) }]
      : [],
  );
}

/**
 * Folders the agent may read besides its workspace (spec 20261029 §3.3): the project's
 * folder and repository, when they exist and are not the workspace itself (or inside it).
 */
export function agentReadRoots(ctx: DaemonContext, run: Run, workspace: Workspace): string[] {
  const projectId = run.projectId ?? workspace.projectId;
  const project = projectId ? ctx.repos.projects.get(projectId) : undefined;
  if (!project) return [];
  const roots: string[] = [];
  for (const p of [project.folderPath, project.repoPath]) {
    if (!p || roots.includes(p)) continue;
    if (isInside(p, workspace.path)) continue;
    if (isInside(ctx.paths.home, p)) continue;
    try {
      if (!existsSync(p) || !statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    roots.push(p);
  }
  return roots;
}

/** Workspaces the daemon commits and diffs (a worktree, or the repository checkout). */
export function isGitWorkspace(kind: WorkspaceKind): boolean {
  return kind === 'worktree' || kind === 'main';
}

/** Text of the message that triggered the run, else the session's latest user message. */
function triggerText(
  ctx: DaemonContext,
  run: Run,
  session: Session,
  opts: { skipBrief?: boolean } = {},
): string | null {
  let msg: Message | undefined;
  if (run.triggerMessageId) msg = ctx.repos.messages.get(run.triggerMessageId);
  if (msg && opts.skipBrief && (msg.meta?.kind === 'brief' || msg.meta?.kind === 'schedule')) {
    return null;
  }
  if (!msg && !run.taskId) {
    msg = ctx.repos.messages.find({
      where: { session_id: session.id },
      sql: { clause: "json_extract(data, '$.role') = 'user'" },
      orderBy: 'id',
      direction: 'desc',
      limit: 1,
    })[0];
  }
  if (!msg) return null;
  const text = msg.content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
  return text || null;
}

/**
 * The agent's prompt: the task (goal + acceptance criteria) when the run works on one, plus
 * the triggering message as extra instructions, then one fragment for where it works (spec
 * 20261029 §3.3). Only a git workspace (worktree, the default for older callers) mentions
 * git and commits. Plain message text when there is no task.
 */
export function buildAgentPrompt(input: {
  task: Pick<Task, 'title' | 'description' | 'acceptanceCriteria'> | null;
  instructions: string | null;
  /** Kind of the workspace (default: worktree). */
  workspace?: WorkspaceKind;
  /** Folders it may read but not write. */
  readRoots?: readonly string[];
  /** A spawned child: how to finish (its last answer is kept as its output). */
  brief?: boolean;
}): string {
  const { task, instructions } = input;
  if (!task) return instructions?.trim() ?? '';
  const parts = [`# タスク: ${task.title}`];
  if (task.description.trim()) parts.push('', task.description.trim());
  if (task.acceptanceCriteria.length > 0) {
    parts.push('', '## 完了条件', ...task.acceptanceCriteria.map((c) => `- ${c}`));
  }
  if (instructions?.trim()) parts.push('', '## 追加の指示', instructions.trim());
  parts.push('', WORKPLACE_TEXT[input.workspace ?? 'worktree']);
  if (input.readRoots && input.readRoots.length > 0) {
    parts.push(
      '',
      '次のフォルダは参照できます（読み取りのみ。変更はできません）:',
      ...input.readRoots.map((r) => `- ${r}`),
    );
  }
  if (input.brief) parts.push('', FINISH_TEXT);
  return parts.join('\n');
}

/** Where the agent works, one paragraph per workspace kind (only git kinds mention git). */
const WORKPLACE_TEXT: Record<WorkspaceKind, string> = {
  worktree:
    '作業はこのディレクトリ（専用の git worktree）の中で行ってください。完了すると変更は自動でコミットされます。',
  main: '作業はこのディレクトリ（git リポジトリ）の中で行ってください。完了すると変更は自動でコミットされます。',
  directory:
    '作業はこのフォルダ（ユーザーのフォルダ）の中で行ってください。ファイルはその場で書き換わるので、依頼に必要なものだけを変更してください。',
  scratch:
    '作業はこのフォルダ（この依頼のための作業フォルダ）の中で行ってください。作るファイルはすべてこの中に置いてください。',
};

/** How a spawned child finishes (its outputs settle when the run ends). */
const FINISH_TEXT =
  '終わったら、何をしたか・何ができたかを最後に短くまとめてください（その文章は成果物として残ります）。人の判断がないと先に進めないときは、質問を残して作業を区切って終えてください。';

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find(Boolean) ?? 'エージェントの作業'
  );
}

function capOutput(output: unknown): unknown {
  if (typeof output === 'string') {
    return output.length > MAX_PERSISTED_OUTPUT
      ? `${output.slice(0, MAX_PERSISTED_OUTPUT)}\n…（${output.length - MAX_PERSISTED_OUTPUT} 文字を省略）`
      : output;
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(output);
  } catch {
    return String(output);
  }
  if (json === undefined || json.length <= MAX_PERSISTED_OUTPUT) return output ?? null;
  return `${json.slice(0, MAX_PERSISTED_OUTPUT)}\n…（${json.length - MAX_PERSISTED_OUTPUT} 文字を省略）`;
}

function rememberRuntimeSession(
  ctx: DaemonContext,
  store: RuntimeSessionStore,
  sessionId: string,
  runtimeId: string,
  runtimeSessionId: string,
  actor: Actor,
): void {
  ctx.db.transaction(() => {
    store.set(sessionId, runtimeId, runtimeSessionId);
    const cur = ctx.repos.sessions.require(sessionId);
    if (cur.runtimeSessionId === runtimeSessionId) return;
    const session = ctx.repos.sessions.update(sessionId, (s) => ({
      ...s,
      runtimeSessionId,
      updatedAt: ctx.clock.iso(),
    }));
    ctx.bus.emit({
      type: 'session.updated',
      actor,
      payload: { session, changes: ['runtimeSessionId'] },
    });
  });
}

// ---- diff artifact ---------------------------------------------------------------

/**
 * Record the run's changes as a diff artifact through the artifacts service (integration
 * module), when it is present.
 */
async function recordDiffArtifact(
  ctx: DaemonContext,
  ctl: RunController,
  workspaceId: string,
  title: string,
): Promise<void> {
  if (!ctx.hasService('artifacts')) return;
  try {
    await ctx.service('artifacts').recordDiff({
      workspaceId,
      title: `変更内容: ${truncate(title, 80)}`,
      projectId: ctl.run.projectId,
      sessionId: ctl.run.sessionId,
      runId: ctl.run.id,
      taskId: ctl.run.taskId,
      createdBy: ctl.actor,
    });
  } catch (err) {
    // The commit is the source of truth; a missing artifact must not fail the run.
    ctx.log.warn('failed to record diff artifact', {
      runId: ctl.run.id,
      error: (err as Error).message,
    });
  }
}
