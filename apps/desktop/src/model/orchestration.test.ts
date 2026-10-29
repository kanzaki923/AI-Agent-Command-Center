// @vitest-environment node
import type { CapabilityGrant, Integration, IntegrationStep } from '@acc/protocol';
import { describe, expect, it } from 'vitest';
import { T0, approval, id, integration, iso, run, session, task } from '../test/fixtures';
import { describeApproval } from './approval';
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
import {
  applyPlan,
  canApprove,
  canReject,
  canResolveWithAgent,
  integrationSummary,
  isResolving,
  resolutionFailed,
  resolvePlan,
} from './integration';

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
    const conflict: Integration = {
      ...base,
      status: 'conflict',
      steps: [step({ status: 'failed', conflictFiles: ['a.ts', 'b.ts'], title: '「A」をマージ' })],
    };
    expect(integrationSummary(conflict)).toBe('コンフリクト 2 ファイル · 「A」をマージ');
    expect(canResolveWithAgent(conflict)).toBe(true);
    expect(canResolveWithAgent({ ...conflict, status: 'failed' })).toBe(false);
    // A conflict without the record of its merge cannot be handed over.
    expect(canResolveWithAgent({ ...conflict, steps: [] })).toBe(false);
  });

  it('follows an Integrator resolution: running, resolved (no longer a conflict), failed', () => {
    const merge = step({ status: 'failed', conflictFiles: ['README.md'], title: '「B」をマージ', branch: 'acc/b' });
    const fixStepOf = (status: IntegrationStep['status']) =>
      step({ index: 1, kind: 'fix', status, title: 'Integrator がコンフリクトを解消（README.md）', conflictFiles: ['README.md'] });
    const resolving: Integration = { ...base, status: 'running', steps: [merge, fixStepOf('running')] };
    expect(isResolving(resolving)).toBe(true);
    expect(integrationSummary(resolving)).toBe('Integrator がコンフリクトを解消中');
    const resolved: Integration = {
      ...base,
      status: 'awaiting_approval',
      // The merge keeps conflictFiles as the record of where it conflicted.
      steps: [{ ...merge, status: 'succeeded' }, fixStepOf('succeeded')],
    };
    expect(isResolving(resolved)).toBe(false);
    expect(integrationSummary(resolved)).toBe('2/2 ステップ');
    const failed: Integration = { ...base, status: 'conflict', steps: [merge, fixStepOf('failed')] };
    expect(resolutionFailed(failed)).toBe(true);
    expect(canResolveWithAgent(failed)).toBe(true);
    const plan = resolvePlan({ ...failed, branch: 'acc/integration-1', targetRef: 'main' });
    expect(plan.lines.join('\n')).toContain('「B」をマージするときに README.md がコンフリクトしました。');
    expect(plan.lines.join('\n')).toContain('main はまだ変更しません');
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
