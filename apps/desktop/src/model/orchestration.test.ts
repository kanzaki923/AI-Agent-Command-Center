// @vitest-environment node
import type { Artifact, CapabilityGrant, Integration, IntegrationStep } from '@acc/protocol';
import { describe, expect, it } from 'vitest';
import { T0, approval, id, integration, iso, message, run, session, task } from '../test/fixtures';
import { describeApproval } from './approval';
import { buildBoard, stabilizeItems } from './board';
import {
  DEFAULT_GRANT_INPUT,
  GRANT_PRESETS,
  activeGrants,
  canOrchestrate,
  capabilityLines,
  describeGrant,
  grantParams,
  presetOf,
} from './grant';
import { applyPlan, canApprove, canReject, integrationSummary } from './integration';
import {
  buildTaskGroups,
  canSpawn,
  flattenTasks,
  goalFromMessages,
  integrableTasks,
  taskState,
  workerLabel,
} from './tasks';

function grant(over: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    id: id('grt'),
    subject: { kind: 'session', sessionId: id('ses') },
    parentGrantId: null,
    permissions: GRANT_PRESETS.orchestrate.permissions,
    scope: {},
    limits: { maxWorkers: 2, maxDepth: 1 },
    depth: 0,
    lifetime: 'run',
    expiresAt: null,
    revokedAt: null,
    reason: null,
    grantedBy: { kind: 'human', client: 'test' },
    createdAt: iso(T0),
    ...over,
  };
}

function step(over: Partial<IntegrationStep>): IntegrationStep {
  return {
    index: 0,
    kind: 'merge',
    status: 'succeeded',
    title: 'merge',
    taskId: null,
    artifactId: null,
    detail: null,
    startedAt: null,
    endedAt: null,
    workspaceId: null,
    branch: null,
    conflictFiles: [],
    ...over,
  };
}

describe('orchestrator grant presets', () => {
  it('builds grant.create params scoped to the project, with worker limits and depth 1', () => {
    const p = grantParams({ ...DEFAULT_GRANT_INPUT, sessionId: 'ses_x', projectId: 'prj_a' }, T0);
    expect(p.subject).toEqual({ kind: 'session', sessionId: 'ses_x' });
    expect(p.scope).toEqual({ projectIds: ['prj_a'] });
    expect(p.limits).toEqual({ maxWorkers: 2, maxDepth: 1 });
    expect(p.lifetime).toBe('run');
    expect(p.expiresAt).toBeUndefined();
    expect(p.permissions).toContain('task.*');
    // Applying integrations is never part of a preset (humans only).
    expect(p.permissions).not.toContain('integration.approve');
  });

  it('expires session grants and lets the plan preset start no workers', () => {
    const p = grantParams(
      {
        ...DEFAULT_GRANT_INPUT,
        preset: 'plan',
        lifetime: 'session',
        expiresInMs: 3600_000,
        sessionId: 's',
        projectId: null,
      },
      T0,
    );
    expect(p.expiresAt).toBe(iso(T0 + 3600_000));
    expect(p.limits).toEqual({ maxWorkers: 0, maxDepth: 0 });
    expect(p.scope).toEqual({});
  });

  it('recognises presets and describes grants in words', () => {
    const g = grant({ scope: { projectIds: ['prj_a'] } });
    expect(presetOf(g)).toBe('orchestrate');
    const v = describeGrant(g, [{ id: 'prj_a', name: 'acme-web' } as never]);
    expect(v).toMatchObject({
      title: 'Orchestrator',
      lifetime: 'この実行のみ',
      workers: 'Worker 2 人まで',
      projects: ['acme-web'],
      orchestrates: true,
      custom: false,
    });
    expect(v.capabilities).toContain('Worker の起動（worktree を作成）');
  });

  it('names custom grants by what they allow', () => {
    expect(describeGrant(grant({ permissions: ['task.*', 'session.*'] })).title).toBe(
      'Orchestrator',
    );
    expect(describeGrant(grant({ permissions: ['task.create'] })).title).toBe('計画のみ');
    expect(describeGrant(grant({ permissions: ['session.get'] })).title).toBe('カスタム権限');
    expect(describeGrant(grant({ permissions: ['*'] })).title).toBe('すべての操作');
    expect(
      describeGrant(grant({ parentGrantId: 'grt_parent', permissions: ['task.get'] })).title,
    ).toBe('委譲された権限');
  });

  it('filters revoked and expired grants', () => {
    const now = iso(T0 + 10_000);
    const live = grant();
    const revoked = grant({ revokedAt: iso(T0) });
    const expired = grant({ lifetime: 'session', expiresAt: iso(T0 + 5_000) });
    expect(activeGrants([live, revoked, expired], now)).toEqual([live]);
    expect(canOrchestrate(grant({ permissions: ['session.get'] }))).toBe(false);
    expect(capabilityLines(['*'])).toContain('設定の変更');
  });
});

