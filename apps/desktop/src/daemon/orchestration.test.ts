import { AccClientError } from '@acc/client';
import type { CapabilityGrant, Integration, Project, Session, Task } from '@acc/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_MESSAGE, parseDemoResult, pickDemoModel, startDemo } from '../app/demo';
import { DEFAULT_GRANT_INPUT } from '../model/grant';
import { useToasts } from '../store/toast';
import { useUi } from '../store/ui';
import { createFakeClient } from '../test/fakeClient';
import { T0, integration, iso, session, task } from '../test/fixtures';
import { qk } from './keys';
import {
  approveIntegration,
  createProject,
  grantOrchestrator,
  pickMethod,
  rejectIntegration,
  revokeGrant,
  spawnWorker,
} from './orchestration';
import { createRuntime } from './runtime';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const grantFrom = (p: Record<string, unknown>): CapabilityGrant => ({
  id: 'grt_00000000000000000000000001',
  subject: p.subject as CapabilityGrant['subject'],
  parentGrantId: null,
  permissions: p.permissions as string[],
  scope: (p.scope as CapabilityGrant['scope']) ?? {},
  limits: (p.limits as CapabilityGrant['limits']) ?? {},
  depth: 0,
  lifetime: (p.lifetime as CapabilityGrant['lifetime']) ?? 'run',
  expiresAt: (p.expiresAt as string | undefined) ?? null,
  revokedAt: null,
  reason: null,
  grantedBy: { kind: 'human', client: 'desktop' },
  createdAt: iso(T0),
});

beforeEach(() => {
  useToasts.setState({ toasts: [] });
  useUi.setState({
    suggestions: {},
    onboardingDone: false,
    projectId: null,
    focusSessionId: null,
    mode: 'command',
  });
});

describe('grantOrchestrator', () => {
  it('shows the grant at once, then swaps in the real one and creates the budget pool', async () => {
    const gate = deferred<CapabilityGrant>();
    const calls: string[] = [];
    const fake = createFakeClient({
      'grant.create': (p) => {
        calls.push('grant.create');
        return gate.promise.then(() => grantFrom(p));
      },
      'budget.allocate': (p) => {
        calls.push('budget.allocate');
        expect(p).toMatchObject({
          parentId: null,
          subject: { kind: 'session', id: 'ses_1' },
          limitUsd: 5,
        });
        return {
          id: 'bud_1',
          status: 'active',
          limitUsd: 5,
          allocatedUsd: 0,
          reservedUsd: 0,
          spentUsd: 0,
          createdAt: iso(T0),
        };
      },
    });
    const rt = createRuntime(fake.client);
    const p = grantOrchestrator(rt, {
      ...DEFAULT_GRANT_INPUT,
      sessionId: 'ses_1',
      projectId: 'prj_1',
    });
    // Optimistic: visible before the daemon answers.
    const before = rt.queryClient.getQueryData<CapabilityGrant[]>(qk.grants('ses_1'))!;
    expect(before).toHaveLength(1);
    expect(before[0]!.id).toMatch(/^local_grant_/);
    gate.resolve(undefined as never);
    const real = await p;
    expect(real?.id).toBe('grt_00000000000000000000000001');
    expect(
      rt.queryClient.getQueryData<CapabilityGrant[]>(qk.grants('ses_1'))!.map((g) => g.id),
    ).toEqual([real!.id]);
    expect(calls).toEqual(['grant.create', 'budget.allocate']);
    rt.dispose();
  });

  it('rolls back and explains when the daemon refuses', async () => {
    const fake = createFakeClient({
      'grant.create': () => {
        throw new AccClientError('forbidden', 'nope', { permission: 'grant.create' });
      },
    });
    const rt = createRuntime(fake.client);
    expect(
      await grantOrchestrator(rt, { ...DEFAULT_GRANT_INPUT, sessionId: 'ses_1', projectId: null }),
    ).toBeNull();
    expect(rt.queryClient.getQueryData<CapabilityGrant[]>(qk.grants('ses_1'))).toEqual([]);
    expect(useToasts.getState().toasts[0]?.title).toContain('権限を付与できませんでした');
    rt.dispose();
  });

  it('uses a daemon convenience method when system.info lists one', async () => {
    const fake = createFakeClient({
      'session.grantOrchestration': (p) => ({
        budget: null,
        grant: grantFrom({
          ...p,
          subject: { kind: 'session', sessionId: p.sessionId },
          permissions: ['task.*'],
        }),
      }),
    });
    const rt = createRuntime(fake.client);
    const g = await grantOrchestrator(
      rt,
      { ...DEFAULT_GRANT_INPUT, sessionId: 'ses_2', projectId: 'prj_1' },
      new Set(['session.grantOrchestration']),
    );
    expect(g?.subject).toEqual({ kind: 'session', sessionId: 'ses_2' });
    expect(fake.calls.map((c) => c.method)).toEqual(['session.grantOrchestration']);
    expect(pickMethod(null, ['x'])).toBeNull();
    rt.dispose();
  });

  it('revokes optimistically and restores on failure', async () => {
    const fake = createFakeClient({
      'grant.revoke': () => {
        throw new AccClientError('not_found', 'gone');
      },
    });
    const rt = createRuntime(fake.client);
    const g = grantFrom({
      subject: { kind: 'session', sessionId: 'ses_1' },
      permissions: ['task.*'],
    });
    rt.queryClient.setQueryData(qk.grants('ses_1'), [g]);
    const p = revokeGrant(rt, 'ses_1', g);
    expect(
      rt.queryClient.getQueryData<CapabilityGrant[]>(qk.grants('ses_1'))![0]!.revokedAt,
    ).not.toBeNull();
    expect(await p).toBe(false);
    expect(
      rt.queryClient.getQueryData<CapabilityGrant[]>(qk.grants('ses_1'))![0]!.revokedAt,
    ).toBeNull();
    rt.dispose();
  });
});

