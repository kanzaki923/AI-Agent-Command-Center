/**
 * T6 acceptance (spec 20261029 §5.8) with a manual clock, a manual timer and a stand-in
 * spawner (the Spawn track's spawner is a stub on this branch):
 * 1. cron / once / schedule.preview (time zone, DST)  2. a firing makes a child of the owner
 * 3. catch-up  4. overlap, disable, expiry, delete, restart  5. schedules made by an AI
 * 6. schedule.runNow.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Artifact, Schedule } from '@acc/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ManualClock, createManualClock } from '../core/clock';
import { ApiError, budgetExceeded } from '../core/errors';
import { modules as defaultModules } from '../modules';
import { actorOf, insertRun, setRunStatus } from '../policy/testutil';
import { HUMAN, type TestDaemonNoServer, createTestDaemon } from '../testing';
import { SCHEDULER_ACTOR, type Scheduler, createSchedulesModule } from './index';
import { FakeSpawner, ManualTimers, scheduleTestModules } from './testutil';

/** 2026-11-04 21:00 in Tokyo. */
const START = Date.parse('2026-11-04T12:00:00Z');
const HOUR = 3_600_000;

const daemons: TestDaemonNoServer[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 5 });
});

interface Env {
  d: TestDaemonNoServer;
  clock: ManualClock;
  spawner: FakeSpawner;
  timers: ManualTimers;
  scheduler: Scheduler;
}

async function setup(
  opts: { home?: string; clock?: ManualClock; spawner?: FakeSpawner } = {},
): Promise<Env> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'acc-sched-'));
  if (!opts.home) homes.push(home);
  const clock = opts.clock ?? createManualClock(START);
  const spawner = opts.spawner ?? new FakeSpawner();
  const timers = new ManualTimers();
  const d = await createTestDaemon({ home, clock, modules: scheduleTestModules(spawner, timers) });
  daemons.push(d);
  await d.call(HUMAN, 'settings.update', { limits: { timezone: 'Asia/Tokyo' } });
  const scheduler = d.ctx.service('scheduler') as Scheduler;
  await scheduler.idle();
  return { d, clock, spawner, timers, scheduler };
}

/** Let time pass to `iso` and fire the armed timer (late, when the machine slept). */
async function wake(env: Env, iso: string): Promise<void> {
  env.clock.set(Date.parse(iso));
  env.timers.fire();
  await env.scheduler.idle();
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'ok',
    (e: unknown) => (e instanceof ApiError ? e.code : String(e)),
  );
}

async function owner(env: Env, title = 'マーケ') {
  return env.d.call(HUMAN, 'session.create', { title });
}

function daily9(env: Env, sessionId: string, extra: Record<string, unknown> = {}) {
  return env.d.call(HUMAN, 'schedule.create', {
    sessionId,
    title: '週次レポート',
    prompt: '今週の数字をまとめて',
    trigger: { kind: 'cron', expr: '0 9 * * *' },
    ...extra,
  });
}

function get(env: Env, scheduleId: string): Schedule {
  return env.d.ctx.repos.schedules.require(scheduleId);
}

function fired(env: Env) {
  return env.d.ctx.bus
    .list({ types: ['schedule.fired'] })
    .events.map((e) => (e.type === 'schedule.fired' ? e.payload : null));
}

function insertDocument(env: Env, sessionId: string, title: string, content: string): Artifact {
  const now = env.d.ctx.clock.iso();
  return env.d.ctx.repos.artifacts.insert({
    id: env.d.ctx.ids.next('artifact'),
    projectId: null,
    sessionId,
    runId: null,
    taskId: null,
    workspaceId: null,
    title,
    createdBy: HUMAN,
    createdAt: now,
    kind: 'document',
    data: { format: 'markdown', content, path: null },
  });
}

/** End the child's runs, as when its work finished. */
function finish(env: Env, sessionId: string): void {
  for (const r of env.d.ctx.repos.runs.find({ where: { session_id: sessionId } })) {
    if (r.status === 'running') setRunStatus(env.d.ctx, r.id, 'completed');
  }
}

