/**
 * T4 acceptance (spec 20261029 §5.6): questions and attention items through the real daemon
 * (every module, the mock agent runtime, the mock LLM). No real model or API is called.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor, Attention, MethodName, Run } from '@acc/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../core/errors';
import { deriveSessionState, readStateFacts } from '../home';
import { actorOf, insertRun, setRunStatus } from '../policy/testutil';
import { MockAgentRuntime } from '../runtime/mock/runtime';
import { HUMAN, type TestDaemonNoServer, createTestDaemon } from '../testing';
import { type TempRepo, createTempRepo, isolateGitConfig } from '../workspace/git-fixture';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

let restoreGit: () => void;
beforeAll(() => {
  restoreGit = isolateGitConfig();
});
afterAll(() => restoreGit());

const daemons: TestDaemonNoServer[] = [];
const repos: TempRepo[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.cleanup();
  for (const r of repos.splice(0)) await r.cleanup();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 5 });
});

const QUESTION = '価格（月額 980 円）を FAQ に載せる？';

const plan = (steps: unknown[], summary = 'FAQ を書きました') =>
  ['FAQ を作って', '```acc-mock', JSON.stringify({ steps, summary, delayScale: 0 }), '```'].join(
    '\n',
  );

const ASKING_PLAN = plan([
  { type: 'say', text: 'FAQ の下書きを始めます' },
  { type: 'ask', title: QUESTION, choices: ['載せる', '載せない'], detail: '公式発表の前です' },
  { type: 'write', path: 'faq.md', content: '# FAQ\n\n- 月額 980 円\n' },
]);

const COMMAND_PLAN = plan([
  { type: 'run', command: 'node', args: ['scripts/check.js'], onReject: 'continue' },
  { type: 'write', path: 'after.txt', content: 'x' },
]);

async function daemon(home?: string): Promise<TestDaemonNoServer> {
  const d = await createTestDaemon(home ? { home } : {});
  daemons.push(d);
  d.ctx.service('llm').mock.chunkDelayMs = 0;
  const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
  vi.spyOn(d.ctx.service('runtimes').get('mock'), 'run').mockImplementation((input) =>
    fast.run(input),
  );
  return d;
}

async function closeDaemon(d: TestDaemonNoServer): Promise<void> {
  daemons.splice(daemons.indexOf(d), 1);
  await d.close();
}

/** An agent session (mock runtime, a worktree) whose grant offers `human.ask`. */
async function agentSession(
  d: TestDaemonNoServer,
  opts: { profile?: 'careful' | 'autonomous'; permissions?: string[] } = {},
) {
  const repo = await createTempRepo({ 'scripts/check.js': 'process.exit(0);\n' });
  repos.push(repo);
  const project = await d.call(HUMAN, 'project.create', {
    name: `demo-${repos.length}`,
    repoPath: repo.path,
    defaultBranch: 'main',
    ...(opts.profile ? { permissionProfile: opts.profile } : {}),
  });
  const ws = await d.call(HUMAN, 'workspace.create', { projectId: project.id });
  const session = await d.call(HUMAN, 'session.create', {
    projectId: project.id,
    kind: 'agent',
    runtime: 'mock',
    workspaceId: ws.id,
    title: 'FAQ 担当',
  });
  d.ctx.service('policy').createGrant(
    {
      subject: { kind: 'session', sessionId: session.id },
      permissions: opts.permissions ?? ['human.ask'],
      lifetime: 'session',
    },
    HUMAN,
  );
  return { project, ws, session };
}

async function send(d: TestDaemonNoServer, sessionId: string, content: string): Promise<string> {
  const { runId } = await d.call(HUMAN, 'session.send', { sessionId, content });
  return runId!;
}

const end = (d: TestDaemonNoServer, runId: string): Promise<Run> =>
  d.ctx.service('runs').waitForEnd(runId);

function openItems(d: TestDaemonNoServer, sessionId: string): Attention[] {
  return d.ctx.repos.attention.find({ where: { session_id: sessionId, status: 'open' } });
}