describe('createProject', () => {
  const project = (over: Partial<Project> = {}): Project => ({
    id: 'prj_00000000000000000000000001',
    name: 'repo',
    description: null,
    repoPath: 'C:\\work\\repo',
    defaultBranch: null,
    defaultModel: null,
    testCommand: null,
    commitAuthor: null,
    createdAt: iso(T0),
    updatedAt: iso(T0),
    archivedAt: null,
    ...over,
  });

  it('validates the repository and adopts the checked-out branch', async () => {
    const fake = createFakeClient({
      'project.create': () => project(),
      'workspace.create': (p) => {
        expect(p).toEqual({ projectId: 'prj_00000000000000000000000001', kind: 'main' });
        return { id: 'wsp_1', branch: 'develop' };
      },
      'project.update': (p) => project({ defaultBranch: p.defaultBranch as string }),
    });
    const rt = createRuntime(fake.client);
    rt.queryClient.setQueryData(qk.projects, []);
    const r = await createProject(rt, { repoPath: 'C:\\work\\repo', name: 'repo' });
    expect(r).toMatchObject({
      ok: true,
      detectedBranch: 'develop',
      project: { defaultBranch: 'develop' },
    });
    expect(rt.queryClient.getQueryData<Project[]>(qk.projects)).toHaveLength(1);
    rt.dispose();
  });

  it('archives the project again when the folder is not a git repository', async () => {
    const updates: unknown[] = [];
    const fake = createFakeClient({
      'project.create': () => project(),
      'workspace.create': () => {
        throw new AccClientError('invalid_params', 'git リポジトリではありません: C:\\x');
      },
      'project.update': (p) => {
        updates.push(p);
        return project({ archivedAt: iso(T0) });
      },
    });
    const rt = createRuntime(fake.client);
    const r = await createProject(rt, { repoPath: 'C:\\x', name: 'x' });
    expect(r).toEqual({
      ok: false,
      error: 'git リポジトリではありません。リポジトリのルートフォルダを選んでください',
    });
    expect(updates).toEqual([{ projectId: 'prj_00000000000000000000000001', archived: true }]);
    rt.dispose();
  });

  it('turns path errors into one helpful sentence', async () => {
    const fake = createFakeClient({
      'project.create': () => {
        throw new AccClientError('invalid_params', 'repoPath must be an absolute path: repo');
      },
    });
    const rt = createRuntime(fake.client);
    expect(await createProject(rt, { repoPath: 'repo', name: 'repo' })).toEqual({
      ok: false,
      error: '絶対パスで指定してください（例: C:\\work\\my-repo）',
    });
    rt.dispose();
  });
});

