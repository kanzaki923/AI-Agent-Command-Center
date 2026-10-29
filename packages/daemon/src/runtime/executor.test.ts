import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run, Session, Task, Workspace } from '@acc/protocol';
import { EMPTY_USAGE } from '@acc/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  AgentRunInput,
  AgentRuntime,
  ApprovalDecision,
  ApprovalRequest,
  RunController,
  RunExecutor,
  WorkspacesService,
} from '../contracts';
import type { DaemonContext } from '../core/context';
import type { ArtifactService } from '../integration/artifacts';
import { defineModule } from '../module';
import { modules as allModules } from '../modules';
import {
  HUMAN,
  type TestDaemonNoServer,
  agentActor,
  createTestDaemon,
  insertTestTask,
} from '../testing';
import { buildAgentPrompt, createAgentExecutor } from './executor';
import { MockAgentRuntime } from './mock/runtime';
import { RuntimeSessionStore } from './state';

// Only the modules this test needs; workspaces / runs / artifacts are faked below so the
// test stays valid once the real modules provide those services.
const BASE_MODULES = allModules.filter((m) =>
  ['system', 'events', 'projects', 'sessions', 'runtime'].includes(m.name),
);

let d: TestDaemonNoServer;
let dir: string;
let fakes: ReturnType<typeof makeFakes>;

function makeFakes() {
  const workspaceId = 'wsp_00000000000000000000000000';
  const commits: { workspaceId: string; message: string }[] = [];
  const artifacts: unknown[] = [];
  const executors = new Map<string, RunExecutor>();
  const workspaces: WorkspacesService = {
    createWorktree: () => Promise.reject(new Error('not used')),
    get: (id) => {
      if (id !== workspaceId) throw new Error(`unknown workspace ${id}`);
      const ws: Workspace = {
        id,
        projectId: 'prj_00000000000000000000000000',
        kind: 'worktree',
        status: 'ready',
        path: dir,
        branch: 'acc/test',
        baseRef: 'main',
        taskId: null,
        lockedByRunId: null,
        error: null,
        createdAt: '2026-10-29T00:00:00.000Z',
        updatedAt: '2026-10-29T00:00:00.000Z',
      };
      return ws;
    },
    acquire: () => {
      throw new Error('not used');
    },
    isLocked: () => false,
    commitAll: async (wsId, message) => {
      commits.push({ workspaceId: wsId, message });
      return 'c0ffee';
    },
    diff: async () => ({
      patch: 'diff --git a/x b/x',
      files: [{ path: 'notes/x.md', status: 'added', additions: 3, deletions: 0 }],
    }),
  };
  return { workspaceId, workspaces, commits, artifacts, executors };
}

