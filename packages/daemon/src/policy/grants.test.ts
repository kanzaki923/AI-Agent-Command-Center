import { type CapabilityGrant, type Event, matchPattern } from '@acc/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createManualClock } from '../core/clock';
import { ApiError } from '../core/errors';
import { HUMAN, type TestDaemonNoServer, createTestDaemon } from '../testing';
import { patternContains } from './patterns';
import { actorOf, insertRun, setRunStatus } from './testutil';

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

function events<T extends Event['type']>(type: T) {
  return d.ctx.bus.list({ types: [type] }).events as Extract<Event, { type: T }>[];
}

/** A session with one running run and its agent actor. */
async function agentRun(opts: { parentRunId?: string; projectId?: string } = {}) {
  const session = await d.call(HUMAN, 'session.create', {
    kind: 'agent',
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
  });
  const run = insertRun(d.ctx, {
    sessionId: session.id,
    parentRunId: opts.parentRunId ?? null,
    projectId: opts.projectId ?? null,
  });
  return { session, run, actor: actorOf(run) };
}

describe('patternContains', () => {
  it.each([
    ['*', '*', true],
    ['*', 'task.create', true],
    ['*', 'task.*', true],
    ['task.*', '*', false],
    ['task.*', 'task.create', true],
    ['task.*', 'task.*', true],
    ['task.*', 'task.a.b', true],
    ['task.*', 'task', false],
    ['task.*', 'taskx.create', false],
    ['task.*', '*.create', false],
    ['task.create', 'task.create', true],
    ['task.create', 'task.*', false],
    ['task.create', 'task.list', false],
    ['*.list', 'task.list', true],
    ['*.list', '*.list', true],
    ['*.list', 'task.*', false],
    ['*.*', 'task.*', true],
    ['*.*', 'task', false],
    ['*.*', '*', false],
    ['task.*.x', 'task.a.x', true],
    ['task.*.x', 'task.a.*', false],
    ['a.*.*', 'a.b.*', true],
    ['a.*.*', 'a.*', false],
    ['session', 'session', true],
    ['session', 'session.get', false],
  ])('%s ⊇ %s -> %s', (parent, child, expected) => {
    expect(patternContains(parent, child)).toBe(expected);
  });

  it('agrees with matchPattern on every name of a small universe', () => {
    const segs = ['a', 'b', '*'];
    const patterns = new Set<string>(['*']);
    for (const x of segs) {
      if (x !== '*') patterns.add(x);
      for (const y of segs) {
        patterns.add(`${x}.${y}`);
        for (const z of segs) patterns.add(`${x}.${y}.${z}`);
      }
    }
    const names: string[] = [];
    const real = ['a', 'b', 'c'];
    for (const x of real) {
      names.push(x);
      for (const y of real) {
        names.push(`${x}.${y}`);
        for (const z of real) {
          names.push(`${x}.${y}.${z}`);
          for (const w of real) names.push(`${x}.${y}.${z}.${w}`);
        }
      }
    }
    for (const p of patterns) {
      for (const c of patterns) {
        // Over this universe (names up to 4 segments, alphabet incl. an unused letter),
        // containment must equal "every name c matches, p matches too".
        const semantic = names.every((n) => !matchPattern(c, n) || matchPattern(p, n));
        expect([p, c, patternContains(p, c)]).toEqual([p, c, semantic]);
      }
    }
  });
});

