import type { Actor, Event, Run, Task } from '@acc/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunsService } from '../contracts';
import { ApiError } from '../core/errors';
import { defineModule } from '../module';
import { modules } from '../modules';
import { actorOf, insertRun, setRunStatus } from '../policy/testutil';
import { HUMAN, type TestDaemonNoServer, createTestDaemon } from '../testing';

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

async function setup() {
  d = await createTestDaemon();
  const project = await d.call(HUMAN, 'project.create', { name: 'P' });
  const create = (
    title: string,
    extra: { dependsOn?: string[]; priority?: Task['priority'] } = {},
  ) => d.call(HUMAN, 'task.create', { projectId: project.id, title, ...extra });
  const status = (id: string) => {
    const t = d.ctx.repos.tasks.require(id);
    return t.statusReason ? `${t.status}:${t.statusReason}` : t.status;
  };
  return { project, create, status, svc: d.ctx.service('tasks') };
}

function taskUpdates(): Extract<Event, { type: 'task.updated' }>[] {
  return d.ctx.bus.list({ types: ['task.updated'] }).events as Extract<
    Event,
    { type: 'task.updated' }
  >[];
}

describe('task.create', () => {
  it('stores goal fields and starts ready / pending depending on dependencies', async () => {
    const { project, create } = await setup();
    const a = await d.call(HUMAN, 'task.create', {
      projectId: project.id,
      title: ' Build API ',
      description: 'desc',
      acceptanceCriteria: ['tests pass', 'documented'],
      priority: 'high',
    });
    expect(a).toMatchObject({
      title: 'Build API',
      status: 'ready',
      statusReason: null,
      priority: 'high',
      acceptanceCriteria: ['tests pass', 'documented'],
      dependsOn: [],
      createdBy: HUMAN,
      completedAt: null,
    });
    const b = await create('B', { dependsOn: [a.id, a.id] });
    expect(b).toMatchObject({ status: 'pending', dependsOn: [a.id] });
    const ev = d.ctx.bus.list({ types: ['task.created'] }).events;
    expect(ev.map((e) => [e.taskId, e.projectId])).toEqual([
      [a.id, project.id],
      [b.id, project.id],
    ]);
  });

  it('rejects unknown, cross-project dependencies and parents with invalid_params', async () => {
    const { project, create } = await setup();
    const other = await d.call(HUMAN, 'project.create', { name: 'Other' });
    const foreign = await d.call(HUMAN, 'task.create', { projectId: other.id, title: 'f' });
    const e1 = await expectCode(
      create('x', { dependsOn: [d.ctx.ids.next('task')] }),
      'invalid_params',
    );
    expect(e1.message).toMatch(/unknown task in dependsOn/);
    await expectCode(create('x', { dependsOn: [foreign.id] }), 'invalid_params');
    await expectCode(
      d.call(HUMAN, 'task.create', { projectId: project.id, title: 'x', parentTaskId: foreign.id }),
      'invalid_params',
    );
    await expectCode(
      d.call(HUMAN, 'task.create', { projectId: d.ctx.ids.next('project'), title: 'x' }),
      'not_found',
    );
  });
});

