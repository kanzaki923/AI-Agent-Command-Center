import type { Actor, ContentPart, DiffFileStat, Message, Run, Session, Task } from '@acc/protocol';
import type { AgentEvent, RunController, RunExecutor } from '../contracts';
import type { DaemonContext } from '../core/context';
import { abortError } from './async';
import { RuntimeSessionStore } from './state';
import { approvalDetailFor, approvalTitleFor, truncate } from './tools';

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
  const session = ctx.repos.sessions.require(run.sessionId);
  const task = run.taskId ? ctx.repos.tasks.require(run.taskId) : null;

  const workspaceId = run.workspaceId ?? session.workspaceId ?? task?.workspaceId ?? null;
  if (!workspaceId) throw new Error('この実行にはワークスペースが割り当てられていません');
  const workspaces = ctx.service('workspaces');
  const workspace = workspaces.get(workspaceId);

  const runtimes = ctx.service('runtimes');
  const runtimeId = run.runtime || session.runtime || runtimes.defaultId();
  const runtime = runtimes.get(runtimeId);
  const availability = await runtime.available();
  if (!availability.ok) throw new Error(availability.reason);

  const instructions = triggerText(ctx, run, session);
  const prompt = buildAgentPrompt({ task, instructions });
  if (!prompt) throw new Error('エージェントに渡す指示がありません');

  ctl.setActivity('エージェントを起動中');
  const model = run.model ?? session.model ?? null;
  const resumeSessionId = store.get(session.id, runtimeId);

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
    prompt,
    systemPrompt: session.systemPrompt ?? undefined,
    model,
    resumeSessionId,
    signal,
    canUseTool: (req) =>
      ctl.requestApproval({
        kind: 'tool_use',
        title: approvalTitleFor(req.toolName),
        detail: approvalDetailFor(req.toolName, req.input, workspace.path) ?? req.title ?? null,
        payload: { toolName: req.toolName, input: req.input },
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
        ctl.reportUsage(ev.usage);
        return;
      case 'session':
        rememberRuntimeSession(ctx, store, session.id, runtimeId, ev.runtimeSessionId, ctl.actor);
        return;
    }
  };

  for await (const ev of events) {
    handleEvent(ev);
  }
  if (signal.aborted) throw abortError(signal);

  ctl.setActivity('変更をコミット中');
  const title = task?.title ?? firstLine(instructions ?? prompt);
  const sha = await workspaces.commitAll(
    workspaceId,
    `${truncate(title, 72)}\n\nRun: ${run.id}`,
    ctl.actor,
  );
  if (sha) await recordDiffArtifact(ctx, ctl, workspaceId, workspace.baseRef, sha, title);
  ctl.setActivity(null);
}

/** Text of the message that triggered the run, else the session's latest user message. */
function triggerText(ctx: DaemonContext, run: Run, session: Session): string | null {
  let msg: Message | undefined;
  if (run.triggerMessageId) msg = ctx.repos.messages.get(run.triggerMessageId);
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
 * the triggering message as extra instructions. Plain message text otherwise.
 */
export function buildAgentPrompt(input: {
  task: Pick<Task, 'title' | 'description' | 'acceptanceCriteria'> | null;
  instructions: string | null;
}): string {
  const { task, instructions } = input;
  if (!task) return instructions?.trim() ?? '';
  const parts = [`# タスク: ${task.title}`];
  if (task.description.trim()) parts.push('', task.description.trim());
  if (task.acceptanceCriteria.length > 0) {
    parts.push('', '## 完了条件', ...task.acceptanceCriteria.map((c) => `- ${c}`));
  }
  if (instructions?.trim()) parts.push('', '## 追加の指示', instructions.trim());
  parts.push(
    '',
    '作業はこのディレクトリ（専用の git worktree）の中で行ってください。完了すると変更は自動でコミットされます。',
  );
  return parts.join('\n');
}

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
 * What this module expects from the artifacts service (built in parallel; not yet in
 * contracts.ts). Only used when `ctx.hasService('artifacts')`.
 */
export interface ArtifactsRecorder {
  create(input: {
    kind: 'diff';
    title: string;
    data: {
      patch: string;
      baseRef: string | null;
      headRef: string | null;
      stats: { files: number; additions: number; deletions: number };
      files: DiffFileStat[];
    };
    projectId: string | null;
    sessionId: string | null;
    runId: string | null;
    taskId: string | null;
    workspaceId: string | null;
    createdBy: Actor;
  }): unknown;
}

const FILE_STATUSES = new Set<DiffFileStat['status']>([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
]);

function artifactsService(ctx: DaemonContext): ArtifactsRecorder | null {
  // `artifacts` is not declared in Services yet; look it up untyped.
  const services = ctx as unknown as {
    hasService(name: string): boolean;
    service(name: string): unknown;
  };
  if (!services.hasService('artifacts')) return null;
  const svc = services.service('artifacts') as Partial<ArtifactsRecorder> | null;
  return svc && typeof svc.create === 'function' ? (svc as ArtifactsRecorder) : null;
}

async function recordDiffArtifact(
  ctx: DaemonContext,
  ctl: RunController,
  workspaceId: string,
  baseRef: string | null,
  sha: string,
  title: string,
): Promise<void> {
  const artifacts = artifactsService(ctx);
  if (!artifacts) return;
  try {
    const diff = await ctx.service('workspaces').diff(workspaceId);
    const files: DiffFileStat[] = diff.files.map((f) => ({
      path: f.path,
      status: FILE_STATUSES.has(f.status as DiffFileStat['status'])
        ? (f.status as DiffFileStat['status'])
        : 'unknown',
      additions: f.additions,
      deletions: f.deletions,
    }));
    artifacts.create({
      kind: 'diff',
      title: `変更内容: ${truncate(title, 80)}`,
      data: {
        patch: diff.patch,
        baseRef,
        headRef: sha,
        stats: {
          files: files.length,
          additions: files.reduce((n, f) => n + f.additions, 0),
          deletions: files.reduce((n, f) => n + f.deletions, 0),
        },
        files,
      },
      projectId: ctl.run.projectId,
      sessionId: ctl.run.sessionId,
      runId: ctl.run.id,
      taskId: ctl.run.taskId,
      workspaceId,
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