describe('grant.create', () => {
  it('humans create root grants (depth 0) and the event carries run refs', async () => {
    d = await createTestDaemon();
    const { run } = await agentRun();
    const g = await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'run', runId: run.id },
      permissions: ['task.*', 'task.*'],
      reason: 'orchestrate',
    });
    expect(g).toMatchObject({ depth: 0, parentGrantId: null, permissions: ['task.*'] });
    const ev = events('grant.created');
    expect(ev).toHaveLength(1);
    expect(ev[0]!).toMatchObject({ runId: run.id, sessionId: run.sessionId });
  });

  it('validates the subject and expiry', async () => {
    d = await createTestDaemon();
    await expectCode(
      d.call(HUMAN, 'grant.create', {
        subject: { kind: 'session', sessionId: d.ctx.ids.next('session') },
        permissions: ['*'],
      }),
      'not_found',
    );
    const { run } = await agentRun();
    await expectCode(
      d.call(HUMAN, 'grant.create', {
        subject: { kind: 'run', runId: run.id },
        permissions: ['*'],
        expiresAt: '2000-01-01T00:00:00.000Z',
      }),
      'invalid_params',
    );
    setRunStatus(d.ctx, run.id, 'completed');
    await expectCode(
      d.call(HUMAN, 'grant.create', {
        subject: { kind: 'run', runId: run.id },
        permissions: ['*'],
      }),
      'conflict',
    );
  });

  it('agents without a grant are denied and the denial is recorded', async () => {
    d = await createTestDaemon();
    const { run, actor } = await agentRun();
    const err = await expectCode(
      d.call(actor, 'grant.create', {
        subject: { kind: 'run', runId: run.id },
        permissions: ['*'],
      }),
      'forbidden',
    );
    expect(err.message).toMatch(/no capability grant/);
    const denied = events('policy.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]!).toMatchObject({
      runId: run.id,
      sessionId: run.sessionId,
      actor,
      payload: { permission: 'grant.create', projectIds: null },
    });
  });

  it('delegation: permissions, scope and limits must be a subset of the parent', async () => {
    d = await createTestDaemon();
    const pa = await d.call(HUMAN, 'project.create', { name: 'A' });
    const pb = await d.call(HUMAN, 'project.create', { name: 'B' });
    const orch = await agentRun();
    const root = await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'run', runId: orch.run.id },
      permissions: ['grant.create', 'task.*', 'session.get'],
      scope: { projectIds: [pa.id] },
      limits: { maxWorkers: 2 },
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const worker = await agentRun({ parentRunId: orch.run.id });
    const subject = { kind: 'run' as const, runId: worker.run.id };

    // (b) permission containment
    const e1 = await expectCode(
      d.call(orch.actor, 'grant.create', { subject, permissions: ['*'] }),
      'forbidden',
    );
    expect(e1.message).toMatch(/not held/);
    await expectCode(
      d.call(orch.actor, 'grant.create', { subject, permissions: ['session.*'] }),
      'forbidden',
    );
    // (c) scope subset
    const e2 = await expectCode(
      d.call(orch.actor, 'grant.create', {
        subject,
        permissions: ['task.get'],
        scope: { projectIds: [pa.id, pb.id] },
      }),
      'forbidden',
    );
    expect(e2.message).toMatch(/outside/);
    // (d) limits
    await expectCode(
      d.call(orch.actor, 'grant.create', {
        subject,
        permissions: ['task.get'],
        limits: { maxWorkers: 3 },
      }),
      'forbidden',
    );

    // A valid subset: omitted scope/limits/expiry are inherited, never widened.
    const child = await d.call(orch.actor, 'grant.create', {
      subject,
      permissions: ['task.get', 'task.update', 'session.get'],
    });
    expect(child).toMatchObject({
      parentGrantId: root.id,
      depth: 1,
      scope: { projectIds: [pa.id] },
      limits: { maxWorkers: 2 },
      expiresAt: '2099-01-01T00:00:00.000Z',
      grantedBy: orch.actor,
    });
    // An explicit later expiry is clamped to the parent's.
    const clamped = await d.call(orch.actor, 'grant.create', {
      subject,
      permissions: ['task.get'],
      expiresAt: '2199-01-01T00:00:00.000Z',
      parentGrantId: root.id,
    });
    expect(clamped.expiresAt).toBe('2099-01-01T00:00:00.000Z');

    // The worker can now use what it was given, only in project A.
    const task = await d.call(HUMAN, 'task.create', { projectId: pa.id, title: 't' });
    await expect(d.call(worker.actor, 'task.get', { taskId: task.id })).resolves.toMatchObject({
      id: task.id,
    });
    await expectCode(
      d.call(worker.actor, 'task.create', { projectId: pa.id, title: 'x' }),
      'forbidden',
    );

    // Every refusal above left an audit event.
    expect(events('policy.denied').length).toBeGreaterThanOrEqual(5);
  });

  it('(a) the parent must allow grant.create', async () => {
    d = await createTestDaemon();
    const orch = await agentRun();
    await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'session', sessionId: orch.session.id },
      lifetime: 'session',
      permissions: ['grant.create'],
    });
    const other = await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'run', runId: orch.run.id },
      permissions: ['task.*'],
    });
    const worker = await agentRun();
    // Explicitly naming a parent that holds task.* but not grant.create fails...
    const err = await expectCode(
      d.call(orch.actor, 'grant.create', {
        subject: { kind: 'run', runId: worker.run.id },
        permissions: ['task.get'],
        parentGrantId: other.id,
      }),
      'forbidden',
    );
    expect(err.message).toMatch(/does not allow delegation/);
    // ...and the grant.create-only grant cannot hand out task.get either.
    await expectCode(
      d.call(orch.actor, 'grant.create', {
        subject: { kind: 'run', runId: worker.run.id },
        permissions: ['task.get'],
      }),
      'forbidden',
    );
    // Somebody else's grant can never be used as a parent.
    const foreign = await agentRun();
    const fg = await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'run', runId: foreign.run.id },
      permissions: ['*'],
    });
    const e2 = await expectCode(
      d.call(orch.actor, 'grant.create', {
        subject: { kind: 'run', runId: worker.run.id },
        permissions: ['grant.create'],
        parentGrantId: fg.id,
      }),
      'forbidden',
    );
    expect(e2.message).toMatch(/only delegate their own/);
  });

  it('depth limit: a depth-1 grant can never delegate (default max depth 1)', async () => {
    d = await createTestDaemon();
    const orch = await agentRun();
    await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'run', runId: orch.run.id },
      permissions: ['*'],
    });
    const worker = await agentRun({ parentRunId: orch.run.id });
    const wg = await d.call(orch.actor, 'grant.create', {
      subject: { kind: 'run', runId: worker.run.id },
      permissions: ['*'],
    });
    expect(wg.depth).toBe(1);
    const grandchild = await agentRun({ parentRunId: worker.run.id });
    const err = await expectCode(
      d.call(worker.actor, 'grant.create', {
        subject: { kind: 'run', runId: grandchild.run.id },
        permissions: ['task.get'],
      }),
      'limit_exceeded',
    );
    expect(err.message).toMatch(/depth 2 exceeds the maximum \(1\)/);
    // Workers cannot spawn workers either.
    expect(() => d.ctx.service('policy').assertCanSpawnWorker(worker.actor)).toThrow(
      /cannot spawn workers/,
    );

    // Raising the global maximum allows one more level.
    await d.call(HUMAN, 'settings.update', { maxDelegationDepth: 2 });
    const g2 = await d.call(worker.actor, 'grant.create', {
      subject: { kind: 'run', runId: grandchild.run.id },
      permissions: ['task.get'],
    });
    expect(g2.depth).toBe(2);
  });

  it('limits.maxDepth shrinks per level and 0 forbids delegation', async () => {
    d = await createTestDaemon();
    await d.call(HUMAN, 'settings.update', { maxDelegationDepth: 4 });
    const a = await agentRun();
    await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'run', runId: a.run.id },
      permissions: ['*'],
      limits: { maxDepth: 1 },
    });
    const b = await agentRun();
    await expectCode(
      d.call(a.actor, 'grant.create', {
        subject: { kind: 'run', runId: b.run.id },
        permissions: ['*'],
        limits: { maxDepth: 1 },
      }),
      'forbidden',
    );
    const gb = await d.call(a.actor, 'grant.create', {
      subject: { kind: 'run', runId: b.run.id },
      permissions: ['*'],
    });
    expect(gb.limits.maxDepth).toBe(0);
    const c = await agentRun();
    const err = await expectCode(
      d.call(b.actor, 'grant.create', {
        subject: { kind: 'run', runId: c.run.id },
        permissions: ['*'],
      }),
      'limit_exceeded',
    );
    expect(err.message).toMatch(/maxDepth 0/);
  });
});