describe('1. cron, once and preview', () => {
  it('preview: the next 5 times in the settings time zone, and across a DST change', async () => {
    const env = await setup();
    const tokyo = await env.d.call(HUMAN, 'schedule.preview', {
      trigger: { kind: 'cron', expr: '0 9 * * 1-5' },
    });
    // 11/4 21:00 Tokyo (Wed) → Thu, Fri, Mon, Tue, Wed at 9:00 JST.
    expect(tokyo.times).toEqual([
      '2026-11-05T00:00:00.000Z',
      '2026-11-06T00:00:00.000Z',
      '2026-11-09T00:00:00.000Z',
      '2026-11-10T00:00:00.000Z',
      '2026-11-11T00:00:00.000Z',
    ]);
    env.clock.set(Date.parse('2026-10-30T12:00:00Z'));
    const ny = await env.d.call(HUMAN, 'schedule.preview', {
      trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' },
      count: 4,
    });
    // DST ends on 11/1: 9:00 stays 9:00 local, the UTC time moves by an hour.
    expect(ny.times).toEqual([
      '2026-10-30T13:00:00.000Z', // EDT
      '2026-10-31T13:00:00.000Z',
      '2026-11-01T14:00:00.000Z', // EST
      '2026-11-02T14:00:00.000Z',
    ]);
    const once = await env.d.call(HUMAN, 'schedule.preview', {
      trigger: { kind: 'once', at: '2026-11-01T00:00:00Z' },
    });
    expect(once.times).toEqual(['2026-11-01T00:00:00.000Z']);
    expect(
      await codeOf(
        env.d.call(HUMAN, 'schedule.preview', { trigger: { kind: 'cron', expr: '0 25 * * *' } }),
      ),
    ).toBe('invalid_params');
  });

  it('create: cron gets the default zone and its next time; once must be ahead', async () => {
    const env = await setup();
    const o = await owner(env);
    const s = await daily9(env, o.id);
    expect(s).toMatchObject({
      sessionId: o.id,
      trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Tokyo' },
      run: { mode: 'agent', workspace: { kind: 'none' }, budgetUsd: 1, supervise: false },
      catchUp: 'latest',
      maxLatenessMin: 720,
      enabled: true,
      nextRunAt: '2026-11-05T00:00:00.000Z',
      lastRun: null,
      createdBy: HUMAN,
    });
    // One timer, for the nearest time (12 hours ahead).
    expect(env.timers.armed).toHaveLength(1);
    expect(env.timers.delay).toBe(12 * HOUR);

    const once = await env.d.call(HUMAN, 'schedule.create', {
      sessionId: o.id,
      prompt: '発売日の朝に告知を出す\n詳しくは…',
      trigger: { kind: 'once', at: '2026-11-04T15:00:00Z' },
    });
    expect(once).toMatchObject({
      title: '発売日の朝に告知を出す',
      nextRunAt: '2026-11-04T15:00:00.000Z',
    });
    expect(env.timers.armed).toHaveLength(1);
    expect(env.timers.delay).toBe(3 * HOUR);

    const past = env.d.call(HUMAN, 'schedule.create', {
      sessionId: o.id,
      prompt: 'x',
      trigger: { kind: 'once', at: '2026-11-04T11:00:00Z' },
    });
    expect(await codeOf(past)).toBe('invalid_params');
    expect(
      env.d.ctx.bus.list({ types: ['schedule.created'] }).events.map((e) => e.sessionId),
    ).toEqual([o.id, o.id]);
  });
});