describe('spawnWorker', () => {
  it('marks the task running at once and falls back gracefully while not implemented', async () => {
    const fake = createFakeClient({});
    const rt = createRuntime(fake.client);
    const t = task({ status: 'ready' });
    rt.queryClient.setQueryData<Task[]>(qk.tasks, [t]);
    const p = spawnWorker(rt, t);
    expect(rt.queryClient.getQueryData<Task[]>(qk.tasks)![0]!.status).toBe('running');
    expect(await p).toBeNull();
    expect(rt.queryClient.getQueryData<Task[]>(qk.tasks)![0]!.status).toBe('ready');
    expect(rt.unimplemented.getState().methods).toContain('task.spawnWorker');
    expect(useToasts.getState().toasts[0]?.tone).toBe('info');
    rt.dispose();
  });

  it('returns the worker session', async () => {
    const fake = createFakeClient({
      'task.spawnWorker': () => ({ sessionId: 'ses_w', runId: 'run_w', workspaceId: 'wsp_w' }),
    });
    const rt = createRuntime(fake.client);
    expect(await spawnWorker(rt, task({ status: 'ready' }))).toEqual({ sessionId: 'ses_w' });
    rt.dispose();
  });
});

describe('integration decisions', () => {
  const ready = (): Integration =>
    integration({
      status: 'awaiting_approval',
      targetRef: 'main',
      steps: [
        {
          index: 0,
          kind: 'apply',
          status: 'pending',
          title: '「main」へ反映（要承認）',
          taskId: null,
          artifactId: null,
          detail: null,
          startedAt: null,
          endedAt: null,
          workspaceId: null,
          branch: null,
          conflictFiles: [],
        },
      ],
    });

  it('applies optimistically and rolls back when the target moved on', async () => {
    const i = ready();
    const gate = deferred<Integration>();
    const fake = createFakeClient({ 'integration.approve': () => gate.promise });
    const rt = createRuntime(fake.client);
    rt.queryClient.setQueryData<Integration[]>(qk.integrations, [i]);
    const p = approveIntegration(rt, i, 'LGTM');
    const now = rt.queryClient.getQueryData<Integration[]>(qk.integrations)![0]!;
    expect(now.status).toBe('applied');
    expect(now.steps[0]!.status).toBe('succeeded');
    gate.reject(
      new AccClientError(
        'conflict',
        '反映先ブランチ「main」が統合の開始後に進んでいるため、早送りで反映できません',
      ),
    );
    expect(await p).toBe(false);
    expect(rt.queryClient.getQueryData<Integration[]>(qk.integrations)![0]!.status).toBe(
      'awaiting_approval',
    );
    expect(useToasts.getState().toasts[0]?.title).toContain('反映できませんでした');
    expect(fake.calls[0]).toEqual({
      method: 'integration.approve',
      params: { integrationId: i.id, note: 'LGTM' },
    });
    rt.dispose();
  });

  it('rejects with the reason', async () => {
    const i = ready();
    const fake = createFakeClient({ 'integration.reject': () => ({ ...i, status: 'rejected' }) });
    const rt = createRuntime(fake.client);
    rt.queryClient.setQueryData<Integration[]>(qk.integrations, [i]);
    expect(await rejectIntegration(rt, i, 'テストが足りない')).toBe(true);
    expect(rt.queryClient.getQueryData<Integration[]>(qk.integrations)![0]!.status).toBe(
      'rejected',
    );
    expect(fake.calls[0]!.params).toEqual({ integrationId: i.id, note: 'テストが足りない' });
    rt.dispose();
  });
});

