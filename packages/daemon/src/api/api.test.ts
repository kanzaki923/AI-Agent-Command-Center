import type { CapabilityGrant } from '@acc/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../core/errors';
import { defineModule } from '../module';
import { modules } from '../modules';
import { HUMAN, SYSTEM, type TestDaemonNoServer, agentActor, createTestDaemon } from '../testing';
import { grantAllows } from './policy';
import { defineMethod } from './registry';

let d: TestDaemonNoServer;
afterEach(async () => {
  await d?.cleanup();
});

async function expectCode(p: Promise<unknown>, code: string): Promise<ApiError> {
  const err = await p.then(
    () => {
      throw new Error(`expected ${code}, got success`);
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe(code);
  return err as ApiError;
}

function insertGrant(daemon: TestDaemonNoServer, patch: Partial<CapabilityGrant>): CapabilityGrant {
  const { ctx } = daemon;
  return ctx.repos.grants.insert({
    id: ctx.ids.next('grant'),
    subject: { kind: 'run', runId: ctx.ids.next('run') },
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
    createdAt: ctx.clock.iso(),
    ...patch,
  });
}

describe('dispatcher', () => {
  it('rejects unknown and unimplemented methods with not_found', async () => {
    d = await createTestDaemon();
    const e1 = await expectCode(d.call(HUMAN, 'nope.nope' as never, {} as never), 'not_found');
    expect(e1.data).toEqual({ reason: 'unknown_method' });
    const e2 = await expectCode(d.call(HUMAN, 'task.list', {}), 'not_found');
    expect(e2.data).toEqual({ reason: 'not_implemented' });
  });

  it('validates params (types, unknown keys, id prefixes)', async () => {
    d = await createTestDaemon();
    await expectCode(d.call(HUMAN, 'project.create', { name: '' }), 'invalid_params');
    await expectCode(
      d.call(HUMAN, 'project.create', { name: 'x', bogus: true } as never),
      'invalid_params',
    );
    const err = await expectCode(
      d.call(HUMAN, 'session.get', { sessionId: 'run_00000000000000000000000000' }),
      'invalid_params',
    );
    expect(err.message).toContain('session id');
  });

  it('validates results and turns contract violations into internal errors', async () => {
    const broken = defineModule({
      name: 'broken',
      register(ctx) {
        ctx.methods.register(defineMethod('run.get', { handler: () => ({ nope: true }) as never }));
      },
    });
    d = await createTestDaemon({ modules: [...modules, broken] });
    const runId = d.ctx.ids.next('run');
    await expectCode(d.call(HUMAN, 'run.get', { runId }), 'internal');
  });

  it('refuses to register methods twice or methods not in the contract', async () => {
    d = await createTestDaemon();
    expect(() =>
      d.ctx.methods.register(defineMethod('system.health', { handler: () => ({}) as never })),
    ).toThrow(/already registered/);
    expect(() => d.ctx.methods.register({ name: 'x.y', handler: () => ({}) } as never)).toThrow(
      /not declared/,
    );
  });
});

describe('policy', () => {
  it('allows human and system actors', async () => {
    d = await createTestDaemon();
    await expect(d.call(HUMAN, 'system.health', {})).resolves.toMatchObject({ ok: true });
    await expect(d.call(SYSTEM, 'project.list', {})).resolves.toEqual({ items: [] });
  });

  it('denies agents without a grant', async () => {
    d = await createTestDaemon();
    const actor = agentActor(d.ctx.ids.next('session'), d.ctx.ids.next('run'));
    const err = await expectCode(d.call(actor, 'project.list', {}), 'forbidden');
    expect(err.message).toMatch(/no capability grant/);
  });

  it('allows agents with a matching grant and enforces permission patterns', async () => {
    d = await createTestDaemon();
    const runId = d.ctx.ids.next('run');
    const actor = agentActor(d.ctx.ids.next('session'), runId);
    insertGrant(d, { subject: { kind: 'run', runId }, permissions: ['project.*'] });
    const project = await d.call(actor, 'project.create', { name: 'by agent' });
    expect(project.name).toBe('by agent');
    await expectCode(d.call(actor, 'settings.get', {}), 'forbidden');
  });

  it('applies session-lifetime grants to every run of the session', async () => {
    d = await createTestDaemon();
    const sessionId = d.ctx.ids.next('session');
    insertGrant(d, {
      subject: { kind: 'session', sessionId },
      lifetime: 'session',
      permissions: ['system.*'],
    });
    const actor = agentActor(sessionId, d.ctx.ids.next('run'));
    await expect(d.call(actor, 'system.health', {})).resolves.toMatchObject({ ok: true });
  });

  it('ignores revoked and expired grants', async () => {
    d = await createTestDaemon();
    const runId = d.ctx.ids.next('run');
    const actor = agentActor(d.ctx.ids.next('session'), runId);
    insertGrant(d, { subject: { kind: 'run', runId }, revokedAt: d.ctx.clock.iso() });
    insertGrant(d, { subject: { kind: 'run', runId }, expiresAt: '2000-01-01T00:00:00.000Z' });
    await expectCode(d.call(actor, 'system.health', {}), 'forbidden');
  });

  it('enforces project scope', async () => {
    d = await createTestDaemon();
    const a = await d.call(HUMAN, 'project.create', { name: 'A' });
    const b = await d.call(HUMAN, 'project.create', { name: 'B' });
    const runId = d.ctx.ids.next('run');
    const actor = agentActor(d.ctx.ids.next('session'), runId);
    insertGrant(d, { subject: { kind: 'run', runId }, scope: { projectIds: [a.id] } });

    await expect(d.call(actor, 'project.get', { projectId: a.id })).resolves.toMatchObject({
      id: a.id,
    });
    const err = await expectCode(d.call(actor, 'project.get', { projectId: b.id }), 'forbidden');
    expect(err.message).toMatch(/outside grant scope/);
    // Unnarrowed cross-project listing is denied for project-restricted grants...
    await expectCode(d.call(actor, 'session.list', {}), 'forbidden');
    // ...but allowed when narrowed to an allowed project.
    await expect(d.call(actor, 'session.list', { projectId: a.id })).resolves.toMatchObject({
      items: [],
    });
    // Global methods have no project scope.
    await expect(d.call(actor, 'system.health', {})).resolves.toMatchObject({ ok: true });
  });

  it('grantAllows pure checks', () => {
    const grant = {
      revokedAt: null,
      expiresAt: '2030-01-01T00:00:00.000Z',
      permissions: ['task.*', 'session.get'],
      scope: { projectIds: ['p1'] },
    } as unknown as CapabilityGrant;
    const now = '2029-01-01T00:00:00.000Z';
    expect(grantAllows(grant, 'task.create', { projectIds: ['p1'] }, now).ok).toBe(true);
    expect(grantAllows(grant, 'session.list', { projectIds: ['p1'] }, now).ok).toBe(false);
    expect(grantAllows(grant, 'task.create', { projectIds: ['p2'] }, now).ok).toBe(false);
    expect(grantAllows(grant, 'task.create', undefined, now).ok).toBe(true);
    expect(
      grantAllows(grant, 'task.create', { projectIds: ['p1'] }, '2031-01-01T00:00:00.000Z').ok,
    ).toBe(false);
  });
});