describe('2. a firing creates a child of the owner', () => {
  it('title, scheduleId, meta.schedule, budget, and the previous output attached', async () => {
    const env = await setup();
    const o = await owner(env);
    const s = await daily9(env, o.id);

    await wake(env, '2026-11-05T00:00:00Z');
    expect(env.spawner.calls).toHaveLength(1);
    const first = env.spawner.calls[0]!;
    expect(first.actor).toEqual(SCHEDULER_ACTOR);
    expect(first.params).toMatchObject({
      parentSessionId: o.id,
      title: '週次レポート · 11/5 9:00',
      goal: '今週の数字をまとめて',
      mode: 'agent',
      workspace: { kind: 'none' },
      budgetUsd: 1,
      reviewBy: 'none',
      start: true,
    });
    expect(first.opts).toEqual({
      scheduleId: s.id,
      scheduledFor: '2026-11-05T00:00:00.000Z',
      trigger: 'schedule',
      budget: { parentBudgetId: null, limitUsd: 1 },
      supervise: false,
    });

    const after = get(env, s.id);
    const childId = after.lastRun!.sessionId!;
    expect(after).toMatchObject({
      nextRunAt: '2026-11-06T00:00:00.000Z',
      lastRun: { scheduledFor: '2026-11-05T00:00:00.000Z', outcome: 'started', error: null },
    });
    const child = env.d.ctx.repos.sessions.require(childId);
    expect(child).toMatchObject({
      parentSessionId: o.id,
      rootSessionId: o.rootSessionId,
      scheduleId: s.id,
      title: '週次レポート · 11/5 9:00',
    });
    const [msg] = env.d.ctx.repos.messages.find({ where: { session_id: childId } });
    expect(msg!.meta).toEqual({
      kind: 'schedule',
      scheduleId: s.id,
      scheduledFor: '2026-11-05T00:00:00.000Z',
    });
    expect(fired(env)).toEqual([
      {
        scheduleId: s.id,
        sessionId: childId,
        scheduledFor: '2026-11-05T00:00:00.000Z',
        outcome: 'started',
      },
    ]);
    expect(env.timers.delay).toBe(24 * HOUR);

    // The child wrote a report; the next firing gets its title and the first 4,000 chars.
    const long = `# 先週の数字\n${'あ'.repeat(5_000)}`;
    insertDocument(env, childId, '週次レポート 11/5', long);
    finish(env, childId);
    await wake(env, '2026-11-06T00:00:00Z');
    const goal = env.spawner.calls[1]!.params.goal;
    expect(
      goal.startsWith(
        '今週の数字をまとめて\n\n---\n前回（11/5 9:00）の成果物「週次レポート 11/5」:\n# 先週の数字\n',
      ),
    ).toBe(true);
    expect(goal.length).toBeLessThan('今週の数字をまとめて'.length + 4_100);
    expect(goal.endsWith('…')).toBe(true);
  });

  it('includePrevious: false sends only the prompt; chat mode has no workspace', async () => {
    const env = await setup();
    const o = await owner(env);
    const s = await daily9(env, o.id, {
      run: { includePrevious: false, mode: 'chat', model: 'm1' },
    });
    await wake(env, '2026-11-05T00:00:00Z');
    const childId = get(env, s.id).lastRun!.sessionId!;
    insertDocument(env, childId, 'r', 'body');
    finish(env, childId);
    await wake(env, '2026-11-06T00:00:00Z');
    const p = env.spawner.calls[1]!.params;
    expect(p.goal).toBe('今週の数字をまとめて');
    expect(p.mode).toBe('chat');
    expect(p.model).toBe('m1');
    expect(p).not.toHaveProperty('workspace');
  });
});

describe('3. catch-up after sleep', () => {
  it('latest: of the missed firings only the latest runs, once', async () => {
    const env = await setup();
    const o = await owner(env);
    const s = await env.d.call(HUMAN, 'schedule.create', {
      sessionId: o.id,
      title: '在庫の確認',
      prompt: '在庫を確認',
      trigger: { kind: 'cron', expr: '0 * * * *' },
    });
    expect(s.nextRunAt).toBe('2026-11-04T13:00:00.000Z');
    // Asleep until 18:20Z: 13, 14, …, 18 were missed; only 18:00 runs.
    await wake(env, '2026-11-04T18:20:00Z');
    expect(env.spawner.calls.map((c) => c.opts?.scheduledFor)).toEqual([
      '2026-11-04T18:00:00.000Z',
    ]);
    expect(get(env, s.id).nextRunAt).toBe('2026-11-04T19:00:00.000Z');
    expect(fired(env)).toHaveLength(1);
  });

  it('latest: later than 12 hours is recorded as missed and not run', async () => {
    const env = await setup();
    const o = await owner(env);
    const s = await daily9(env, o.id);
    await wake(env, '2026-11-05T12:00:01Z');
    expect(env.spawner.calls).toHaveLength(0);
    expect(get(env, s.id)).toMatchObject({
      nextRunAt: '2026-11-06T00:00:00.000Z',
      lastRun: { scheduledFor: '2026-11-05T00:00:00.000Z', outcome: 'missed', sessionId: null },
    });
    expect(fired(env)).toEqual([expect.objectContaining({ outcome: 'missed', sessionId: null })]);
    // A custom lateness: 13 hours late still runs with maxLatenessMin 900.
    await env.d.call(HUMAN, 'schedule.update', { scheduleId: s.id, maxLatenessMin: 900 });
    await wake(env, '2026-11-06T13:00:00Z');
    expect(env.spawner.calls.map((c) => c.opts?.scheduledFor)).toEqual([
      '2026-11-06T00:00:00.000Z',
    ]);
  });

  it('skip: runs only when less than 5 minutes late', async () => {
    const env = await setup();
    const o = await owner(env);
    const s = await env.d.call(HUMAN, 'schedule.create', {
      sessionId: o.id,
      prompt: '確認',
      trigger: { kind: 'cron', expr: '0 * * * *' },
      catchUp: 'skip',
    });
    await wake(env, '2026-11-04T13:10:00Z');
    expect(env.spawner.calls).toHaveLength(0);
    expect(get(env, s.id).lastRun).toMatchObject({ outcome: 'missed' });
    await wake(env, '2026-11-04T14:03:00Z');
    expect(env.spawner.calls).toHaveLength(1);
    expect(get(env, s.id).lastRun).toMatchObject({
      outcome: 'started',
      scheduledFor: '2026-11-04T14:00:00.000Z',
    });
  });
});