describe('task tree', () => {
  const orch = session({ kind: 'chat', title: '設計チャット' });
  const r0 = run(orch, { kind: 'chat' });
  const byOrch = { kind: 'agent' as const, sessionId: orch.id, runId: r0.id };

  it('groups tasks under the orchestrator that created them, with workers, branches and diffs', () => {
    const a = task({
      title: 'A',
      status: 'review',
      createdBy: byOrch,
      workspaceId: 'wsp_a',
      createdAt: iso(T0),
    });
    const b = task({
      title: 'B',
      status: 'running',
      createdBy: byOrch,
      projectId: a.projectId,
      createdAt: iso(T0 + 1),
    });
    const c = task({
      title: 'C',
      status: 'pending',
      createdBy: byOrch,
      projectId: a.projectId,
      dependsOn: [a.id],
      createdAt: iso(T0 + 2),
    });
    const mine = task({ title: 'mine', status: 'done', projectId: a.projectId });
    const worker = session({
      kind: 'agent',
      title: 'Worker: B',
      taskId: b.id,
      parentSessionId: orch.id,
    });
    const wr = run(worker, { status: 'awaiting_approval' });
    const diff = {
      id: id('art'),
      kind: 'diff',
      taskId: a.id,
      workspaceId: 'wsp_a',
      data: {
        patch: '',
        baseRef: null,
        headRef: null,
        stats: { files: 2, additions: 10, deletions: 1 },
        files: [],
      },
    } as unknown as Artifact;
    const groups = buildTaskGroups({
      tasks: [a, b, c, mine],
      sessions: [orch, worker],
      runs: [r0, wr],
      workspaces: [{ id: 'wsp_a', branch: 'acc/docs-1234' } as never],
      diffs: [diff],
    });
    expect(groups.map((g) => g.id)).toEqual([orch.id, 'human']);
    const g = groups[0]!;
    expect(g.goal).toBe('設計チャット');
    // running first, then review, then pending
    expect(g.roots.map((n) => n.task.title)).toEqual(['B', 'A', 'C']);
    expect(g.counts).toMatchObject({ total: 3, running: 1, review: 1 });
    const [nb, na, nc] = g.roots;
    expect(nb!.worker?.id).toBe(worker.id);
    expect(workerLabel(nb!)).toBe('B');
    expect(nb!.workerRun?.status).toBe('awaiting_approval');
    expect(na!.workspace?.branch).toBe('acc/docs-1234');
    expect(na!.diff).toEqual({ files: 2, additions: 10, deletions: 1 });
    expect(nc!.waitsFor.map((t) => t.title)).toEqual(['A']);
    expect(integrableTasks(g).map((t) => t.title)).toEqual(['A']);
    expect(groups[1]!.finished).toBe(true);
  });

  it('nests subtasks and uses a single parent as the goal', () => {
    const parent = task({ title: '認証の整備', createdBy: byOrch });
    const child = task({
      title: 'テスト',
      parentTaskId: parent.id,
      projectId: parent.projectId,
      createdBy: byOrch,
    });
    const groups = buildTaskGroups({
      tasks: [parent, child],
      sessions: [orch],
      runs: [],
      workspaces: [],
      diffs: [],
    });
    expect(groups[0]!.goal).toBe('認証の整備');
    expect(flattenTasks(groups).map((n) => n.task.title)).toEqual(['認証の整備', 'テスト']);
  });

  it('filters by project and maps statuses', () => {
    const t = task({ projectId: 'prj_other' });
    expect(
      buildTaskGroups({
        tasks: [t],
        sessions: [],
        runs: [],
        workspaces: [],
        diffs: [],
        projectId: 'prj_mine',
      }),
    ).toEqual([]);
    expect(taskState('blocked')).toBe('queued');
    expect(taskState('review')).toBe('review');
    expect(canSpawn(task({ status: 'ready' }))).toBe(true);
    expect(canSpawn(task({ status: 'pending', dependsOn: ['tsk_x'] }))).toBe(false);
    expect(canSpawn(task({ status: 'running' }))).toBe(false);
  });

  it('takes the goal from the first thing the human asked', () => {
    const s = session({ kind: 'chat' });
    const msgs = [
      message(s, { role: 'assistant', content: [{ type: 'text', text: 'こんにちは' }] }),
      message(s, { content: [{ type: 'text', text: '認証まわりを整備して\n詳細は…' }] }),
    ];
    expect(goalFromMessages(msgs)).toBe('認証まわりを整備して');
    expect(goalFromMessages([])).toBeNull();
  });
});

