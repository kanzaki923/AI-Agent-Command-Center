/**
 * Tool permissions through the real daemon (every module, the mock runtime): profiles per
 * project, the decision trail (`tool.decided`, `Run.toolDecisions`, `Run.permission`),
 * remembered approvals (`approval.respond({ remember })`, `permissionRule.*`) and who may
 * change any of it.
 */
import type { Approval, Event, Run } from '@acc/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockAgentRuntime } from './mock/runtime';
import { HUMAN, type TestDaemonNoServer, agentActor, createTestDaemon } from '../testing';
import { type TempRepo, createTempRepo, isolateGitConfig } from '../workspace/git-fixture';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

let restoreGit: () => void;
beforeAll(() => {
  restoreGit = isolateGitConfig();
});
afterAll(() => restoreGit());

let d: TestDaemonNoServer | undefined;
let repo: TempRepo | undefined;
afterEach(async () => {
  await d?.cleanup();
  await repo?.cleanup();
  d = undefined;
  repo = undefined;
});

const PLAN = [
  'テストを動かして',
  '```acc-mock',
  JSON.stringify([
    { type: 'run', command: 'node', args: ['scripts/check.js'], onReject: 'continue' },
    { type: 'run', command: 'git', args: ['push', 'origin', 'HEAD'] },
  ]),
  '```',
].join('\n');

async function setup(profile?: 'careful' | 'standard' | 'autonomous') {
  repo = await createTempRepo({ 'scripts/check.js': 'process.exit(0);\n' });
  d = await createTestDaemon();
  const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
  vi.spyOn(d.ctx.service('runtimes').get('mock'), 'run').mockImplementation((input) =>
    fast.run(input),
  );
  const events: Event[] = [];
  d.ctx.bus.subscribe({}, (e) => events.push(e));
  const project = await d.call(HUMAN, 'project.create', {
    name: 'demo',
    repoPath: repo.path,
    defaultBranch: 'main',
    ...(profile ? { permissionProfile: profile } : {}),
  });
  const task = await d.call(HUMAN, 'task.create', { projectId: project.id, title: 'テスト' });
  const ws = await d.call(HUMAN, 'workspace.create', { projectId: project.id, taskId: task.id });
  const session = await d.call(HUMAN, 'session.create', {
    projectId: project.id,
    kind: 'agent',
    runtime: 'mock',
    workspaceId: ws.id,
    taskId: task.id,
  });
  const daemon = d;
  const send = async () => {
    const { runId } = await daemon.call(HUMAN, 'session.send', {
      sessionId: session.id,
      content: PLAN,
    });
    return runId;
  };
  const pending = async (runId: string): Promise<Approval> =>
    vi.waitFor(
      () => {
        const ap = daemon.ctx.repos.approvals.find({
          where: { run_id: runId, status: 'pending' },
        })[0];
        if (!ap) throw new Error('no approval yet');
        return ap;
      },
      { timeout: 30_000, interval: 20 },
    );
  const end = (runId: string): Promise<Run> => daemon.ctx.service('runs').waitForEnd(runId);
  const decided = (runId: string) =>
    events.flatMap((e) => (e.type === 'tool.decided' && e.runId === runId ? [e.payload] : []));
  return { d: daemon, project, task, session, events, send, pending, end, decided };
}