describe('4. overlap, stop, expiry, delete, restart', () => {
  it('a firing while the previous child still works is skipped_overlap', async () => {
    const env = await setup();
    const o = await owner(env);
    const s = await daily9(env, o.id);
    await wake(env, '2026-11-05T00:00:00Z');
    const firstChild = get(env, s.id).lastRun!.sessionId!;
    await wake(env, '2026-11-06T00:00:00Z');
    expect(env.spawner.calls).toHaveLength(1);
    expect(get(env, s.id)).toMatchObject({
      nextRunAt: '2026-11-07T00:00:00.000Z',
      lastRun: { outcome: 'skipped_overlap', sessionId: null },
    });
    finish(env, firstChild);
    await wake(env, '2026-11-07T00:00:00Z');
    expect(env.spawner.calls).toHaveLength(2);
    expect(fired(env).map((f) => f?.outcome)).toEqual(['started', 'skipped_overlap', 'started']);
  });

  it('disabled: no timer and no firing; enabling again does not catch up', async () => {
    const env = await setup();
    const o = await owner(env);
    const s = await daily9(env, o.id);
    const off = await env.d.call(HUMAN, 'schedule.update', { scheduleId: s.id, enabled: false });
    expect(off).toMatchObject({ enabled: false, nextRunAt: null });
    expect(env.timers.armed).toHaveLength(0);
    env.clock.set(Date.parse('2026-11-06T03:00:00Z'));
    await env.scheduler.runDue();
    expect(env.spawner.calls).toHaveLength(0);
    const on = await env.d.call(HUMAN, 'schedule.update', { scheduleId: s.id, enabled: true });
    expect(on.nextRunAt).toBe('2026-11-07T00:00:00.000Z');
    const updated = env.d.ctx.bus.list({ types: ['schedule.updated'] }).events;
    expect(updated.map((e) => (e.type === 'schedule.updated' ? e.payload.changes : []))).toEqual([
      ['enabled', 'nextRunAt'],
      ['enabled', 'nextRunAt'],
    ]);
  });

  it('expiry: nothing fires after expiresAt', async () => {
    const env = await setup();
    const o = await owner(env);
    const s = await daily9(env, o.id, { expiresAt: '2026-11-05T12:00:00Z' });
    await wake(env, '2026-11-05T00:00:00Z');
    expect(env.spawner.calls).toHaveLength(1);
    expect(get(env, s.id).nextRunAt).toBeNull();
    expect(env.timers.armed).toHaveLength(0);
    expect(await codeOf(daily9(env, o.id, { expiresAt: '2026-11-04T11:00:00Z' }))).toBe(
      'invalid_params',
    );
  });

  it('delete: the schedule and its timer are gone; children are kept', async () => {
    const env = await setup();
    const o = await owner(env);
    const s = await daily9(env, o.id);
    await wake(env, '2026-11-05T00:00:00Z');
    const child = get(env, s.id).lastRun!.sessionId!;
    await env.d.call(HUMAN, 'schedule.delete', { scheduleId: s.id });
    expect(env.timers.armed).toHaveLength(0);
    expect(await codeOf(env.d.call(HUMAN, 'schedule.get', { scheduleId: s.id }))).toBe('not_found');
    expect(env.d.ctx.repos.sessions.get(child)).toBeDefined();
    expect(env.d.ctx.bus.list({ types: ['schedule.deleted'] }).events).toHaveLength(1);
    env.clock.set(Date.parse('2026-11-06T00:00:00Z'));
    await env.scheduler.runDue();
    expect(env.spawner.calls).toHaveLength(1);
  });

  it('restart: the latest missed firing runs at startup and the next time is recomputed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'acc-sched-'));
    homes.push(home);
    const clock = createManualClock(START);
    const spawner = new FakeSpawner();
    const env = await setup({ home, clock, spawner });
    const o = await owner(env);
    const onTime = await daily9(env, o.id);
    const tooLate = await env.d.call(HUMAN, 'schedule.create', {
      sessionId: o.id,
      title: '朝の確認',
      prompt: '確認',
      trigger: { kind: 'cron', expr: '0 9 * * *' },
      maxLatenessMin: 60,
    });
    await env.d.close();
    daemons.splice(daemons.indexOf(env.d), 1);

    // Down from 11/4 21:00 to 11/5 12:00 Tokyo (3 hours after 9:00).
    clock.set(Date.parse('2026-11-05T03:00:00Z'));
    const again = await setup({ home, clock, spawner });
    expect(spawner.calls.map((c) => [c.opts?.scheduleId, c.opts?.scheduledFor])).toEqual([
      [onTime.id, '2026-11-05T00:00:00.000Z'],
    ]);
    expect(get(again, onTime.id)).toMatchObject({
      nextRunAt: '2026-11-06T00:00:00.000Z',
      lastRun: { outcome: 'started' },
    });
    expect(get(again, tooLate.id)).toMatchObject({
      nextRunAt: '2026-11-06T00:00:00.000Z',
      lastRun: { outcome: 'missed' },
    });
    expect(again.timers.delay).toBe(21 * HOUR);
  });

  it('without the Spawn track the firing is recorded as failed_to_start', async () => {
    const timers = new ManualTimers();
    const clock = createManualClock(START);
    const d = await createTestDaemon({
      clock,
      modules: defaultModules.map((m) =>
        m.name === 'schedules' ? createSchedulesModule({ timers }) : m,
      ),
    });
    daemons.push(d);
    const o = await d.call(HUMAN, 'session.create', { title: 'o' });
    const s = await d.call(HUMAN, 'schedule.create', {
      sessionId: o.id,
      prompt: 'x',
      trigger: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
    });
    clock.set(Date.parse('2026-11-04T13:00:00Z'));
    timers.fire();
    await (d.ctx.service('scheduler') as Scheduler).idle();
    expect(d.ctx.repos.schedules.require(s.id)).toMatchObject({
      nextRunAt: '2026-11-04T14:00:00.000Z',
      lastRun: { outcome: 'failed_to_start', error: expect.stringContaining('session.spawn') },
    });
    expect(timers.armed).toHaveLength(1);
  });
});

