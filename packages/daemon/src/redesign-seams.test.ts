/**
 * T0 seams (spec 20261029 §5.2): placeholders the tracks replace, and the call sites Core
 * created for them (usage → ledger, deltas → streams, mock steps → handlers).
 */
import { METHOD_NAMES, api } from '@acc/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MethodRegistry, defineMethod, stubMethod } from './api/registry';
import { type ApiError } from './core/errors';
import { deriveSessionState, type StateFacts } from './home';
import { apiTools } from './llm/tools';
import { MockStep } from './runtime/mock/plan';
import { STEP_HANDLERS } from './runtime/mock/steps';
import { HUMAN, type TestDaemonNoServer, agentActor, createTestDaemon } from './testing';

let d: TestDaemonNoServer;
afterEach(async () => {
  await d?.cleanup();
});

/** Methods of the redesign the Core track ships as placeholders. */
const STUBS = [
  'session.stop',
  'session.resume',
  'session.delegate',
  'session.undelegate',
  'session.setBudget',
  'session.tree',
  'artifact.publish',
  'artifact.read',
  'artifact.review',
  'cost.summary',
  'budget.raise',
  'schedule.create',
  'schedule.list',
  'schedule.get',
  'schedule.update',
  'schedule.delete',
  'schedule.runNow',
  'schedule.preview',
  'home.get',
] as const;

describe('contract placeholders', () => {
  it('every method of the contract is registered (implemented or a stub)', async () => {
    d = await createTestDaemon();
    expect(METHOD_NAMES.filter((m) => !d.ctx.methods.get(m))).toEqual([]);
  });

  it('each stub answers not_implemented and counts as not implemented', async () => {
    d = await createTestDaemon();
    for (const name of STUBS) {
      const impl = d.ctx.methods.get(name)!;
      expect(impl.stub, name).toBe(true);
      const call = {
        actor: HUMAN,
        ctx: d.ctx,
        connection: null,
        signal: new AbortController().signal,
      };
      expect(() => impl.handler({}, call)).toThrow(
        expect.objectContaining({ code: 'not_found', data: { reason: 'not_implemented' } }),
      );
      expect(d.ctx.methods.has(name)).toBe(false);
      expect(d.ctx.methods.names()).not.toContain(name);
    }
  });

  it('a stub with valid params says not_implemented', async () => {
    d = await createTestDaemon();
    const err = (await d.call(HUMAN, 'home.get', {}).catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ code: 'not_found', data: { reason: 'not_implemented' } });
    const info = await d.call(HUMAN, 'system.info', {});
    expect(info.methods).not.toContain('home.get');
    expect(info.methods).toContain('session.send');
  });

  it('stubs are never offered to an LLM, even under a "*" grant', async () => {
    d = await createTestDaemon();
    const s = await d.call(HUMAN, 'session.create', {});
    d.ctx
      .service('policy')
      .createGrant(
        { subject: { kind: 'session', sessionId: s.id }, permissions: ['*'], lifetime: 'session' },
        HUMAN,
      );
    const tools = apiTools(d.ctx, agentActor(s.id, d.ctx.ids.next('run'))).map((t) => t.method);
    expect(tools).toContain('session.get');
    for (const stub of STUBS) expect(tools).not.toContain(stub);
  });

  it('a real implementation replaces a stub, whichever registers first', () => {
    const reg = new MethodRegistry();
    reg.register(stubMethod('home.get'));
    const real = defineMethod('home.get', { handler: () => ({}) as never });
    reg.register(real);
    expect(reg.get('home.get')).toBe(real);
    reg.register(stubMethod('home.get'));
    expect(reg.get('home.get')).toBe(real);
    expect(() => reg.register(defineMethod('home.get', { handler: () => ({}) as never }))).toThrow(
      /already registered/,
    );
  });

  it('every service of the redesign is provided', async () => {
    d = await createTestDaemon();
    for (const name of [
      'inbox',
      'spawner',
      'outputs',
      'attention',
      'ledger',
      'scheduler',
      'sessionState',
      'streams',
    ] as const) {
      expect(d.ctx.hasService(name), name).toBe(true);
    }
    // T2 implemented the spawner: a human can start a child without a parent.
    const spawned = await d.ctx
      .service('spawner')
      .spawn(api['session.spawn'].params.parse({ title: 't', goal: 'g', start: false }), HUMAN);
    expect(spawned.session).toMatchObject({ title: 't', brief: { goal: 'g' } });
  });
});