describe('demo', () => {
  it('reads ids from any demo setup result shape', () => {
    expect(
      parseDemoResult({ session: { id: 'ses_1' }, project: { id: 'prj_1' }, grant: { id: 'g' } }),
    ).toEqual({ sessionId: 'ses_1', projectId: 'prj_1', message: null, granted: true });
    expect(parseDemoResult({ sessionId: 'ses_2', suggestedMessage: 'やって' })).toMatchObject({
      sessionId: 'ses_2',
      message: 'やって',
      granted: false,
    });
    expect(parseDemoResult(null)).toEqual({
      sessionId: null,
      projectId: null,
      message: null,
      granted: false,
    });
    expect(
      pickDemoModel([
        { id: 'mock/echo', label: null, provider: null },
        { id: 'mock/orchestrator', label: null, provider: null },
      ]),
    ).toBe('mock/orchestrator');
    expect(pickDemoModel([{ id: 'gpt-x', label: null, provider: null }])).toBeNull();
  });

  it('falls back to a client-side design chat with the grant and the suggested message', async () => {
    const created: Session[] = [];
    const fake = createFakeClient({
      'project.list': () => ({ items: [] }),
      'models.list': () => ({
        models: [{ id: 'mock/echo', label: null, provider: null }],
        source: 'mock',
      }),
      'session.create': (p) => {
        const s = session({ kind: 'chat', title: p.title as string, model: p.model as string });
        created.push(s);
        return s;
      },
      'grant.list': () => ({ items: [] }),
      'grant.create': (p) => grantFrom(p),
      'budget.allocate': () => ({
        id: 'bud_1',
        status: 'active',
        limitUsd: 5,
        allocatedUsd: 0,
        reservedUsd: 0,
        spentUsd: 0,
        createdAt: iso(T0),
      }),
    });
    const rt = createRuntime(fake.client);
    rt.queryClient.setQueryData<Session[]>(qk.sessions, []);
    await startDemo(rt, new Set(['session.create']));
    const s = created[0]!;
    expect(s).toMatchObject({ title: '設計チャット', model: 'mock/echo' });
    const ui = useUi.getState();
    expect(ui.focusSessionId).toBe(s.id);
    expect(ui.mode).toBe('focus');
    expect(ui.onboardingDone).toBe(true);
    expect(ui.suggestions[s.id]).toBe(DEMO_MESSAGE);
    const grantCall = fake.calls.find((c) => c.method === 'grant.create')!;
    expect(grantCall.params).toMatchObject({
      subject: { kind: 'session', sessionId: s.id },
      lifetime: 'session',
      limits: { maxWorkers: 2 },
    });
    rt.dispose();
  });

  it('uses the daemon demo setup when offered and keeps an existing grant', async () => {
    const fake = createFakeClient({
      'system.setupDemo': () => ({ sessionId: 'ses_demo', projectId: 'prj_demo' }),
      'session.list': () => ({ items: [session({ id: 'ses_demo' })], nextCursor: null }),
      'project.list': () => ({ items: [] }),
      'grant.list': () => ({
        items: [
          grantFrom({
            subject: { kind: 'session', sessionId: 'ses_demo' },
            permissions: ['task.*'],
          }),
        ],
      }),
    });
    const rt = createRuntime(fake.client);
    await startDemo(rt, new Set(['system.setupDemo']));
    expect(fake.calls.some((c) => c.method === 'grant.create')).toBe(false);
    expect(useUi.getState()).toMatchObject({ focusSessionId: 'ses_demo', projectId: 'prj_demo' });
    expect(useUi.getState().suggestions.ses_demo).toBe(DEMO_MESSAGE);
    rt.dispose();
  });

  it('probes system.setupDemo by calling it before system.info is known, and trusts its grant', async () => {
    const fake = createFakeClient({
      'system.setupDemo': () => ({
        project: { id: 'prj_d' },
        session: { id: 'ses_d' },
        grant: { id: 'grt_d' },
        repoPath: 'x',
        created: true,
      }),
      'session.list': () => ({ items: [session({ id: 'ses_d' })], nextCursor: null }),
      'project.list': () => ({ items: [] }),
    });
    const rt = createRuntime(fake.client);
    await startDemo(rt, null);
    const methods = fake.calls.map((c) => c.method);
    expect(methods[0]).toBe('system.setupDemo');
    expect(methods).not.toContain('grant.create');
    expect(methods).not.toContain('session.create');
    expect(useUi.getState()).toMatchObject({ focusSessionId: 'ses_d', projectId: 'prj_d', onboardingDone: true });
    rt.dispose();
  });
});