function stateOf(d: TestDaemonNoServer, sessionId: string) {
  return deriveSessionState(readStateFacts(d.ctx, d.ctx.repos.sessions.require(sessionId)));
}

/** The run started after `afterRunId` in the session (the one an answer started). */
async function nextRun(d: TestDaemonNoServer, sessionId: string, afterRunId: string) {
  return vi.waitFor(
    () => {
      const run = d.ctx.repos.runs.findOne({ where: { session_id: sessionId } });
      if (!run || run.id === afterRunId) throw new Error('no new run yet');
      return run;
    },
    { timeout: 30_000, interval: 20 },
  );
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'ok',
    (e: unknown) => (e instanceof ApiError ? e.code : String(e)),
  );
}

function textOf(d: TestDaemonNoServer, sessionId: string, role: 'user' | 'assistant'): string[] {
  return d.ctx.repos.messages
    .find({ where: { session_id: sessionId }, direction: 'asc' })
    .filter((m) => m.role === role)
    .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
}

describe('T4 acceptance: questions', () => {
  it('1. human.ask from the mock agent opens a one-line question, ends the run and needs you', async () => {
    const d = await daemon();
    const { session, ws } = await agentSession(d);
    const run = await end(d, await send(d, session.id, ASKING_PLAN));

    expect(run.status).toBe('completed');
    const [q, ...rest] = openItems(d, session.id);
    expect(rest).toEqual([]);
    expect(q).toMatchObject({
      kind: 'question',
      status: 'open',
      sessionId: session.id,
      rootSessionId: session.id,
      title: QUESTION,
      detail: '公式発表の前です',
      choices: [
        { id: 'c1', label: '載せる', tone: 'primary' },
        { id: 'c2', label: '載せない', tone: 'neutral' },
      ],
      allowText: true,
      refs: { askedBySessionId: session.id, runId: run.id },
    });
    // One line, no risk level, no "remember" choice, and not an approval.
    expect(q!.title).not.toMatch(/\n/);
    expect(q!.choices.map((c) => c.id)).not.toContain('approve');
    expect(JSON.stringify(q)).not.toMatch(/今後も許可|risk/);
    expect(d.ctx.repos.approvals.find({ where: { session_id: session.id } })).toEqual([]);
    // The run stopped at the question: the rest of the plan waits for the answer.
    expect(existsSync(join(ws.path, 'faq.md'))).toBe(false);
    expect(stateOf(d, session.id)).toBe('needs_you');
    const opened = d.ctx.bus.list({ types: ['attention.opened'] }).events;
    expect(opened.map((e) => e.sessionId)).toEqual([session.id]);
  });

  it('2. the answer arrives as a message and a new run continues the work', async () => {
    const d = await daemon();
    const { session, ws } = await agentSession(d);
    const first = await end(d, await send(d, session.id, ASKING_PLAN));
    const [q] = openItems(d, session.id);

    const answered = await d.call(HUMAN, 'attention.respond', {
      attentionId: q!.id,
      choiceId: 'c1',
    });
    expect(answered).toMatchObject({
      status: 'resolved',
      resolution: { choiceId: 'c1', text: null, by: HUMAN },
    });
    const answer = d.ctx.repos.messages
      .find({ where: { session_id: session.id } })
      .find((m) => m.meta?.kind === 'answer')!;
    expect(answer).toMatchObject({
      role: 'user',
      author: HUMAN,
      delivery: 'delivered',
      content: [{ type: 'text', text: '回答: 載せる' }],
      meta: { kind: 'answer', attentionId: q!.id, choiceLabel: '載せる' },
    });

    const second = await nextRun(d, session.id, first.id);
    // An answer is one of the inbox's wake items (spec §3.2), so its run is a wake.
    expect(second).toMatchObject({ kind: 'agent', trigger: 'wake', triggerMessageId: answer.id });
    expect((await end(d, second.id)).status).toBe('completed');
    expect(existsSync(join(ws.path, 'faq.md'))).toBe(true);
    expect(textOf(d, session.id, 'assistant')).toContain(
      '回答を受け取りました（載せる）。続きを進めます。',
    );
    expect(stateOf(d, session.id)).not.toBe('needs_you');
    // First come, first served: a second answer is refused.
    expect(
      await codeOf(d.call(HUMAN, 'attention.respond', { attentionId: q!.id, choiceId: 'c2' })),
    ).toBe('conflict');
  });

  it('2b. a free-text answer works too, and a busy session gets it after its run', async () => {
    const d = await daemon();
    const { session } = await agentSession(d);
    await end(d, await send(d, session.id, ASKING_PLAN));
    const [q] = openItems(d, session.id);
    // The agent is busy again (a human started more work) when the answer comes.
    const busy = await send(d, session.id, plan([{ type: 'sleep', ms: 300 }], '別件を終えました'));
    await d.call(HUMAN, 'attention.respond', { attentionId: q!.id, text: '価格は載せないで' });
    const answer = d.ctx.repos.messages
      .find({ where: { session_id: session.id } })
      .find((m) => m.meta?.kind === 'answer')!;
    expect(answer).toMatchObject({
      delivery: 'queued',
      content: [{ type: 'text', text: '回答: 価格は載せないで' }],
      meta: { choiceLabel: null },
    });
    await end(d, busy);
    const after = await nextRun(d, session.id, busy);
    expect(after.triggerMessageId).toBe(answer.id);
    await end(d, after.id);
    expect(d.ctx.repos.messages.require(answer.id).delivery).toBe('delivered');
  });

  it('3. a question survives a daemon restart; approvals are withdrawn', async () => {
    const home = mkdtempSync(join(tmpdir(), 'acc-attention-'));
    homes.push(home);
    const d1 = await daemon(home);
    const asking = await agentSession(d1);
    await end(d1, await send(d1, asking.session.id, ASKING_PLAN));
    const [q] = openItems(d1, asking.session.id);
    // Another agent waits on a tool approval when the daemon stops.
    const careful = await agentSession(d1, { profile: 'careful' });
    const waiting = await send(d1, careful.session.id, COMMAND_PLAN);
    const ap = await vi.waitFor(() => {
      const [item] = openItems(d1, careful.session.id);
      if (!item) throw new Error('no approval item yet');
      return item;
    });
    expect(ap.kind).toBe('approval');
    await closeDaemon(d1);

    const d2 = await daemon(home);
    expect(d2.ctx.repos.runs.require(waiting).status).toMatch(/interrupted|cancelled/);
    expect(d2.ctx.repos.attention.require(ap.id)).toMatchObject({
      status: 'resolved',
      resolution: { choiceId: null, by: { kind: 'system' } },
    });
    expect(d2.ctx.repos.attention.require(q!.id).status).toBe('open');
    expect(stateOf(d2, asking.session.id)).toBe('needs_you');

    const before = d2.ctx.repos.runs.findOne({ where: { session_id: asking.session.id } })!;
    await d2.call(HUMAN, 'attention.respond', { attentionId: q!.id, choiceId: 'c2' });
    const run = await nextRun(d2, asking.session.id, before.id);
    expect((await end(d2, run.id)).status).toBe('completed');
    expect(textOf(d2, asking.session.id, 'user').at(-1)).toBe('回答: 載せない');
    // The mock's plan did not survive the restart, but the answer reached the agent.
    expect(textOf(d2, asking.session.id, 'assistant')).toContain(
      '回答を受け取りました（載せない）。続きを進めます。',
    );
  });
});