describe('tool permissions through the daemon', () => {
  it('the default (autonomous) profile asks nothing and records every decision', async () => {
    const s = await setup();
    const runId = await s.send();
    const run = await s.end(runId);
    expect(run.status).toBe('completed');
    expect(s.d.ctx.repos.approvals.find({})).toEqual([]);
    expect(run.permission).toEqual({ profile: 'autonomous', gate: 'rules', note: null });
    expect(run.toolDecisions).toEqual({ allowed: 1, denied: 1, asked: 0 });
    const decided = s.decided(runId);
    expect(decided.map((x) => [x.decision, x.decidedBy, x.category, x.rule])).toEqual([
      ['allowed', 'rule', 'build_test', null],
      ['denied', 'rule', 'command_other', 'publish_remote'],
    ]);
    // Events carry the run's refs so the Timeline can filter them.
    const ev = s.events.find((e) => e.type === 'tool.decided')!;
    expect(ev).toMatchObject({ projectId: s.project.id, taskId: s.task.id, runId });
    expect(ev.actor).toEqual({ kind: 'system', component: 'permissions' });
  });

  it('remembers an approval for the project, applies it to later runs, and can revoke it', async () => {
    const s = await setup('careful');
    // 1st run: the command is asked; the human approves it for the project.
    const first = await s.send();
    const ap = await s.pending(first);
    expect(ap.payload).toMatchObject({
      toolName: 'Bash',
      category: 'build_test',
      // Shown on the card before the human picks a scope.
      rememberAs: 'コマンド「node scripts/check.js」を許可',
    });
    await s.d.call(HUMAN, 'approval.respond', {
      approvalId: ap.id,
      decision: 'approve',
      remember: 'project',
    });
    expect((await s.end(first)).toolDecisions).toEqual({ allowed: 0, denied: 1, asked: 1 });
    const rules = await s.d.call(HUMAN, 'permissionRule.list', { projectId: s.project.id });
    expect(rules.items).toEqual([
      expect.objectContaining({
        scope: 'project',
        toolName: 'Bash',
        commandKeys: ['node scripts/check.js'],
        approvalId: ap.id,
        revokedAt: null,
      }),
    ]);
    expect(s.events.some((e) => e.type === 'permission.rule_created')).toBe(true);

    // 2nd run: allowed by the remembered approval; the hard rule still denies the push.
    const second = await s.send();
    const run2 = await s.end(second);
    expect(s.d.ctx.repos.approvals.find({ where: { run_id: second } })).toEqual([]);
    expect(s.decided(second).map((x) => [x.decision, x.decidedBy])).toEqual([
      ['allowed', 'remembered'],
      ['denied', 'rule'],
    ]);
    expect(run2.toolDecisions).toEqual({ allowed: 1, denied: 1, asked: 0 });

    // Revoked: asked again.
    await s.d.call(HUMAN, 'permissionRule.revoke', { ruleId: rules.items[0]!.id });
    const third = await s.send();
    const ap3 = await s.pending(third);
    await s.d.call(HUMAN, 'approval.respond', { approvalId: ap3.id, decision: 'reject' });
    expect((await s.end(third)).status).toBe('completed');
    expect(
      (
        await s.d.call(HUMAN, 'permissionRule.list', {
          projectId: s.project.id,
          includeRevoked: true,
        })
      ).items[0]!.revokedAt,
    ).not.toBeNull();
  });

  it('remembers for one run only when asked to, and refuses what cannot be remembered', async () => {
    const s = await setup('careful');
    const runId = await s.send();
    const ap = await s.pending(runId);
    await expect(
      s.d.call(HUMAN, 'approval.respond', {
        approvalId: ap.id,
        decision: 'reject',
        remember: 'project',
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    // An agent with approval rights may answer, but never widen what agents may do.
    const peerRun = s.d.ctx.ids.next('run');
    const peer = agentActor(s.d.ctx.ids.next('session'), peerRun);
    s.d.ctx.repos.grants.insert({
      id: s.d.ctx.ids.next('grant'),
      subject: { kind: 'run', runId: peerRun },
      parentGrantId: null,
      permissions: ['approval.*'],
      scope: {},
      limits: {},
      depth: 0,
      lifetime: 'run',
      expiresAt: null,
      revokedAt: null,
      reason: null,
      grantedBy: HUMAN,
      createdAt: s.d.ctx.clock.iso(),
    });
    await expect(
      s.d.call(peer, 'approval.respond', {
        approvalId: ap.id,
        decision: 'approve',
        remember: 'run',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // Nothing changed by the refused calls: the approval is still pending.
    expect(s.d.ctx.repos.approvals.require(ap.id).status).toBe('pending');
    await s.d.call(HUMAN, 'approval.respond', {
      approvalId: ap.id,
      decision: 'approve',
      remember: 'run',
    });
    await s.end(runId);
    const [rule] = (await s.d.call(HUMAN, 'permissionRule.list', { projectId: s.project.id }))
      .items;
    expect(rule).toMatchObject({ scope: 'run', runId });
    // A run-scoped approval does not reach the next run.
    const next = await s.send();
    const ap2 = await s.pending(next);
    await s.d.call(HUMAN, 'approval.respond', { approvalId: ap2.id, decision: 'approve' });
    await s.end(next);
  });

  it('lets only humans change how much agents may do', async () => {
    const s = await setup();
    const runId = s.d.ctx.ids.next('run');
    const agent = agentActor(s.session.id, runId);
    s.d.ctx.repos.grants.insert({
      id: s.d.ctx.ids.next('grant'),
      subject: { kind: 'run', runId },
      parentGrantId: null,
      permissions: ['*'],
      scope: {},
      limits: {},
      depth: 0,
      lifetime: 'run',
      expiresAt: null,
      revokedAt: null,
      reason: null,
      grantedBy: HUMAN,
      createdAt: s.d.ctx.clock.iso(),
    });
    await expect(
      s.d.call(agent, 'project.update', {
        projectId: s.project.id,
        permissionProfile: 'autonomous',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const updated = await s.d.call(HUMAN, 'project.update', {
      projectId: s.project.id,
      permissionProfile: 'careful',
    });
    expect(updated.permissionProfile).toBe('careful');

    const view = await s.d.call(HUMAN, 'settings.update', {
      defaultPermissionProfile: 'standard',
      autoMode: { classifierModel: 'team-classifier' },
    });
    expect(view).toMatchObject({
      defaultPermissionProfile: 'standard',
      // The server review is the default judge.
      autoMode: { enabled: true, judge: 'server', classifierModel: 'team-classifier' },
    });
    expect(s.d.ctx.settings.get().autoMode.classifierModel).toBe('team-classifier');
    const client = await s.d.call(HUMAN, 'settings.update', { autoMode: { judge: 'client' } });
    expect(client.autoMode).toEqual({
      enabled: true,
      judge: 'client',
      classifierModel: 'team-classifier',
    });
  });
});