describe('grant.revoke', () => {
  it('cascades to every delegated grant and emits grant.revoked for each', async () => {
    d = await createTestDaemon();
    await d.call(HUMAN, 'settings.update', { maxDelegationDepth: 2 });
    const a = await agentRun();
    const root = await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'run', runId: a.run.id },
      permissions: ['*'],
    });
    const b = await agentRun();
    const gb = await d.call(a.actor, 'grant.create', {
      subject: { kind: 'run', runId: b.run.id },
      permissions: ['*'],
    });
    const c = await agentRun();
    const gc = await d.call(b.actor, 'grant.create', {
      subject: { kind: 'run', runId: c.run.id },
      permissions: ['task.*'],
    });

    // Agents can only revoke what they delegated: b cannot revoke its own grant or a's.
    await expectCode(d.call(b.actor, 'grant.revoke', { grantId: gb.id }), 'forbidden');
    await expectCode(d.call(b.actor, 'grant.revoke', { grantId: root.id }), 'forbidden');
    // a revokes b's grant -> c's goes with it.
    const revoked = await d.call(a.actor, 'grant.revoke', { grantId: gb.id, reason: 'done' });
    expect(revoked.revokedAt).not.toBeNull();
    expect(d.ctx.repos.grants.require(gc.id).revokedAt).not.toBeNull();
    expect(d.ctx.repos.grants.require(root.id).revokedAt).toBeNull();
    expect(events('grant.revoked').map((e) => [e.payload.grantId, e.payload.reason])).toEqual([
      [gb.id, 'done'],
      [gc.id, 'done'],
    ]);
    await expectCode(d.call(c.actor, 'task.list', {}), 'forbidden');
    // Idempotent.
    await d.call(HUMAN, 'grant.revoke', { grantId: gb.id });
    expect(events('grant.revoked')).toHaveLength(2);
  });
});