describe('T4 acceptance: who may answer', () => {
  /** root → child (a chat), plus another tree; each child may ask. */
  async function trees(d: TestDaemonNoServer) {
    const root = await d.call(HUMAN, 'session.create', { title: 'まとめ役' });
    const child = await d.call(HUMAN, 'session.create', {
      parentSessionId: root.id,
      title: '調査',
    });
    const other = await d.call(HUMAN, 'session.create', { title: '別件' });
    const policy = d.ctx.service('policy');
    const grant = (sessionId: string, permissions: string[]) =>
      policy.createGrant(
        { subject: { kind: 'session', sessionId }, permissions, lifetime: 'session' },
        HUMAN,
      );
    grant(root.id, ['attention.respond', 'attention.list', 'attention.dismiss']);
    grant(child.id, ['human.ask', 'attention.respond']);
    grant(other.id, ['human.ask']);
    const asker = (sessionId: string) => {
      const run = insertRun(d.ctx, { sessionId });
      return { actor: actorOf(run), run };
    };
    return { root, child, other, supervisor: asker(root.id).actor, asker };
  }

  it("4. a supervisor answers its descendants' questions, not other trees or approvals", async () => {
    const d = await daemon();
    const t = await trees(d);
    const c = t.asker(t.child.id);
    const o = t.asker(t.other.id);
    const childQ = await d.call(c.actor, 'human.ask', {
      question: '対象は国内だけ？',
      choices: ['国内', '海外も'],
    });
    const otherQ = await d.call(o.actor, 'human.ask', { question: '締め切りは？' });
    setRunStatus(d.ctx, c.run.id, 'completed');
    setRunStatus(d.ctx, o.run.id, 'completed');
    const approval = d.ctx.service('attention').open({
      kind: 'approval',
      sessionId: t.child.id,
      title: 'pnpm add zod を実行',
      refs: { runId: c.run.id },
      actor: HUMAN,
    })!;

    // Listing: the supervisor sees its own tree only.
    const listed = await d.call(t.supervisor, 'attention.list', {});
    expect(listed.items.map((a) => a.id).sort()).toEqual([childQ.attentionId, approval.id].sort());
    expect(await codeOf(d.call(t.supervisor, 'attention.list', { sessionId: t.other.id }))).toBe(
      'forbidden',
    );

    expect(
      await codeOf(
        d.call(t.supervisor, 'attention.respond', {
          attentionId: otherQ.attentionId,
          text: '来週',
        }),
      ),
    ).toBe('forbidden');
    expect(
      await codeOf(
        d.call(t.supervisor, 'attention.respond', {
          attentionId: approval.id,
          choiceId: 'approve',
        }),
      ),
    ).toBe('forbidden');
    expect(
      await codeOf(d.call(t.supervisor, 'attention.dismiss', { attentionId: childQ.attentionId })),
    ).toBe('forbidden');
    // The asker cannot answer its own question.
    expect(
      await codeOf(
        d.call(c.actor, 'attention.respond', { attentionId: childQ.attentionId, choiceId: 'c1' }),
      ),
    ).toBe('forbidden');

    const answered = await d.call(t.supervisor, 'attention.respond', {
      attentionId: childQ.attentionId,
      choiceId: 'c1',
    });
    expect(answered.resolution).toMatchObject({ choiceId: 'c1', by: t.supervisor });
    const run = await nextRun(d, t.child.id, c.run.id);
    expect(run).toMatchObject({ kind: 'chat', trigger: 'wake' });
    await end(d, run.id);
    expect(textOf(d, t.child.id, 'user').at(-1)).toBe('回答: 国内');
    expect(
      d.ctx.repos.messages.find({ where: { session_id: t.child.id } }).find((m) => m.meta)?.author,
    ).toEqual(t.supervisor);
    // Still open for the human.
    expect(d.ctx.repos.attention.require(approval.id).status).toBe('open');
    expect(d.ctx.repos.attention.require(otherQ.attentionId).status).toBe('open');
  });
});