const fakeServicesModule = defineModule({
  name: 'fakes',
  register(ctx) {
    ctx.provide('workspaces', fakes.workspaces);
    ctx.provide('runs', {
      registerExecutor: (kind, ex) => fakes.executors.set(kind, ex),
      start: () => {
        throw new Error('not used');
      },
      cancel: () => {
        throw new Error('not used');
      },
      waitForEnd: () => Promise.reject(new Error('not used')),
      resolveApproval: () => {
        throw new Error('not used');
      },
      lendSlot: () => () => undefined,
      pump: () => undefined,
    });
    ctx.provide('artifacts', {
      recordDiff: async (input: unknown) => {
        fakes.artifacts.push(input);
        return input;
      },
    } as unknown as ArtifactService);
  },
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'acc-exec-'));
  fakes = makeFakes();
  d = await createTestDaemon({ modules: [...BASE_MODULES, fakeServicesModule] });
});
afterEach(async () => {
  await d?.cleanup();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** RunController double that records every call. */
function fakeController(run: Run, decisions: ApprovalDecision[] = []) {
  const ac = new AbortController();
  const calls = {
    deltas: [] as { messageId: string; text: string }[],
    messages: [] as Parameters<RunController['appendMessage']>[0][],
    toolCalls: [] as Parameters<RunController['toolCalled']>[0][],
    toolResults: [] as Parameters<RunController['toolResult']>[0][],
    approvals: [] as ApprovalRequest[],
    usage: [] as Parameters<RunController['reportUsage']>[0][],
    activity: [] as (string | null)[],
    decisions: [] as Parameters<RunController['recordToolDecision']>[0][],
    permission: [] as Parameters<RunController['setPermission']>[0][],
  };
  const ctl: RunController = {
    run,
    signal: ac.signal,
    actor: agentActor(run.sessionId, run.id),
    emitDelta: (messageId, text) => calls.deltas.push({ messageId, text }),
    appendMessage: (m) => calls.messages.push(m),
    toolCalled: (c) => calls.toolCalls.push(c),
    toolResult: (r) => calls.toolResults.push(r),
    requestApproval: async (req) => {
      calls.approvals.push(req);
      return decisions.shift() ?? { decision: 'approved' };
    },
    reportUsage: (u) => calls.usage.push(u),
    reserveBudget: () => ({ amountUsd: 0, settle: (u) => calls.usage.push(u), cancel: () => {} }),
    assertBudgetLeft: () => {},
    setActivity: (t) => calls.activity.push(t),
    recordToolDecision: (d) => calls.decisions.push(d),
    setPermission: (p) => calls.permission.push(p),
  };
  return { ctl, calls, abort: (reason?: unknown) => ac.abort(reason) };
}

async function setup(
  opts: {
    task?: Partial<Task>;
    message?: string;
    runtime?: string;
    profile?: 'careful' | 'standard' | 'autonomous';
  } = {},
) {
  const ctx: DaemonContext = d.ctx;
  const project = await d.call(HUMAN, 'project.create', {
    name: 'demo',
    ...(opts.profile ? { permissionProfile: opts.profile } : {}),
  });
  const session: Session = await d.call(HUMAN, 'session.create', {
    projectId: project.id,
    kind: 'agent',
    ...(opts.runtime ? { runtime: opts.runtime } : {}),
  });
  let taskId: string | null = null;
  if (opts.task) {
    const task = insertTestTask(ctx, {
      projectId: project.id,
      title: 'README を整える',
      description: '見出しを揃える',
      acceptanceCriteria: ['見出しが統一されている'],
      status: 'running',
      assigneeSessionId: session.id,
      workspaceId: fakes.workspaceId,
      ...opts.task,
    });
    taskId = task.id;
  }
  let triggerMessageId: string | null = null;
  if (opts.message) {
    triggerMessageId = ctx.service('sessions').appendMessage({
      sessionId: session.id,
      role: 'user',
      content: [{ type: 'text', text: opts.message }],
      author: HUMAN,
    }).id;
  }
  const now = ctx.clock.iso();
  const run: Run = {
    id: ctx.ids.next('run'),
    sessionId: session.id,
    projectId: project.id,
    taskId,
    kind: 'agent',
    status: 'running',
    statusReason: null,
    model: null,
    runtime: null,
    workspaceId: taskId ? null : fakes.workspaceId,
    parentRunId: null,
    retryOfRunId: null,
    attempt: 1,
    budgetId: null,
    triggerMessageId,
    usage: EMPTY_USAGE,
    error: null,
    createdBy: HUMAN,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    endedAt: null,
  };
  return { ctx, session, run };
}

/** Speed up the registered mock runtime for these tests. */
function useFastMock(ctx: DaemonContext) {
  const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
  const mock = ctx.service('runtimes').get('mock');
  vi.spyOn(mock, 'run').mockImplementation((input) => fast.run(input));
}

describe('agent executor', () => {
  it('is registered with the runs service on start', () => {
    expect(fakes.executors.has('agent')).toBe(true);
  });

  it('runs the mock agent on a task and records everything through the controller', async () => {
    const { ctx, session, run } = await setup({ task: {} });
    useFastMock(ctx);
    const { ctl, calls } = fakeController(run);
    await createAgentExecutor(ctx)(ctl);

    // Real work on the workspace directory.
    const note = readFileSync(join(dir, 'notes', 'readme-を整える.md'), 'utf8');
    expect(note).toContain('# README を整える');
    expect(note).toContain('- [ ] 見出しが統一されている');

    // Messages: assistant narration + tool results, with our own message ids.
    const assistant = calls.messages.filter((m) => m.role === 'assistant');
    expect(assistant.length).toBeGreaterThanOrEqual(3);
    for (const m of assistant) expect(m.id).toMatch(/^msg_[0-9a-z]{26}$/);
    expect(new Set(assistant.map((m) => m.id)).size).toBe(assistant.length);
    // Deltas stream under the id the message is later persisted with.
    const first = assistant[0]!;
    const streamed = calls.deltas
      .filter((x) => x.messageId === first.id)
      .map((x) => x.text)
      .join('');
    expect(first.content[0]).toEqual({ type: 'text', text: streamed });
    expect(calls.messages.filter((m) => m.role === 'tool')).toHaveLength(2);

    expect(calls.toolCalls.map((c) => c.name)).toEqual(['Write', 'Grep']);
    expect(calls.toolResults.every((r) => !r.isError)).toBe(true);
    expect(calls.approvals).toEqual([]);
    expect(calls.usage.length).toBeGreaterThan(0);
    expect(calls.activity).toContain('ファイルを編集中: notes/readme-を整える.md');
    expect(calls.activity.at(-1)).toBeNull();

    // Commit + diff artifact.
    expect(fakes.commits).toEqual([
      { workspaceId: fakes.workspaceId, message: `README を整える\n\nRun: ${run.id}` },
    ]);
    expect(fakes.artifacts).toEqual([
      {
        workspaceId: fakes.workspaceId,
        title: '変更内容: README を整える',
        projectId: run.projectId,
        sessionId: run.sessionId,
        runId: run.id,
        taskId: run.taskId,
        createdBy: ctl.actor,
      },
    ]);

    // Runtime session id stored for resume and mirrored on the session.
    expect(ctx.repos.sessions.require(session.id).runtimeSessionId).toBe(`mock_${run.id}`);
    expect(new RuntimeSessionStore(ctx.db, ctx.clock).get(session.id, 'mock')).toBe(
      `mock_${run.id}`,
    );
    const updated = ctx.bus.list({ types: ['session.updated'] }).events;
    expect(updated.at(-1)?.payload).toMatchObject({ changes: ['runtimeSessionId'] });
  });

  it('routes tool approvals to the run approval flow (careful profile)', async () => {
    const prompt = [
      'スクリプトを動かして',
      '```acc-mock',
      JSON.stringify([
        {
          type: 'run',
          command: 'node',
          args: ['-e', "require('fs').writeFileSync('ran.txt','1')"],
        },
      ]),
      '```',
    ].join('\n');
    const { ctx, run } = await setup({ message: prompt, profile: 'careful' });
    useFastMock(ctx);
    const { ctl, calls } = fakeController(run, [{ decision: 'rejected', note: 'まだ' }]);
    await createAgentExecutor(ctx)(ctl);
    expect(calls.approvals).toEqual([
      {
        kind: 'tool_use',
        title: 'コマンドの実行を承認しますか',
        detail: expect.stringMatching(/^node -e /),
        payload: {
          toolName: 'Bash',
          input: expect.objectContaining({ command: expect.any(String) }),
          risk: 'medium',
          category: 'command_other',
          reason: expect.stringContaining('確認が必要') as string,
        },
      },
    ]);
    expect(calls.permission).toEqual([{ profile: 'careful', gate: 'rules', note: null }]);
    expect(calls.decisions.map((x) => [x.toolName, x.decision])).toEqual([['Bash', 'asked']]);
    expect(existsSync(join(dir, 'ran.txt'))).toBe(false);
    expect(fakes.commits).toHaveLength(1);
    // The fake commitAll always returns a sha; the title comes from the message.
    expect(fakes.commits[0]!.message.startsWith('スクリプトを動かして')).toBe(true);
  });

  it('runs without asking in the autonomous profile (the default) and records the decisions', async () => {
    const prompt = [
      'テストして共有して',
      '```acc-mock',
      JSON.stringify([
        {
          type: 'run',
          command: 'node',
          args: ['-e', "require('fs').writeFileSync('ran.txt','1')"],
        },
        { type: 'run', command: 'git', args: ['push', 'origin', 'HEAD'] },
        { type: 'write', path: 'notes.md', content: 'x' },
      ]),
      '```',
    ].join('\n');
    const { ctx, run } = await setup({ message: prompt });
    useFastMock(ctx);
    const { ctl, calls } = fakeController(run);
    await createAgentExecutor(ctx)(ctl);
    expect(calls.approvals).toEqual([]);
    expect(existsSync(join(dir, 'ran.txt'))).toBe(true);
    expect(existsSync(join(dir, 'notes.md'))).toBe(true);
    expect(calls.permission).toEqual([{ profile: 'autonomous', gate: 'rules', note: null }]);
    expect(calls.decisions.map((x) => [x.toolName, x.decision, x.rule, x.routine])).toEqual([
      ['Bash', 'allowed', null, false],
      ['Bash', 'denied', 'publish_remote', false],
      ['Write', 'allowed', null, true],
    ]);
    // The push never ran; the agent got the reason as the tool's error.
    expect(calls.toolResults[1]).toMatchObject({
      name: 'Bash',
      isError: true,
      output: expect.stringContaining('push・公開・リモートの変更はできません') as string,
    });
  });

  it('picks the runtime and resumes its previous session', async () => {
    const inputs: AgentRunInput[] = [];
    const spy: AgentRuntime = {
      id: 'spy',
      displayName: 'spy',
      available: async () => ({ ok: true }),
      async *run(input): AsyncGenerator<AgentEvent> {
        inputs.push(input);
        yield { type: 'session', runtimeSessionId: `spy-${inputs.length}` };
      },
    };
    const { ctx, session, run } = await setup({ message: 'やって', runtime: 'spy' });
    ctx.service('runtimes').register(spy);

    await createAgentExecutor(ctx)(fakeController(run).ctl);
    await createAgentExecutor(ctx)(fakeController({ ...run, id: ctx.ids.next('run') }).ctl);
    expect(inputs.map((i) => i.resumeSessionId)).toEqual([null, 'spy-1']);
    expect(inputs[0]).toMatchObject({ cwd: dir, prompt: 'やって' });
    expect(ctx.repos.sessions.require(session.id).runtimeSessionId).toBe('spy-2');

    // A run-level override wins over the session's runtime (and has its own resume state).
    useFastMock(ctx);
    const { ctl, calls } = fakeController({ ...run, id: ctx.ids.next('run'), runtime: 'mock' });
    await createAgentExecutor(ctx)(ctl);
    expect(calls.messages.length).toBeGreaterThan(0);
    expect(inputs).toHaveLength(2);
  });

  it('fails clearly without a workspace, instructions or an available runtime', async () => {
    const { ctx, run } = await setup({ message: 'やって' });
    await expect(
      createAgentExecutor(ctx)(fakeController({ ...run, workspaceId: null }).ctl),
    ).rejects.toThrow('この実行にはワークスペースが割り当てられていません');

    const broken: AgentRuntime = {
      id: 'broken',
      displayName: 'broken',
      available: async () => ({ ok: false, reason: 'SDK がありません' }),
      run: () => {
        throw new Error('not reached');
      },
    };
    ctx.service('runtimes').register(broken);
    await expect(
      createAgentExecutor(ctx)(fakeController({ ...run, runtime: 'broken' }).ctl),
    ).rejects.toThrow('SDK がありません');

    const empty = await setup({});
    await expect(createAgentExecutor(ctx)(fakeController(empty.run).ctl)).rejects.toThrow(
      'エージェントに渡す指示がありません',
    );
  });

  it('propagates cancellation without committing', async () => {
    const prompt = '待って\n```acc-mock\n[{"type":"sleep","ms":10000}]\n```';
    const { ctx, run } = await setup({ message: prompt });
    useFastMock(ctx);
    const { ctl, abort } = fakeController(run);
    const p = createAgentExecutor(ctx)(ctl);
    setTimeout(() => abort(new Error('run cancelled')), 30);
    await expect(p).rejects.toThrow('run cancelled');
    expect(fakes.commits).toEqual([]);
  });
});

describe('runtimes service', () => {
  it('lists the built-in runtimes and resolves the default from settings', async () => {
    const runtimes = d.ctx.service('runtimes');
    expect(runtimes.list().map((r) => r.id)).toEqual(['mock', 'claude-agent-sdk']);
    expect(runtimes.defaultId()).toBe('mock');
    await d.call(HUMAN, 'settings.update', { defaultRuntime: 'claude-agent-sdk' });
    expect(runtimes.defaultId()).toBe('claude-agent-sdk');
    expect((await d.call(HUMAN, 'settings.get', {})).defaultRuntime).toBe('claude-agent-sdk');
    await d.call(HUMAN, 'settings.update', { defaultRuntime: 'nope' });
    expect(runtimes.defaultId()).toBe('mock');
    expect(() => runtimes.get('nope')).toThrow(/runtime not found/);
    expect(() => runtimes.register(new MockAgentRuntime())).toThrow(/already registered/);
  });
});

describe('buildAgentPrompt', () => {
  it('combines the task and extra instructions', () => {
    const p = buildAgentPrompt({
      task: { title: 'T', description: 'D', acceptanceCriteria: ['A', 'B'] },
      instructions: 'もっと速く',
    });
    expect(p).toContain('# タスク: T\n\nD\n\n## 完了条件\n- A\n- B\n\n## 追加の指示\nもっと速く');
    expect(buildAgentPrompt({ task: null, instructions: '  そのまま  ' })).toBe('そのまま');
    expect(buildAgentPrompt({ task: null, instructions: null })).toBe('');
  });
});