describe('5. schedules made by an AI', () => {
  /** A supervisor session S (with a child C) holding a schedule grant, and another tree. */
  async function aiTree(env: Env, limits: { maxSchedules?: number } = {}) {
    const supervisor = await owner(env, 'ローンチ準備');
    const child = await env.d.call(HUMAN, 'session.create', {
      parentSessionId: supervisor.id,
      kind: 'agent',
    });
    const other = await owner(env, '別の会話');
    env.d.ctx.service('policy').createGrant(
      {
        subject: { kind: 'session', sessionId: supervisor.id },
        permissions: ['schedule.*', 'session.get'],
        lifetime: 'session',
        limits,
      },
      HUMAN,
    );
    const budget = env.d.ctx.service('budget').createRoot({
      subject: { kind: 'session', id: supervisor.id },
      limitUsd: 3,
      actor: HUMAN,
    });
    const actor = actorOf(insertRun(env.d.ctx, { sessionId: supervisor.id }));
    return { supervisor, child, other, budget, actor };
  }

  function aiCreate(env: Env, actor: ReturnType<typeof actorOf>, sessionId: string, extra = {}) {
    return env.d.call(actor, 'schedule.create', {
      sessionId,
      prompt: '競合の価格を調べて',
      trigger: { kind: 'cron', expr: '0 9 * * 1' },
      ...extra,
    });
  }

  it('permission and owner range: its own tree only', async () => {
    const env = await setup();
    const t = await aiTree(env);
    const own = await aiCreate(env, t.actor, t.supervisor.id);
    expect(own.createdBy).toEqual(t.actor);
    expect(await codeOf(aiCreate(env, t.actor, t.child.id))).toBe('ok');
    expect(await codeOf(aiCreate(env, t.actor, t.other.id))).toBe('forbidden');

    // An agent without the permission.
    const plain = await owner(env, 'plain');
    env.d.ctx
      .service('policy')
      .createGrant(
        {
          subject: { kind: 'session', sessionId: plain.id },
          permissions: ['session.get'],
          lifetime: 'session',
        },
        HUMAN,
      );
    const plainActor = actorOf(insertRun(env.d.ctx, { sessionId: plain.id }));
    expect(await codeOf(aiCreate(env, plainActor, plain.id))).toBe('forbidden');

    // Listing without a filter shows only its own tree.
    await daily9(env, t.other.id);
    const listed = await env.d.call(t.actor, 'schedule.list', {});
    expect(listed.items.map((s) => s.sessionId).sort()).toEqual(
      [t.supervisor.id, t.child.id].sort(),
    );
  });

  it('maxSchedules and no supervise', async () => {
    const env = await setup();
    const t = await aiTree(env, { maxSchedules: 2 });
    await aiCreate(env, t.actor, t.supervisor.id);
    const second = await aiCreate(env, t.actor, t.child.id);
    expect(await codeOf(aiCreate(env, t.actor, t.supervisor.id))).toBe('limit_exceeded');
    // A stopped one does not count; turning it back on does.
    await env.d.call(t.actor, 'schedule.update', { scheduleId: second.id, enabled: false });
    const third = await aiCreate(env, t.actor, t.supervisor.id);
    expect(
      await codeOf(
        env.d.call(t.actor, 'schedule.update', { scheduleId: second.id, enabled: true }),
      ),
    ).toBe('limit_exceeded');
    await env.d.call(HUMAN, 'schedule.delete', { scheduleId: third.id });
    expect(
      await codeOf(
        env.d.call(t.actor, 'schedule.update', { scheduleId: second.id, enabled: true }),
      ),
    ).toBe('ok');

    expect(await codeOf(aiCreate(env, t.actor, t.child.id, { run: { supervise: true } }))).toBe(
      'forbidden',
    );
    expect(
      await codeOf(
        env.d.call(t.actor, 'schedule.update', { scheduleId: second.id, run: { supervise: true } }),
      ),
    ).toBe('forbidden');
    // Humans may let a fired child lead children of its own.
    const human = await daily9(env, t.supervisor.id, { run: { supervise: true } });
    expect(human.run.supervise).toBe(true);
  });

  it("each firing carves its budget from the creator's budget; too little → failed_to_start + attention", async () => {
    const env = await setup();
    const t = await aiTree(env);
    const open = vi.spyOn(env.d.ctx.service('attention'), 'open');
    const s = await aiCreate(env, t.actor, t.supervisor.id, {
      run: { budgetUsd: 2 },
      trigger: { kind: 'cron', expr: '0 9 * * *' },
    });
    await wake(env, '2026-11-05T00:00:00Z');
    expect(env.spawner.calls[0]!.opts?.budget).toEqual({
      parentBudgetId: t.budget.id,
      limitUsd: 2,
    });
    expect(env.d.ctx.service('budget').get(t.budget.id).allocatedUsd).toBe(2);
    finish(env, get(env, s.id).lastRun!.sessionId!);

    // $1 left of $3: the next firing ($2) cannot start.
    await wake(env, '2026-11-06T00:00:00Z');
    expect(env.spawner.calls).toHaveLength(1);
    expect(get(env, s.id).lastRun).toMatchObject({
      outcome: 'failed_to_start',
      error: expect.stringContaining('予算が足りません'),
    });
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'budget',
        sessionId: t.supervisor.id,
        refs: { budgetId: t.budget.id },
        title: expect.not.stringMatching(/sch_|bud_/),
      }),
    );
    // The regular times go on.
    expect(get(env, s.id).nextRunAt).toBe('2026-11-07T00:00:00.000Z');
  });

  it("an AI cannot change, run or delete a person's schedule; a person can stop an AI's", async () => {
    const env = await setup();
    const t = await aiTree(env);
    const human = await daily9(env, t.supervisor.id);
    for (const call of [
      env.d.call(t.actor, 'schedule.update', { scheduleId: human.id, run: { budgetUsd: 100 } }),
      env.d.call(t.actor, 'schedule.runNow', { scheduleId: human.id }),
      env.d.call(t.actor, 'schedule.delete', { scheduleId: human.id }),
    ]) {
      expect(await codeOf(call)).toBe('forbidden');
    }
    expect(await codeOf(env.d.call(t.actor, 'schedule.get', { scheduleId: human.id }))).toBe('ok');
    const ai = await aiCreate(env, t.actor, t.supervisor.id);
    const stopped = await env.d.call(HUMAN, 'schedule.update', {
      scheduleId: ai.id,
      enabled: false,
    });
    expect(stopped.enabled).toBe(false);
    await env.d.call(HUMAN, 'schedule.delete', { scheduleId: ai.id });
  });
});

