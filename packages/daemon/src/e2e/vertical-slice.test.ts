/**
 * THE acceptance test of concept.md §12.1 (Vertical Slice), end to end and offline:
 * a real daemon (HTTP + WebSocket) driven through @acc/client, a temp git repository with a
 * test command, the `mock/orchestrator` model and the `mock` agent runtime.
 *
 *   human: chat + orchestrator grant + goal
 *   → orchestrator: 2 tasks → 2 workers in parallel worktrees (the test worker runs its
 *     tests without asking and its push is denied by the daemon's hard rules)
 *   → both tasks in review with diffs → integration merges both, tests pass
 *   → awaiting_approval; agents cannot approve → human approves → target branch has both.
 *
 * In the default (autonomous) profile the only human decision is that last approval.
 */
import type { AccClient } from '@acc/client';
import type { Approval, Event, Run } from '@acc/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentRunInput } from '../contracts';
import { ApiError } from '../core/errors';
import { MockAgentRuntime } from '../runtime/mock/runtime';
import {
  type TestDaemon,
  agentActor,
  approveIntegrationTests,
  connectTestClient,
  startTestDaemon,
} from '../testing';
import { type TempRepo, createTempRepo, isolateGitConfig } from '../workspace/git-fixture';

// Real git, worktrees and `node --test` child processes; Windows is slow under parallel load.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const GOAL = '認証まわりのドキュメントとテストを並列で整備して';

let restoreGit: () => void;
beforeAll(() => {
  restoreGit = isolateGitConfig();
});
afterAll(() => restoreGit());

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 60_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof ApiError ? err.code : String(err);
  }
}

/** Assert that `events` contains matches for `steps` in this order (other events may interleave). */
function expectStory(events: Event[], steps: [string, (e: Event) => boolean][]): void {
  let i = 0;
  const seen: string[] = [];
  for (const e of events) {
    const step = steps[i];
    if (!step) break;
    if (step[1](e)) {
      seen.push(step[0]);
      i++;
    }
  }
  const dump = events.map((e) => `${e.seq} ${e.type} (${e.actor.kind})`).join('\n');
  expect(seen, dump).toEqual(steps.map((s) => s[0]));
}

interface Slice {
  /** Lets held workers finish (setup({ holdWorkers: true })). */
  releaseWorkers: () => void;
  d: TestDaemon;
  repo: TempRepo;
  client: AccClient;
  events: Event[];
  approvals: Approval[];
  projectId: string;
  sessionId: string;
  /** What each agent run got from the daemon (prompt, tools ...). */
  inputs: AgentRunInput[];
}

async function setup(
  opts: { profile?: 'careful' | 'standard' | 'autonomous'; holdWorkers?: boolean } = {},
): Promise<Slice> {
  const repo = await createTempRepo({
    'test/basic.test.js': [
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "test('basic', () => assert.equal(1 + 1, 2));",
      '',
    ].join('\n'),
  });
  cleanups.push(() => repo.cleanup());
  const d = await startTestDaemon();
  cleanups.push(() => d.cleanup());
  // The person watching lets the orchestrator's integration run its tests.
  cleanups.push(approveIntegrationTests(d.ctx));
  d.ctx.service('llm').mock.chunkDelayMs = 0;

  // The offline mock agent without its human-like pauses. Each worker stays alive until both
  // workers have started: if the daemon ran them one after another this would never happen
  // (and the test would time out), so passing proves they run in parallel.
  const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
  const inputs: AgentRunInput[] = [];
  let started = 0;
  let releaseAll!: () => void;
  const bothStarted = new Promise<void>((r) => (releaseAll = r));
  let releaseWorkers!: () => void;
  const released = opts.holdWorkers
    ? new Promise<void>((r) => (releaseWorkers = r))
    : ((releaseWorkers = () => {}), Promise.resolve());
  vi.spyOn(d.ctx.service('runtimes').get('mock'), 'run').mockImplementation(
    (input: AgentRunInput) => {
      inputs.push(input);
      started += 1;
      if (started >= 2) releaseAll();
      return (async function* () {
        yield* fast.run(input);
        await bothStarted;
        // Still running (and holding its grant) until the test lets it finish.
        await released;
      })();
    },
  );

  const client = await connectTestClient(d);
  cleanups.push(() => client.close());
  const events: Event[] = [];
  const approvals: Approval[] = [];
  client.subscribe({
    since: 0,
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'approval.requested') approvals.push(e.payload.approval);
    },
  });

  const project = await client.call('project.create', {
    name: 'auth-service',
    repoPath: repo.path,
    defaultBranch: 'main',
    testCommand: 'node --test',
    ...(opts.profile ? { permissionProfile: opts.profile } : {}),
  });
  const session = await client.call('session.create', {
    projectId: project.id,
    kind: 'chat',
    title: '設計チャット',
    model: 'mock/orchestrator',
  });
  return {
    releaseWorkers,
    d,
    repo,
    client,
    events,
    approvals,
    projectId: project.id,
    sessionId: session.id,
    inputs,
  };
}