describe('T4 acceptance: resolution and routing', () => {
  it('5a/7. a tool approval becomes a one-line item that resolves with the approval', async () => {
    const d = await daemon();
    const { session } = await agentSession(d, { profile: 'careful' });
    const runId = await send(d, session.id, COMMAND_PLAN);
    const item = await vi.waitFor(() => {
      const [a] = openItems(d, session.id);
      if (!a) throw new Error('no item yet');
      return a;
    });
    const approval = d.ctx.repos.approvals.find({ where: { run_id: runId } })[0]!;
    expect(item).toMatchObject({
      kind: 'approval',
      title: 'node scripts/check.js を実行',
      choices: [
        { id: 'approve', label: '許可', tone: 'primary' },
        { id: 'reject', label: '拒否', tone: 'danger' },
      ],
      allowText: false,
      refs: { approvalId: approval.id, runId },
    });
    expect(approval.title).toBe('node scripts/check.js を実行');
    for (const t of [item.title, approval.title]) expect(t).not.toMatch(/承認しますか/);
    expect(stateOf(d, session.id)).toBe('needs_you');

    // Answered where the approval lives: the item follows.
    await d.call(HUMAN, 'approval.respond', { approvalId: approval.id, decision: 'approve' });
    expect(d.ctx.repos.attention.require(item.id)).toMatchObject({
      status: 'resolved',
      resolution: { choiceId: 'approve', by: HUMAN },
    });
    expect((await end(d, runId)).status).toBe('completed');
  });

  it('6. approval: attention.respond approve / reject goes through approval.respond', async () => {
    const d = await daemon();
    const { session, ws } = await agentSession(d, { profile: 'careful' });
    const runId = await send(d, session.id, COMMAND_PLAN);
    const item = await vi.waitFor(() => {
      const [a] = openItems(d, session.id);
      if (!a) throw new Error('no item yet');
      return a;
    });
    expect(
      await codeOf(d.call(HUMAN, 'attention.respond', { attentionId: item.id, text: 'だめ' })),
    ).toBe('invalid_params');
    const out = await d.call(HUMAN, 'attention.respond', {
      attentionId: item.id,
      choiceId: 'reject',
    });
    expect(out).toMatchObject({ status: 'resolved', resolution: { choiceId: 'reject' } });
    expect(d.ctx.repos.approvals.find({ where: { run_id: runId } })[0]!.status).toBe('rejected');
    expect((await end(d, runId)).status).toBe('completed');
    // onReject "continue": the command was skipped and the plan went on.
    expect(existsSync(join(ws.path, 'after.txt'))).toBe(true);
  });

  /** Routed calls are recorded instead of executed (other tracks own those methods). */
  function captureRoutes(d: TestDaemonNoServer, failing: MethodName[] = []) {
    const routed = new Set<MethodName>([
      'task.retry',
      'run.retry',
      'session.stop',
      'session.send',
      'session.resume',
      'integration.approve',
      'integration.reject',
      'artifact.review',
      'budget.raise',
    ]);
    const calls: { method: string; params: unknown; actor: Actor }[] = [];
    const original = d.ctx.call.bind(d.ctx);
    vi.spyOn(d.ctx, 'call').mockImplementation(((
      actor: Actor,
      method: MethodName,
      params: unknown,
      opts?: never,
    ) => {
      if (!routed.has(method)) return original(actor, method, params as never, opts);
      calls.push({ method, params, actor });
      if (failing.includes(method)) return Promise.reject(new ApiError('conflict', 'できません'));
      return Promise.resolve({} as never);
    }) as typeof d.ctx.call);
    return calls;
  }

  it('6. every kind routes its choices (§3.6)', async () => {
    const d = await daemon();
    const s = await d.call(HUMAN, 'session.create', { title: '会話' });
    const att = d.ctx.service('attention');
    const run = insertRun(d.ctx, { sessionId: s.id, status: 'failed' });
    const calls = captureRoutes(d);
    const open = (kind: Attention['kind'], refs: Attention['refs']) =>
      att.open({ kind, sessionId: s.id, title: `${kind} の出番`, refs, actor: HUMAN })!;
    const respond = (a: Attention, input: { choiceId?: string; text?: string }) =>
      d.call(HUMAN, 'attention.respond', { attentionId: a.id, ...input });
    const last = () => calls.at(-1);
    const id = new Map<string, string>();
    const fake = (kind: 'task' | 'run' | 'integration' | 'artifact' | 'budget', name: string) => {
      const key = `${kind}:${name}`;
      if (!id.has(key)) id.set(key, d.ctx.ids.next(kind));
      return id.get(key)!;
    };

    await respond(open('failure', { runId: run.id, taskId: fake('task', 'x1') }), {
      choiceId: 'retry',
      text: '型エラーを直して',
    });
    expect(last()).toMatchObject({
      method: 'task.retry',
      params: { taskId: fake('task', 'x1'), feedback: '型エラーを直して' },
      actor: HUMAN,
    });
    await respond(open('failure', { runId: run.id }), { choiceId: 'retry' });
    expect(last()).toMatchObject({ method: 'run.retry', params: { runId: run.id } });
    await respond(open('failure', { runId: fake('run', 'other') }), { choiceId: 'stop' });
    expect(last()).toMatchObject({ method: 'session.stop', params: { sessionId: s.id } });
    await respond(open('failure', { runId: fake('run', 'text') }), { text: '別の方法で' });
    expect(last()).toMatchObject({
      method: 'session.send',
      params: { sessionId: s.id, content: '別の方法で' },
    });

    await respond(open('review', { integrationId: fake('integration', '1') }), {
      choiceId: 'accept',
    });
    expect(last()).toMatchObject({
      method: 'integration.approve',
      params: { integrationId: fake('integration', '1') },
    });
    await respond(open('review', { artifactId: fake('artifact', '1') }), { choiceId: 'accept' });
    expect(last()).toMatchObject({
      method: 'artifact.review',
      params: { artifactId: fake('artifact', '1'), decision: 'accept' },
    });
    await respond(open('review', { artifactId: fake('artifact', '2') }), {
      choiceId: 'redo',
      text: '短く',
    });
    expect(last()).toMatchObject({
      method: 'artifact.review',
      params: { artifactId: fake('artifact', '2'), decision: 'redo', note: '短く' },
    });
    await respond(open('review', { artifactId: fake('artifact', '3') }), { text: '表にして' });
    expect(last()).toMatchObject({
      method: 'artifact.review',
      params: { artifactId: fake('artifact', '3'), decision: 'redo', note: '表にして' },
    });
    await respond(open('review', { taskId: fake('task', 'r') }), { choiceId: 'redo' });
    expect(last()).toMatchObject({ method: 'task.retry', params: { taskId: fake('task', 'r') } });

    await respond(open('budget', { budgetId: fake('budget', '1') }), { choiceId: 'add_5' });
    expect(last()).toMatchObject({
      method: 'budget.raise',
      params: { budgetId: fake('budget', '1'), addUsd: 5 },
    });
    await respond(open('budget', { budgetId: fake('budget', '2') }), { choiceId: 'stop' });
    expect(last()).toMatchObject({ method: 'session.stop' });

    await respond(open('stuck', { runId: fake('run', 's1') }), {
      choiceId: 'continue',
      text: '続けて',
    });
    expect(last()).toMatchObject({
      method: 'session.resume',
      params: { sessionId: s.id, message: '続けて' },
    });
    await respond(open('stuck', { runId: fake('run', 's2') }), { choiceId: 'stop' });
    expect(last()).toMatchObject({ method: 'session.stop', params: { sessionId: s.id } });

    expect(calls).toHaveLength(13);
    // Each answered item is resolved with who answered and how.
    const resolved = d.ctx.repos.attention.find({ where: { status: 'resolved' } });
    expect(resolved).toHaveLength(13);
    expect(resolved.every((a) => a.resolution?.by.kind === 'human')).toBe(true);
    expect(openItems(d, s.id)).toEqual([]);
  });

  it('6. invalid answers are refused, and a failed route leaves the item open', async () => {
    const d = await daemon();
    const s = await d.call(HUMAN, 'session.create', { title: '会話' });
    const calls = captureRoutes(d, ['run.retry']);
    const a = d.ctx.service('attention').open({
      kind: 'failure',
      sessionId: s.id,
      title: '「調査」が失敗',
      refs: { runId: d.ctx.ids.next('run') },
      actor: HUMAN,
    })!;
    const respond = (input: { choiceId?: string; text?: string }) =>
      codeOf(d.call(HUMAN, 'attention.respond', { attentionId: a.id, ...input }));
    expect(await respond({})).toBe('invalid_params');
    expect(await respond({ choiceId: 'approve' })).toBe('invalid_params');
    expect(await respond({ choiceId: 'retry' })).toBe('conflict');
    expect(calls.map((c) => c.method)).toEqual(['run.retry']);
    expect(d.ctx.repos.attention.require(a.id).status).toBe('open');
    await d.call(HUMAN, 'attention.dismiss', { attentionId: a.id });
    expect(d.ctx.repos.attention.require(a.id)).toMatchObject({
      status: 'dismissed',
      resolution: { choiceId: null, by: HUMAN },
    });
    expect(await respond({ choiceId: 'stop' })).toBe('conflict');
  });

  it('5b-d. items resolve themselves when the retry starts, the output is accepted, money is added', async () => {
    const d = await daemon();
    const s = await d.call(HUMAN, 'session.create', { title: '会話' });
    const att = d.ctx.service('attention');
    const open = (kind: Attention['kind'], refs: Attention['refs']) =>
      att.open({ kind, sessionId: s.id, title: `${kind} の出番`, refs, actor: HUMAN })!;

    // Retry: a new run in the session makes its failure moot.
    const failed = d.ctx.repos.runs.update(insertRun(d.ctx, { sessionId: s.id }).id, (r) => ({
      ...r,
      kind: 'chat',
      status: 'failed',
      endedAt: d.ctx.clock.iso(),
    }));
    const failure = open('failure', { runId: failed.id });
    const stuck = open('stuck', { runId: failed.id });
    const { runId } = await d.call(HUMAN, 'run.retry', { runId: failed.id });
    expect(d.ctx.repos.attention.require(failure.id).status).toBe('resolved');
    expect(d.ctx.repos.attention.require(stuck.id).status).toBe('resolved');
    await end(d, runId);

    // Accepted output.
    const now = d.ctx.clock.iso();
    const artifact = d.ctx.repos.artifacts.insert({
      id: d.ctx.ids.next('artifact'),
      kind: 'link',
      projectId: null,
      sessionId: s.id,
      runId: null,
      taskId: null,
      workspaceId: null,
      title: '競合の価格表',
      data: { url: 'https://example.com', label: null },
      createdBy: HUMAN,
      createdAt: now,
    });
    const review = open('review', { artifactId: artifact.id });
    d.ctx.db.transaction(() => {
      const accepted = d.ctx.repos.artifacts.update(artifact.id, (a) => ({
        ...a,
        review: { state: 'accepted', by: HUMAN, at: now, note: null },
      }));
      d.ctx.bus.emit({
        type: 'artifact.updated',
        actor: HUMAN,
        payload: { artifact: accepted, changes: ['review'] },
      });
    });
    expect(d.ctx.repos.attention.require(review.id)).toMatchObject({
      status: 'resolved',
      resolution: { choiceId: 'accept', by: HUMAN },
    });

    // Budget: used up → item; raised → resolved.
    const budgets = d.ctx.service('budget');
    const budget = budgets.createRoot({
      subject: { kind: 'session', id: s.id },
      limitUsd: 1,
      actor: HUMAN,
    });
    budgets.recordSpend(budget.id, 1);
    const money = open('budget', { budgetId: budget.id });
    expect(d.ctx.repos.attention.require(money.id).status).toBe('open');
    d.ctx.db.transaction(() => {
      const raised = d.ctx.repos.budgets.update(budget.id, (b) => ({ ...b, limitUsd: 2 }));
      d.ctx.bus.emit({
        type: 'budget.updated',
        actor: HUMAN,
        payload: { budget: raised, reason: 'raise' },
      });
    });
    expect(d.ctx.repos.attention.require(money.id).status).toBe('resolved');
  });
});