describe('6. schedule.runNow', () => {
  it('fires now without moving the regular times; overlap and spawn errors are errors', async () => {
    const env = await setup();
    const o = await owner(env);
    const s = await daily9(env, o.id);
    const { sessionId } = await env.d.call(HUMAN, 'schedule.runNow', { scheduleId: s.id });
    expect(env.spawner.calls[0]!.params.title).toBe('週次レポート · 11/4 21:00');
    expect(get(env, s.id)).toMatchObject({
      nextRunAt: '2026-11-05T00:00:00.000Z',
      lastRun: { sessionId, outcome: 'started', scheduledFor: '2026-11-04T12:00:00.000Z' },
    });
    expect(await codeOf(env.d.call(HUMAN, 'schedule.runNow', { scheduleId: s.id }))).toBe(
      'conflict',
    );
    finish(env, sessionId);
    env.spawner.failWith = budgetExceeded('予算が足りません');
    expect(await codeOf(env.d.call(HUMAN, 'schedule.runNow', { scheduleId: s.id }))).toBe(
      'budget_exceeded',
    );
    expect(get(env, s.id).lastRun).toMatchObject({ outcome: 'failed_to_start' });
  });

  it('an archived owner does not fire', async () => {
    const env = await setup();
    const o = await owner(env);
    const s = await daily9(env, o.id);
    await env.d.call(HUMAN, 'session.archive', { sessionId: o.id });
    expect(await codeOf(env.d.call(HUMAN, 'schedule.runNow', { scheduleId: s.id }))).toBe(
      'conflict',
    );
    expect(env.spawner.calls).toHaveLength(0);
  });
});