async function lastAssistantText(s: Slice): Promise<string> {
  const msgs = await s.client.call('session.messages', { sessionId: s.sessionId });
  const last = msgs.items.filter((m) => m.role === 'assistant').at(-1);
  return (last?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');
}

describe('vertical slice (concept §12.1)', () => {
  it('a chat with an orchestrator grant decomposes a goal, runs 2 workers in parallel, integrates, and the human approves', async () => {
    const s = await setup({ holdWorkers: true });
    const { d, client, repo } = s;

    // A normal chat becomes an orchestrator by capability (concept §3.1).
    const { grant } = await client.call('session.grantOrchestration', {
      sessionId: s.sessionId,
      lifetime: 'session',
    });
    expect(grant).toMatchObject({
      scope: { projectIds: [s.projectId] },
      limits: { maxWorkers: 2, maxDepth: 1 },
    });
    expect(grant.permissions).not.toContain('integration.approve');

    const { runId: orchRunId } = await client.call('session.send', {
      sessionId: s.sessionId,
      content: GOAL,
    });
    expect((await client.call('run.get', { runId: orchRunId! })).kind).toBe('orchestrator');

    // The test worker runs its tests without asking; its push is denied by a hard rule and it
    // carries on (the reason went back to it as the tool's error).
    const pushDenied = await until(() =>
      s.events.find(
        (e): e is Extract<Event, { type: 'tool.decided' }> =>
          e.type === 'tool.decided' && e.payload.rule === 'publish_remote',
      ),
    );
    expect(pushDenied.payload).toMatchObject({
      toolName: 'Bash',
      summary: 'git push origin HEAD',
      decision: 'denied',
      decidedBy: 'rule',
      profile: 'autonomous',
    });
    const workerRun = d.ctx.repos.runs.require(pushDenied.runId!);
    expect(workerRun).toMatchObject({ kind: 'agent', parentRunId: orchRunId });
    expect(workerRun.permission).toEqual({ profile: 'autonomous', gate: 'rules', note: null });

    // A worker (depth 1) can neither start workers nor delegate (enforced by the daemon).
    const worker = agentActor(workerRun.sessionId, workerRun.id);
    expect(await codeOf(d.call(worker, 'task.spawnWorker', { taskId: workerRun.taskId! }))).toBe(
      'forbidden',
    );
    expect(
      await codeOf(
        d.call(worker, 'grant.create', {
          subject: { kind: 'run', runId: workerRun.id },
          permissions: ['task.get'],
        }),
      ),
    ).toBe('forbidden');
    // Its runtime gets read-only Control API tools from its delegated grant (Claude: MCP "acc").
    expect(
      s.inputs
        .find((i) => i.runId === workerRun.id)!
        .tools!.map((t) => t.method)
        .sort(),
    ).toEqual(['artifact.get', 'artifact.list', 'task.get', 'workspace.diff', 'workspace.get']);

    s.releaseWorkers();
    const orchRun: Run = await d.ctx.service('runs').waitForEnd(orchRunId!);
    expect(orchRun.status).toBe('completed');

    // Two tasks, both in review, each in its own worktree with a recorded diff.
    const tasks = (await client.call('task.list', { projectId: s.projectId })).items;
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.status)).toEqual(['review', 'review']);
    expect(tasks.every((t) => t.acceptanceCriteria.length > 0)).toBe(true);
    expect(new Set(tasks.map((t) => t.workspaceId)).size).toBe(2);
    for (const t of tasks) {
      const diffs = await client.call('artifact.list', { taskId: t.id, kind: 'diff' });
      expect(diffs.items).toHaveLength(1);
    }

    // The two workers ran at the same time in different worktrees.
    const workers = (await client.call('run.list', { projectId: s.projectId, kind: 'agent' }))
      .items;
    expect(workers).toHaveLength(2);
    const [a, b] = workers as [Run, Run];
    expect(a.status).toBe('completed');
    expect(b.status).toBe('completed');
    expect(a.workspaceId).not.toBe(b.workspaceId);
    expect(a.parentRunId).toBe(orchRunId);
    expect(a.startedAt! < b.endedAt! && b.startedAt! < a.endedAt!).toBe(true);
    // Every tool decision is on the runs: the test worker had one denial, nobody was asked.
    const tester = workers.find((w) => w.id === workerRun.id)!;
    // (writing the test file and running it; the push)
    expect(tester.toolDecisions).toEqual({ allowed: 2, denied: 1, asked: 0 });
    expect(workers.map((w) => w.toolDecisions?.asked)).toEqual([0, 0]);

    // The integration merged both branches and the tests passed.
    const integrations = (await client.call('integration.list', { projectId: s.projectId })).items;
    expect(integrations).toHaveLength(1);
    const integ = integrations[0]!;
    expect(integ.status).toBe('awaiting_approval');
    expect(integ.steps.map((st) => [st.kind, st.status])).toEqual([
      ['merge', 'succeeded'],
      ['merge', 'succeeded'],
      ['verify', 'succeeded'],
      ['apply', 'pending'],
    ]);

    const report = await lastAssistantText(s);
    expect(report).toContain(
      '2件のTaskが完了し、統合候補ができました。テスト: 成功。レビューして承認してください',
    );
    expect(report).toContain(integ.id);
    for (const t of tasks) expect(report).toContain(t.id);

    // Agents can never approve an integration — not even the orchestrator with its grant.
    expect(
      await codeOf(
        d.call(agentActor(s.sessionId, orchRunId!), 'integration.approve', {
          integrationId: integ.id,
        }),
      ),
    ).toBe('forbidden');

    // Zero approval requests until here: the human's "承認して反映" is the first decision.
    expect(s.approvals).toEqual([]);
    const applied = await client.call('integration.approve', { integrationId: integ.id });
    expect(applied.status).toBe('applied');
    const files = await repo.git('ls-tree', '-r', '--name-only', 'main');
    expect(files).toContain('docs/auth.md');
    expect(files).toContain('test/auth.test.js');
    expect(await repo.git('show', 'main:README.md')).toContain('docs/auth.md');

    // The events tell the whole story, in order.
    await until(() =>
      s.events.some(
        (e) => e.type === 'integration.updated' && e.payload.integration.status === 'applied',
      ),
    );
    const isTask = (status: string) => (e: Event) =>
      e.type === 'task.updated' && e.payload.task.status === status;
    expectStory(s.events, [
      ['session.created', (e) => e.type === 'session.created' && e.payload.session.kind === 'chat'],
      ['grant.created', (e) => e.type === 'grant.created' && e.payload.grant.id === grant.id],
      ['user message', (e) => e.type === 'message.created' && e.payload.message.role === 'user'],
      [
        'orchestrator run',
        (e) => e.type === 'run.created' && e.payload.run.kind === 'orchestrator',
      ],
      [
        'decision: decompose',
        (e) => e.type === 'orchestrator.decision' && e.actor.kind === 'agent',
      ],
      ['task 1', (e) => e.type === 'task.created'],
      ['task 2', (e) => e.type === 'task.created'],
      ['worktree 1', (e) => e.type === 'workspace.created'],
      ['worker 1', (e) => e.type === 'run.created' && e.payload.run.kind === 'agent'],
      ['task running', isTask('running')],
      [
        'decision: worker started',
        (e) => e.type === 'orchestrator.decision' && e.actor.kind === 'system',
      ],
      ['worktree 2', (e) => e.type === 'workspace.created'],
      ['worker 2', (e) => e.type === 'run.created' && e.payload.run.kind === 'agent'],
      ['review 1', isTask('review')],
      ['review 2', isTask('review')],
      ['integration created', (e) => e.type === 'integration.created'],
      [
        'integration verified',
        (e) =>
          e.type === 'integration.updated' && e.payload.integration.status === 'awaiting_approval',
      ],
      ['orchestrator done', (e) => e.type === 'run.completed' && e.payload.run.id === orchRunId],
      [
        'human approved',
        (e) =>
          e.type === 'integration.updated' &&
          e.payload.integration.status === 'applied' &&
          e.actor.kind === 'human',
      ],
    ]);
    // The push was denied before the task went to review.
    expect(s.events.indexOf(pushDenied)).toBeLessThan(
      s.events.findIndex(
        (e) =>
          isTask('review')(e) &&
          e.type === 'task.updated' &&
          e.payload.task.id === workerRun.taskId,
      ),
    );
    // The refused agent calls are on the audit trail.
    expect(
      s.events.flatMap((e) => (e.type === 'policy.denied' ? [e.payload.permission] : [])),
    ).toEqual(['task.spawnWorker', 'grant.create', 'integration.approve']);
    expect(s.events.some((e) => e.type === 'approval.requested')).toBe(false);
  });

  it('when both tasks touch the same file, an integrator agent resolves the merge conflict and the integration resumes', async () => {
    const s = await setup();
    const { d, client, repo } = s;
    await client.call('session.grantOrchestration', {
      sessionId: s.sessionId,
      lifetime: 'session',
    });
    // "README" in the goal: both mock workers append to README.md → the second merge conflicts.
    const { runId: orchRunId } = await client.call('session.send', {
      sessionId: s.sessionId,
      content: `${GOAL}。どちらも README から辿れるようにして`,
    });
    expect((await d.ctx.service('runs').waitForEnd(orchRunId!)).status).toBe('completed');
    expect(s.approvals).toEqual([]);

    const integ = (await client.call('integration.list', { projectId: s.projectId })).items[0]!;
    expect(integ.status).toBe('awaiting_approval');
    expect(integ.steps.map((st) => [st.kind, st.status])).toEqual([
      ['merge', 'succeeded'],
      ['merge', 'succeeded'],
      ['fix', 'succeeded'],
      ['verify', 'succeeded'],
      ['apply', 'pending'],
    ]);
    // Where it conflicted stays on record.
    expect(integ.steps[1]!.conflictFiles).toEqual(['README.md']);
    expect(integ.steps[2]!.conflictFiles).toEqual(['README.md']);

    // The integrator was an agent run of the orchestrator, in the integration worktree.
    const integrator = d.ctx.repos.runs.require(integ.resolverRunId!);
    expect(integrator).toMatchObject({
      kind: 'agent',
      status: 'completed',
      parentRunId: orchRunId,
      workspaceId: integ.workspaceId,
      taskId: null,
    });
    // It got both tasks' goals as context (and no worker's mock plan).
    const prompt = (await client.call('session.messages', { sessionId: integrator.sessionId }))
      .items[0]!;
    const promptText = prompt.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
    expect(promptText).toContain('README.md');
    expect(promptText).toContain('ドキュメントを整備する');
    expect(promptText).toContain('テストを整備する');
    expect(promptText).not.toContain('acc-mock');

    const report = await lastAssistantText(s);
    expect(report).toContain('統合候補ができました。テスト: 成功');
    expect(report).toContain('Integrator が解消しました');

    await client.call('integration.approve', { integrationId: integ.id });
    const readme = await repo.git('show', 'main:README.md');
    expect(readme).toContain('docs/auth.md');
    expect(readme).toContain('テストの実行方法');
    expect(readme).not.toMatch(/^(<{7}|={7}|>{7})/m);

    expectStory(s.events, [
      [
        'conflict',
        (e) => e.type === 'integration.updated' && e.payload.integration.status === 'conflict',
      ],
      [
        'decision: resolve',
        (e) =>
          e.type === 'orchestrator.decision' &&
          e.payload.decision === 'Integrator にコンフリクトの解消を任せる',
      ],
      ['integrator run', (e) => e.type === 'run.created' && e.payload.run.id === integrator.id],
      [
        'resumed and verified',
        (e) =>
          e.type === 'integration.updated' && e.payload.integration.status === 'awaiting_approval',
      ],
      ['orchestrator done', (e) => e.type === 'run.completed' && e.payload.run.id === orchRunId],
    ]);
  });

  it('in the careful profile a human refuses the test command: the task fails and the orchestrator reports instead of integrating', async () => {
    const s = await setup({ profile: 'careful' });
    const { d, client } = s;
    await client.call('session.grantOrchestration', { sessionId: s.sessionId });
    const { runId } = await client.call('session.send', { sessionId: s.sessionId, content: GOAL });

    // The human refuses the test worker's command; its plan treats that as a failure.
    const approval = await until(() => s.approvals[0]);
    expect(approval).toMatchObject({
      kind: 'tool_use',
      payload: { toolName: 'Bash', risk: 'medium', category: 'build_test' },
    });
    await client.call('approval.respond', {
      approvalId: approval.id,
      decision: 'reject',
      note: '今はテストを実行しない',
    });

    expect((await d.ctx.service('runs').waitForEnd(runId!)).status).toBe('completed');
    const tasks = (await client.call('task.list', { projectId: s.projectId })).items;
    const failed = tasks.find((t) => t.id === approval.taskId)!;
    expect(failed).toMatchObject({ status: 'failed', statusReason: 'worker_failed' });
    expect(tasks.find((t) => t.id !== approval.taskId)!.status).toBe('review');
    // The failed worker's worktree and branch are kept.
    const ws = await client.call('workspace.get', { workspaceId: failed.workspaceId! });
    expect(ws.status).toBe('ready');

    expect((await client.call('integration.list', { projectId: s.projectId })).items).toEqual([]);
    const report = await lastAssistantText(s);
    expect(report).toContain('統合は見送りました');
    expect(report).toContain(failed.id);
    expect(
      s.events.some(
        (e) =>
          e.type === 'orchestrator.decision' &&
          e.payload.decision === '統合を見送る' &&
          e.actor.kind === 'agent',
      ),
    ).toBe(true);
    // The session's run-lifetime grant reads as `work` (D17): it outlives the orchestrator
    // run while a task of its tree still waits for review.
    const grants = await client.call('grant.list', { sessionId: s.sessionId });
    expect(grants.items.map((g) => g.lifetime)).toEqual(['run']);
  });
});