describe('grant lifetime', () => {
  it('run grants (and their children) end with the run', async () => {
    d = await createTestDaemon();
    const orch = await agentRun();
    const root = await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'run', runId: orch.run.id },
      permissions: ['*'],
    });
    const worker = await agentRun({ parentRunId: orch.run.id });
    const child = await d.call(orch.actor, 'grant.create', {
      subject: { kind: 'run', runId: worker.run.id },
      permissions: ['system.*'],
    });
    await expect(d.call(worker.actor, 'system.health', {})).resolves.toMatchObject({ ok: true });

    setRunStatus(d.ctx, orch.run.id, 'awaiting_approval'); // not terminal
    expect(d.ctx.repos.grants.require(root.id).revokedAt).toBeNull();
    setRunStatus(d.ctx, orch.run.id, 'completed');
    expect(d.ctx.repos.grants.require(root.id).revokedAt).not.toBeNull();
    expect(d.ctx.repos.grants.require(child.id).revokedAt).not.toBeNull();
    expect(events('grant.revoked').map((e) => e.payload.reason)).toEqual([
      'run_ended',
      'run_ended',
    ]);
    await expectCode(d.call(worker.actor, 'system.health', {}), 'forbidden');
  });

  it('a run-lifetime session grant covers the session until one of its runs ends', async () => {
    d = await createTestDaemon();
    const s = await d.call(HUMAN, 'session.create', {});
    const once = await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'session', sessionId: s.id },
      permissions: ['system.*'],
      lifetime: 'run',
    });
    const standing = await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'session', sessionId: s.id },
      permissions: ['project.list'],
      lifetime: 'session',
    });
    const run = insertRun(d.ctx, { sessionId: s.id });
    await expect(d.call(actorOf(run), 'system.health', {})).resolves.toMatchObject({ ok: true });
    setRunStatus(d.ctx, run.id, 'failed');
    expect(d.ctx.repos.grants.require(once.id).revokedAt).not.toBeNull();
    expect(d.ctx.repos.grants.require(standing.id).revokedAt).toBeNull();
    const next = insertRun(d.ctx, { sessionId: s.id });
    await expectCode(d.call(actorOf(next), 'system.health', {}), 'forbidden');
    await expect(d.call(actorOf(next), 'project.list', {})).resolves.toEqual({ items: [] });
  });

  it('expiresAt is honoured', async () => {
    const clock = createManualClock(Date.UTC(2026, 0, 1));
    d = await createTestDaemon({ clock });
    const { run, actor } = await agentRun();
    const g = await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'run', runId: run.id },
      permissions: ['system.*'],
      expiresAt: '2026-01-01T01:00:00.000Z',
    });
    await expect(d.call(actor, 'system.health', {})).resolves.toMatchObject({ ok: true });
    clock.advance(60 * 60 * 1000);
    await expectCode(d.call(actor, 'system.health', {}), 'forbidden');
    // Expired grants drop out of the default listing.
    expect((await d.call(HUMAN, 'grant.list', { runId: run.id })).items).toEqual([]);
    expect(
      (await d.call(HUMAN, 'grant.list', { runId: run.id, includeRevoked: true })).items.map(
        (x: CapabilityGrant) => x.id,
      ),
    ).toEqual([g.id]);
  });

  it('revokes grants of runs that ended while the daemon was down', async () => {
    const first = await createTestDaemon();
    const s = await first.call(HUMAN, 'session.create', {});
    const run = insertRun(first.ctx, { sessionId: s.id, status: 'running' });
    const g = await first.call(HUMAN, 'grant.create', {
      subject: { kind: 'run', runId: run.id },
      permissions: ['*'],
    });
    await first.close();
    // Restart: recovery marks the run interrupted before modules listen; the sweep catches it.
    d = await createTestDaemon({ home: first.home });
    const cleanupFirst = () => first.removeHome();
    try {
      expect(d.ctx.repos.runs.require(run.id).status).toBe('interrupted');
      expect(d.ctx.repos.grants.require(g.id).revokedAt).not.toBeNull();
    } finally {
      await d.cleanup();
      cleanupFirst();
      d = undefined as unknown as TestDaemonNoServer;
    }
  });
});