describe('call sites for the tracks', () => {
  it('usage recorded on a run goes to the ledger, deltas to streams, in the run', async () => {
    d = await createTestDaemon();
    d.ctx.service('llm').mock.chunkDelayMs = 0;
    const record = vi.spyOn(d.ctx.service('ledger'), 'record');
    const append = vi.spyOn(d.ctx.service('streams'), 'append');
    const s = await d.call(HUMAN, 'session.create', { model: 'mock/echo' });
    const sent = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: 'こんにちは' });
    expect(sent).toMatchObject({ delivery: 'started' });
    const run = await d.ctx.service('runs').waitForEnd(sent.runId!);
    expect(run).toMatchObject({ status: 'completed', trigger: 'user' });
    expect(record).toHaveBeenCalled();
    expect(record.mock.calls[0]![0]).toMatchObject({
      sessionId: s.id,
      runId: run.id,
      component: 'llm',
      model: 'mock/echo',
    });
    expect(append).toHaveBeenCalled();
    expect(append.mock.calls.every(([runId, , kind]) => runId === run.id && kind === 'text')).toBe(
      true,
    );
    const page = await d.call(HUMAN, 'session.messages', { sessionId: s.id });
    expect(page.streaming).toBeNull();
  });

  it('the mock runtime has a handler for every plan step type', () => {
    const types = MockStep.options.map((o) => o.shape.type.value).sort();
    expect(Object.keys(STEP_HANDLERS).sort()).toEqual(types);
  });

  it('projects keep an optional folder (no git needed)', async () => {
    d = await createTestDaemon();
    const p = await d.call(HUMAN, 'project.create', { name: '資料', folderPath: d.home });
    expect(p).toMatchObject({ repoPath: null, folderPath: d.home });
    const u = await d.call(HUMAN, 'project.update', { projectId: p.id, folderPath: null });
    expect(u.folderPath).toBeNull();
    await expect(
      d.call(HUMAN, 'project.create', { name: 'x', folderPath: 'relative/path' }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('session.list walks the tree (rootsOnly / parentSessionId)', async () => {
    d = await createTestDaemon();
    const root = await d.call(HUMAN, 'session.create', { title: 'root' });
    const child = await d.call(HUMAN, 'session.create', { parentSessionId: root.id });
    const roots = await d.call(HUMAN, 'session.list', { rootsOnly: true });
    expect(roots.items.map((x) => x.id)).toEqual([root.id]);
    const kids = await d.call(HUMAN, 'session.list', { parentSessionId: root.id });
    expect(kids.items.map((x) => x.id)).toEqual([child.id]);
    expect(child).toMatchObject({ rootSessionId: root.id, state: 'idle', supervision: 'active' });
  });
});

describe('deriveSessionState (§3.7, first match wins)', () => {
  const base: StateFacts = {
    kind: 'agent',
    openAttention: [],
    lastRunStatus: null,
    taskStatus: null,
    descendantBusy: false,
    hasChildren: false,
    supervision: 'active',
  };
  it.each<[Partial<StateFacts>, string]>([
    [{ openAttention: ['question', 'failure'], lastRunStatus: 'running' }, 'needs_you'],
    [{ openAttention: ['failure'], lastRunStatus: 'running' }, 'failed'],
    [{ lastRunStatus: 'awaiting_approval' }, 'working'],
    [{ lastRunStatus: 'completed', descendantBusy: true, hasChildren: true }, 'supervising'],
    [{ lastRunStatus: 'queued', descendantBusy: true }, 'queued'],
    [{ taskStatus: 'ready' }, 'queued'],
    [{ taskStatus: 'review' }, 'review'],
    [{ openAttention: ['review'] }, 'review'],
    [{ taskStatus: 'paused' }, 'stopped'],
    [{ supervision: 'paused', kind: 'chat' }, 'stopped'],
    [{ taskStatus: 'done' }, 'done'],
    [{ lastRunStatus: 'completed' }, 'done'],
    [{ lastRunStatus: 'completed', kind: 'chat' }, 'idle'],
    [{ lastRunStatus: 'completed', hasChildren: true }, 'idle'],
    [{}, 'idle'],
  ])('%o → %s', (facts, state) => {
    expect(deriveSessionState({ ...base, ...facts })).toBe(state);
  });
});