describe('dependency DAG', () => {
  it('rejects cycles and self-dependencies on update', async () => {
    const { create } = await setup();
    const a = await create('A');
    const b = await create('B', { dependsOn: [a.id] });
    const c = await create('C', { dependsOn: [b.id] });
    const err = await expectCode(
      d.call(HUMAN, 'task.update', { taskId: a.id, dependsOn: [c.id] }),
      'invalid_params',
    );
    expect(err.message).toBe(
      `dependsOn would create a cycle: ${a.id} -> ${c.id} -> ${b.id} -> ${a.id}`,
    );
    await expectCode(
      d.call(HUMAN, 'task.update', { taskId: a.id, dependsOn: [a.id] }),
      'invalid_params',
    );
    await expectCode(
      d.call(HUMAN, 'task.update', { taskId: b.id, dependsOn: [d.ctx.ids.next('task')] }),
      'invalid_params',
    );
    // Rewiring that keeps it acyclic is fine: C now depends on A directly.
    const updated = await d.call(HUMAN, 'task.update', { taskId: c.id, dependsOn: [a.id] });
    expect(updated.dependsOn).toEqual([a.id]);
    expect(d.ctx.repos.tasks.require(a.id).dependsOn).toEqual([]);
  });

  it('readiness: pending tasks become ready when every dependency is done', async () => {
    const { create, status, svc } = await setup();
    const a = await create('A');
    const b = await create('B');
    const c = await create('C', { dependsOn: [a.id, b.id] });
    const e = await create('E', { dependsOn: [c.id] });
    expect([status(c.id), status(e.id)]).toEqual(['pending', 'pending']);

    svc.setStatus(a.id, 'running', HUMAN);
    svc.setStatus(a.id, 'done', HUMAN);
    expect(status(c.id)).toBe('pending');
    const done = await d.call(HUMAN, 'task.update', { taskId: b.id, status: 'done' });
    expect(done.completedAt).not.toBeNull();
    expect(status(c.id)).toBe('ready');
    expect(status(e.id)).toBe('pending');

    const auto = taskUpdates().filter((x) => x.taskId === c.id);
    expect(auto).toHaveLength(1);
    expect(auto[0]!).toMatchObject({
      actor: { kind: 'system', component: 'tasks' },
      payload: { changes: ['status'] },
    });
    // Reopening a done dependency sends the dependent back to pending.
    svc.setStatus(b.id, 'running', HUMAN, 'rework');
    expect(status(c.id)).toBe('pending');
    expect(d.ctx.repos.tasks.require(b.id)).toMatchObject({
      completedAt: null,
      statusReason: 'rework',
    });
  });

  it('blocked propagation: failure blocks the downstream chain until the dependency recovers', async () => {
    const { create, status, svc } = await setup();
    const a = await create('A');
    const b = await create('B', { dependsOn: [a.id] });
    const c = await create('C', { dependsOn: [b.id] });
    const side = await create('Side');

    svc.setStatus(a.id, 'failed', HUMAN, 'tests failed');
    expect(status(a.id)).toBe('failed:tests failed');
    expect(status(b.id)).toBe('blocked:dependency_failed');
    expect(status(c.id)).toBe('blocked:dependency_blocked');
    expect(status(side.id)).toBe('ready');

    // Retry A: the chain goes back to waiting, then flows once A is done.
    svc.setStatus(a.id, 'running', HUMAN);
    expect([status(b.id), status(c.id)]).toEqual(['pending', 'pending']);
    svc.setStatus(a.id, 'done', HUMAN);
    expect([status(b.id), status(c.id)]).toEqual(['ready', 'pending']);

    // A manual block is not undone by readiness changes.
    await d.call(HUMAN, 'task.update', { taskId: c.id, status: 'blocked' });
    svc.setStatus(b.id, 'done', HUMAN);
    expect(status(c.id)).toBe('blocked');
    // Putting it back to pending re-evaluates immediately.
    const back = await d.call(HUMAN, 'task.update', { taskId: c.id, status: 'pending' });
    expect(back.status).toBe('ready');
  });

  it('cannot mark a task ready while dependencies are unfinished', async () => {
    const { create } = await setup();
    const a = await create('A');
    const b = await create('B', { dependsOn: [a.id] });
    await expectCode(
      d.call(HUMAN, 'task.update', { taskId: b.id, status: 'ready' }),
      'invalid_params',
    );
    // Dropping the dependency makes it ready on its own.
    const t = await d.call(HUMAN, 'task.update', { taskId: b.id, dependsOn: [] });
    expect(t.status).toBe('ready');
    const ev = taskUpdates().at(-1)!;
    expect(ev.payload.changes).toEqual(['dependsOn', 'status']);
  });

  it('update records only changed fields and is a no-op otherwise', async () => {
    const { create } = await setup();
    const a = await create('A');
    await d.call(HUMAN, 'task.update', {
      taskId: a.id,
      title: 'A',
      priority: 'urgent',
      acceptanceCriteria: ['x'],
      resultSummary: 'ok',
    });
    expect(taskUpdates().map((e) => e.payload.changes)).toEqual([
      ['acceptanceCriteria', 'priority', 'resultSummary'],
    ]);
    await d.call(HUMAN, 'task.update', { taskId: a.id, priority: 'urgent' });
    expect(taskUpdates()).toHaveLength(1);
    await expectCode(
      d.call(HUMAN, 'task.update', { taskId: a.id, assigneeSessionId: d.ctx.ids.next('session') }),
      'not_found',
    );
  });

  it('topoOrder and readyTasks order by dependencies, then priority, then age', async () => {
    const { project, create, svc } = await setup();
    const low = await create('low', { priority: 'low' });
    const base = await create('base');
    const x = await create('x', { dependsOn: [base.id] });
    const y = await create('y', { dependsOn: [x.id], priority: 'urgent' });
    const urgent = await create('urgent', { priority: 'urgent' });

    expect(svc.readyTasks(project.id).map((t) => t.title)).toEqual(['urgent', 'base', 'low']);
    // y depends on base only transitively (through x, which is not in the set).
    expect(svc.topoOrder([y.id, low.id, base.id, urgent.id]).map((t) => t.title)).toEqual([
      'urgent',
      'base',
      'y',
      'low',
    ]);
    expect(() => svc.topoOrder([d.ctx.ids.next('task')])).toThrow(ApiError);
  });
});