describe('grant.list', () => {
  it('filters by subject; agents only see their own grants and what they delegated', async () => {
    d = await createTestDaemon();
    const a = await agentRun();
    const ga = await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'run', runId: a.run.id },
      permissions: ['grant.*'],
    });
    const gs = await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'session', sessionId: a.session.id },
      permissions: ['system.*'],
      lifetime: 'session',
    });
    const b = await agentRun();
    const gb = await d.call(a.actor, 'grant.create', {
      subject: { kind: 'run', runId: b.run.id },
      permissions: ['grant.list'],
    });
    const other = await agentRun();
    const go = await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'run', runId: other.run.id },
      permissions: ['*'],
    });

    const ids = (r: { items: CapabilityGrant[] }) => r.items.map((g) => g.id);
    expect(ids(await d.call(HUMAN, 'grant.list', {}))).toEqual([ga.id, gs.id, gb.id, go.id]);
    expect(ids(await d.call(HUMAN, 'grant.list', { runId: a.run.id }))).toEqual([ga.id]);
    expect(
      ids(await d.call(HUMAN, 'grant.list', { runId: a.run.id, sessionId: a.session.id })),
    ).toEqual([ga.id, gs.id]);
    expect(ids(await d.call(a.actor, 'grant.list', {}))).toEqual([ga.id, gs.id, gb.id]);
    expect(ids(await d.call(b.actor, 'grant.list', {}))).toEqual([gb.id]);
    expect(ids(await d.call(b.actor, 'grant.list', { runId: other.run.id }))).toEqual([]);
  });
});

describe('assertCanSpawnWorker', () => {
  it('requires task.spawnWorker, respects project scope and limits.maxWorkers', async () => {
    d = await createTestDaemon();
    const policy = d.ctx.service('policy');
    const pa = await d.call(HUMAN, 'project.create', { name: 'A' });
    const pb = await d.call(HUMAN, 'project.create', { name: 'B' });
    expect(policy.assertCanSpawnWorker(HUMAN)).toBeNull();

    const orch = await agentRun();
    expect(() => policy.assertCanSpawnWorker(orch.actor)).toThrow(/no capability grant allows/);
    const g = await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'run', runId: orch.run.id },
      permissions: ['task.*'],
      scope: { projectIds: [pa.id] },
      limits: { maxWorkers: 2 },
    });
    expect(policy.assertCanSpawnWorker(orch.actor, { projectId: pa.id })?.id).toBe(g.id);
    expect(() => policy.assertCanSpawnWorker(orch.actor, { projectId: pb.id })).toThrow(ApiError);

    const w1 = insertRun(d.ctx, { sessionId: orch.session.id, parentRunId: orch.run.id });
    insertRun(d.ctx, { sessionId: orch.session.id, parentRunId: orch.run.id, status: 'queued' });
    insertRun(d.ctx, { sessionId: orch.session.id, parentRunId: orch.run.id, status: 'completed' });
    let err: unknown;
    try {
      policy.assertCanSpawnWorker(orch.actor, { projectId: pa.id });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'limit_exceeded', data: { active: 2, maxWorkers: 2 } });
    setRunStatus(d.ctx, w1.id, 'cancelled');
    expect(policy.assertCanSpawnWorker(orch.actor, { projectId: pa.id })?.id).toBe(g.id);

    const denied = events('policy.denied').map((e) => e.payload.permission);
    expect(denied).toEqual(['task.spawnWorker', 'task.spawnWorker', 'task.spawnWorker']);
  });
});