describe('integration review', () => {
  const base = integration({
    status: 'awaiting_approval',
    targetRef: 'main',
    branch: 'acc/integration-1',
    baseSha: 'aaaaaaa1111',
    headSha: 'bbbbbbb2222',
    taskIds: ['tsk_1', 'tsk_2'],
    steps: [
      step({ index: 0, kind: 'merge' }),
      step({ index: 1, kind: 'verify', status: 'succeeded' }),
      step({ index: 2, kind: 'apply', status: 'pending' }),
    ],
  });

  it('states exactly what applying does: target, fast-forward, what is included', () => {
    const tasks = [task({ id: 'tsk_1', title: 'A' }), task({ id: 'tsk_2', title: 'B' })];
    const plan = applyPlan(base, { tasks, stats: { files: 3, additions: 20, deletions: 4 } });
    expect(plan.title).toBe('main に変更を反映しますか？');
    const text = plan.lines.join('\n');
    expect(text).toContain('「A」、「B」の変更（3 ファイル、+20 −4）を main に反映します');
    expect(text).toContain('早送り（fast-forward）');
    expect(text).toContain('aaaaaaa → bbbbbbb');
    expect(plan.caution).toBeNull();
  });

  it('warns when tests did not pass or were skipped', () => {
    const skipped: Integration = {
      ...base,
      steps: base.steps.map((s) => (s.kind === 'verify' ? { ...s, status: 'skipped' } : s)),
    };
    expect(applyPlan(skipped).caution).toContain('テスト');
    expect(integrationSummary(base)).toBe('2/3 ステップ · テスト成功');
  });

  it('allows decisions only in the right states', () => {
    expect(canApprove(base)).toBe(true);
    expect(canApprove({ ...base, status: 'verifying' })).toBe(false);
    expect(canReject({ ...base, status: 'running' })).toBe(false);
    expect(canReject({ ...base, status: 'conflict' })).toBe(true);
    expect(canReject({ ...base, status: 'applied' })).toBe(false);
    const conflict = {
      ...base,
      steps: [step({ status: 'failed', conflictFiles: ['a.ts', 'b.ts'], title: '「A」をマージ' })],
    };
    expect(integrationSummary(conflict)).toBe('コンフリクト 2 ファイル · 「A」をマージ');
  });
});

describe('board', () => {
  it('keeps unchanged items by identity across rebuilds (memoized rows skip work)', () => {
    const sessions = Array.from({ length: 10 }, (_, i) => session({ title: `S${i}` }));
    const runs = sessions.map((s) => {
      const r = run(s, { status: 'running' });
      s.activeRunId = r.id;
      return r;
    });
    const input = { sessions, runs, approvals: [], tasks: [], integrations: [] };
    const first = buildBoard(input);
    const prev = new Map(first.map((i) => [i.id, i]));
    // One run reports usage: only its row changes.
    const changed = { ...runs[3]!, usage: { ...runs[3]!.usage, costUsd: 1 } };
    const next = stabilizeItems(
      prev,
      buildBoard({ ...input, runs: runs.map((r) => (r.id === changed.id ? changed : r)) }),
    );
    const same = next.filter((i) => prev.get(i.id) === i);
    expect(same).toHaveLength(9);
    expect(next.find((i) => i.run?.id === changed.id)).not.toBe(prev.get(sessions[3]!.id));
  });

  it('does not ask for review twice when an integration already covers the task', () => {
    const t = task({ status: 'review' });
    const s = session({ taskId: t.id });
    const r = run(s, { status: 'completed', endedAt: iso(T0 + 5) });
    const i = integration({ status: 'awaiting_approval', taskIds: [t.id], projectId: t.projectId });
    const without = buildBoard({
      sessions: [s],
      runs: [r],
      approvals: [],
      tasks: [t],
      integrations: [],
    });
    expect(without.find((x) => x.id === s.id)?.state).toBe('review');
    const withInteg = buildBoard({
      sessions: [s],
      runs: [r],
      approvals: [],
      tasks: [t],
      integrations: [i],
    });
    expect(withInteg.find((x) => x.id === s.id)?.state).toBe('completed');
    expect(withInteg.filter((x) => x.zone === 'attention').map((x) => x.id)).toEqual([i.id]);
  });
});

describe('approval risk (payload.risk from the daemon)', () => {
  const r = run(session());
  it('shows the daemon rating and requires Ctrl+Y only for high', () => {
    const medium = describeApproval(
      approval(r, {
        payload: { toolName: 'Bash', input: { command: 'pnpm test' }, risk: 'medium' },
      }),
    );
    expect(medium).toMatchObject({ riskLevel: 'medium', risk: 'normal', target: 'pnpm test' });
    const high = describeApproval(
      approval(r, { payload: { toolName: 'Bash', input: { command: 'pnpm test' }, risk: 'high' } }),
    );
    expect(high).toMatchObject({ riskLevel: 'high', risk: 'high' });
    // Without a rating the client heuristics still catch obvious danger.
    const push = describeApproval(
      approval(r, { payload: { toolName: 'Bash', input: { command: 'git push origin main' } } }),
    );
    expect(push).toMatchObject({ riskLevel: null, risk: 'high' });
  });
});