describe('task.cancel', () => {
  it('cancels the task, its subtasks and their active runs; dependents become blocked', async () => {
    const cancelled: string[] = [];
    const fakeRuns = defineModule({
      name: 'fake-runs',
      register(ctx) {
        ctx.provide('runs', {
          cancel: (runId: string, _actor: Actor) => {
            cancelled.push(runId);
            return ctx.repos.runs.require(runId);
          },
        } as unknown as RunsService);
      },
    });
    d = await createTestDaemon({
      modules: [...modules.filter((m) => m.name !== 'runs'), fakeRuns],
    });
    const project = await d.call(HUMAN, 'project.create', { name: 'P' });
    const parent = await d.call(HUMAN, 'task.create', { projectId: project.id, title: 'parent' });
    const sub = await d.call(HUMAN, 'task.create', {
      projectId: project.id,
      title: 'sub',
      parentTaskId: parent.id,
    });
    const after = await d.call(HUMAN, 'task.create', {
      projectId: project.id,
      title: 'after',
      dependsOn: [parent.id],
    });
    const session = await d.call(HUMAN, 'session.create', {});
    const active = insertRun(d.ctx, { sessionId: session.id, taskId: sub.id });
    insertRun(d.ctx, { sessionId: session.id, taskId: sub.id, status: 'failed' });

    const t = await d.call(HUMAN, 'task.cancel', { taskId: parent.id, reason: 'scope cut' });
    expect(t).toMatchObject({ status: 'cancelled', statusReason: 'scope cut' });
    expect(t.completedAt).not.toBeNull();
    expect(d.ctx.repos.tasks.require(sub.id)).toMatchObject({
      status: 'cancelled',
      statusReason: 'parent_cancelled',
    });
    expect(d.ctx.repos.tasks.require(after.id)).toMatchObject({
      status: 'blocked',
      statusReason: 'dependency_cancelled',
    });
    expect(cancelled).toEqual([active.id]);
    // Idempotent; done tasks cannot be cancelled.
    await d.call(HUMAN, 'task.cancel', { taskId: parent.id });
    const done = await d.call(HUMAN, 'task.create', { projectId: project.id, title: 'd' });
    await d.call(HUMAN, 'task.update', { taskId: done.id, status: 'done' });
    await expectCode(d.call(HUMAN, 'task.cancel', { taskId: done.id }), 'conflict');
  });
});