describe('list and update', () => {
  it('lists by owner, tree and enabled, soonest first', async () => {
    const env = await setup();
    const root = await owner(env, 'root');
    const child = await env.d.call(HUMAN, 'session.create', { parentSessionId: root.id });
    const later = await daily9(env, root.id);
    const sooner = await env.d.call(HUMAN, 'schedule.create', {
      sessionId: child.id,
      prompt: '毎時',
      trigger: { kind: 'cron', expr: '0 * * * *' },
    });
    const off = await daily9(env, child.id, { enabled: false });
    expect(off.nextRunAt).toBeNull();
    const ids = (r: { items: Schedule[] }) => r.items.map((s) => s.id);
    expect(ids(await env.d.call(HUMAN, 'schedule.list', {}))).toEqual([
      sooner.id,
      later.id,
      off.id,
    ]);
    expect(ids(await env.d.call(HUMAN, 'schedule.list', { rootSessionId: root.id }))).toEqual([
      sooner.id,
      later.id,
      off.id,
    ]);
    expect(
      ids(await env.d.call(HUMAN, 'schedule.list', { sessionId: child.id, enabled: true })),
    ).toEqual([sooner.id]);
  });

  it('changing the trigger recomputes the next time; unchanged fields emit nothing', async () => {
    const env = await setup();
    const o = await owner(env);
    const s = await daily9(env, o.id);
    const moved = await env.d.call(HUMAN, 'schedule.update', {
      scheduleId: s.id,
      trigger: { kind: 'cron', expr: '30 22 * * *' },
      prompt: '新しい依頼',
    });
    expect(moved).toMatchObject({ prompt: '新しい依頼', nextRunAt: '2026-11-04T13:30:00.000Z' });
    expect(env.timers.delay).toBe(1.5 * HOUR);
    const before = env.d.ctx.bus.list({ types: ['schedule.updated'] }).events.length;
    await env.d.call(HUMAN, 'schedule.update', { scheduleId: s.id, prompt: '新しい依頼' });
    expect(env.d.ctx.bus.list({ types: ['schedule.updated'] }).events).toHaveLength(before);
  });
});