describe('task methods and capabilities', () => {
  it('scope filtering: project-restricted agents only see their projects', async () => {
    d = await createTestDaemon();
    const pa = await d.call(HUMAN, 'project.create', { name: 'A' });
    const pb = await d.call(HUMAN, 'project.create', { name: 'B' });
    const ta = await d.call(HUMAN, 'task.create', { projectId: pa.id, title: 'a' });
    const tb = await d.call(HUMAN, 'task.create', { projectId: pb.id, title: 'b' });
    const subA = await d.call(HUMAN, 'task.create', {
      projectId: pa.id,
      title: 'a-sub',
      parentTaskId: ta.id,
    });
    const session = await d.call(HUMAN, 'session.create', { projectId: pa.id });
    const run: Run = insertRun(d.ctx, { sessionId: session.id, projectId: pa.id });
    const actor = actorOf(run);

    // No grant at all.
    await expectCode(d.call(actor, 'task.list', { projectId: pa.id }), 'forbidden');

    await d.call(HUMAN, 'grant.create', {
      subject: { kind: 'run', runId: run.id },
      permissions: ['task.*'],
      scope: { projectIds: [pa.id] },
    });
    const listed = await d.call(actor, 'task.list', { projectId: pa.id });
    expect(listed.items.map((t) => t.id)).toEqual([ta.id, subA.id]);
    const subs = await d.call(actor, 'task.list', { parentTaskId: ta.id });
    expect(subs.items.map((t) => t.id)).toEqual([subA.id]);
    await expectCode(d.call(actor, 'task.list', {}), 'forbidden');
    await expectCode(d.call(actor, 'task.list', { projectId: pb.id }), 'forbidden');
    await expectCode(d.call(actor, 'task.get', { taskId: tb.id }), 'forbidden');
    await expectCode(d.call(actor, 'task.update', { taskId: tb.id, title: 'x' }), 'forbidden');
    await expectCode(d.call(actor, 'task.create', { projectId: pb.id, title: 'x' }), 'forbidden');
    const created = await d.call(actor, 'task.create', { projectId: pa.id, title: 'by agent' });
    expect(created.createdBy).toEqual(actor);

    const denied = d.ctx.bus.list({ types: ['policy.denied'] }).events;
    expect(denied.length).toBe(6);
    expect(denied.at(-1)!.projectId).toBe(pb.id);

    // The grant ends with the run.
    setRunStatus(d.ctx, run.id, 'completed');
    await expectCode(d.call(actor, 'task.get', { taskId: ta.id }), 'forbidden');
  });

  it('task.list filters by status and paginates in creation order', async () => {
    const { project, create, svc } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await create(`t${i}`)).id);
    svc.setStatus(ids[1]!, 'done', HUMAN);
    const p1 = await d.call(HUMAN, 'task.list', { projectId: project.id, limit: 2 });
    expect(p1.items.map((t) => t.id)).toEqual(ids.slice(0, 2));
    const p2 = await d.call(HUMAN, 'task.list', {
      projectId: project.id,
      limit: 10,
      cursor: p1.nextCursor!,
    });
    expect(p2.items.map((t) => t.id)).toEqual(ids.slice(2));
    const done = await d.call(HUMAN, 'task.list', { status: ['done'] });
    expect(done.items.map((t) => t.id)).toEqual([ids[1]]);
  });

  it('task.spawnWorker and task.wait stay unimplemented for the integration step', async () => {
    d = await createTestDaemon();
    const info = await d.call(HUMAN, 'system.info', {});
    expect(info.methods).toEqual(
      expect.arrayContaining([
        'task.create',
        'task.list',
        'task.get',
        'task.update',
        'task.cancel',
      ]),
    );
    expect(info.methods).not.toContain('task.spawnWorker');
    expect(info.methods).not.toContain('task.wait');
  });
});
