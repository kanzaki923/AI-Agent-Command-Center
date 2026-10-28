import { ProjectId, SessionId, type Session } from '@acc/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createManualClock } from './clock';
import { type Db, openDb } from './db';
import { EventBus, deriveRefs } from './events';
import { createIdGenerator } from './ids';
import { silentLogger } from './log';
import { coreMigrations, runMigrations } from './migrations';
import { createRepos } from './repos';

function setup() {
  const clock = createManualClock();
  const db = openDb(':memory:');
  runMigrations(db, coreMigrations, () => clock.iso());
  const ids = createIdGenerator(clock);
  const repos = createRepos(db);
  const bus = new EventBus(db, ids, clock, silentLogger);
  return { clock, db, ids, repos, bus };
}

let opened: Db[] = [];
function track<T extends { db: Db }>(x: T): T {
  opened.push(x.db);
  return x;
}
afterEach(() => {
  for (const db of opened) db.close();
  opened = [];
});

function makeSession(
  ids: ReturnType<typeof createIdGenerator>,
  iso: string,
  patch: Partial<Session> = {},
): Session {
  return {
    id: ids.next('session'),
    projectId: null,
    kind: 'chat',
    title: 't',
    model: null,
    runtime: null,
    systemPrompt: null,
    workspaceId: null,
    taskId: null,
    parentSessionId: null,
    activeRunId: null,
    pinned: false,
    createdBy: { kind: 'human' },
    createdAt: iso,
    updatedAt: iso,
    lastActivityAt: iso,
    archivedAt: null,
    ...patch,
  };
}

describe('ids', () => {
  it('are valid, prefixed and strictly increasing within one ms', () => {
    const clock = createManualClock();
    const ids = createIdGenerator(clock);
    const a = Array.from({ length: 1000 }, () => ids.next('session'));
    for (const id of a) expect(SessionId.safeParse(id).success).toBe(true);
    expect([...a].sort()).toEqual(a);
    expect(new Set(a).size).toBe(a.length);
  });

  it('sort by time across milliseconds, even if the clock goes back', () => {
    const clock = createManualClock();
    const ids = createIdGenerator(clock);
    const first = ids.next('project');
    clock.advance(5);
    const second = ids.next('project');
    clock.advance(-100);
    const third = ids.next('project');
    expect(ProjectId.parse(first) < second).toBe(true);
    expect(second < third).toBe(true);
  });
});

describe('db', () => {
  it('runs afterCommit hooks only after the outermost commit', () => {
    const { db } = track(setup());
    const calls: string[] = [];
    db.transaction(() => {
      db.afterCommit(() => calls.push('outer'));
      db.transaction(() => db.afterCommit(() => calls.push('inner')));
      expect(calls).toEqual([]);
    });
    expect(calls).toEqual(['outer', 'inner']);
  });

  it('drops hooks and writes of a rolled back savepoint only', () => {
    const { db } = track(setup());
    const calls: string[] = [];
    db.exec('CREATE TABLE t (x TEXT)');
    db.transaction(() => {
      db.run('INSERT INTO t VALUES (?)', ['kept']);
      expect(() =>
        db.transaction(() => {
          db.run('INSERT INTO t VALUES (?)', ['dropped']);
          db.afterCommit(() => calls.push('inner'));
          throw new Error('boom');
        }),
      ).toThrow('boom');
      db.afterCommit(() => calls.push('outer'));
    });
    expect(db.all<{ x: string }>('SELECT x FROM t').map((r) => r.x)).toEqual(['kept']);
    expect(calls).toEqual(['outer']);
  });

  it('runs hooks in registration order even when a hook commits another transaction', () => {
    const { db } = track(setup());
    const calls: string[] = [];
    db.transaction(() => {
      db.afterCommit(() => calls.push('a'));
      // e.g. a run started inside a transaction is launched by a hook that writes again.
      db.afterCommit(() => {
        calls.push('launch');
        db.transaction(() => db.afterCommit(() => calls.push('launch-event')));
        db.afterCommit(() => calls.push('launch-direct'));
      });
      db.afterCommit(() => calls.push('b'));
    });
    expect(calls).toEqual(['a', 'launch', 'b', 'launch-event', 'launch-direct']);
    // Outside any transaction and hook, afterCommit still runs immediately.
    db.afterCommit(() => calls.push('now'));
    expect(calls.at(-1)).toBe('now');
  });

  it('rejects async transaction callbacks', () => {
    const { db } = track(setup());
    expect(() => db.transaction(() => Promise.resolve(1))).toThrow(/synchronous/);
  });

  it('migrations are idempotent', () => {
    const { db, clock } = track(setup());
    expect(runMigrations(db, coreMigrations, () => clock.iso())).toEqual([]);
  });
});

describe('repositories', () => {
  it('insert/get/require/update round-trip with validation', () => {
    const { repos, ids, clock } = track(setup());
    const s = repos.sessions.insert(makeSession(ids, clock.iso()));
    expect(repos.sessions.get(s.id)).toEqual(s);
    const updated = repos.sessions.update(s.id, (cur) => ({ ...cur, title: 'renamed' }));
    expect(repos.sessions.require(s.id).title).toBe('renamed');
    expect(updated.title).toBe('renamed');
    expect(() => repos.sessions.require(ids.next('session'))).toThrow(/not found/);
    expect(() => repos.sessions.insert({ ...s, id: 'bad' })).toThrow();
  });

  it('filters by columns (=, IN, IS NULL) and pages with a cursor', () => {
    const { repos, ids, clock } = track(setup());
    const prj = ids.next('project');
    const all: Session[] = [];
    for (let i = 0; i < 7; i++) {
      clock.advance(1000);
      all.push(
        repos.sessions.insert(
          makeSession(ids, clock.iso(), {
            projectId: i % 2 === 0 ? prj : null,
            kind: i < 3 ? 'agent' : 'chat',
          }),
        ),
      );
    }
    expect(repos.sessions.count({ where: { project_id: prj } })).toBe(4);
    expect(repos.sessions.count({ where: { project_id: null } })).toBe(3);
    expect(repos.sessions.count({ where: { kind: ['agent', 'chat'] } })).toBe(7);
    expect(repos.sessions.count({ where: { kind: [] } })).toBe(0);
    expect(repos.sessions.count({ where: { project_id: { not: null } } })).toBe(4);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = repos.sessions.page({
        orderBy: 'last_activity_at',
        direction: 'desc',
        limit: 3,
        cursor,
      });
      seen.push(...page.items.map((s) => s.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(all.map((s) => s.id).reverse());
  });

  it('rejects unknown columns', () => {
    const { repos } = track(setup());
    expect(() => repos.sessions.find({ where: { 'nope; DROP TABLE x': 1 } })).toThrow(
      /Unknown column/,
    );
  });
});

describe('event bus', () => {
  const actor = { kind: 'system' as const };

  it('assigns monotonic seq and derives refs from payload', () => {
    const { bus, ids, clock, repos } = track(setup());
    const session = repos.sessions.insert(
      makeSession(ids, clock.iso(), { projectId: ids.next('project') }),
    );
    const e1 = bus.emit({ type: 'session.created', actor, payload: { session } });
    const e2 = bus.emit({
      type: 'session.archived',
      actor,
      payload: { sessionId: session.id, archived: true },
    });
    expect(e2.seq).toBe(e1.seq + 1);
    expect(e1.sessionId).toBe(session.id);
    expect(e1.projectId).toBe(session.projectId);
    expect(e2.sessionId).toBe(session.id);
    expect(bus.lastSeq()).toBe(e2.seq);
  });

  it('validates payloads', () => {
    const { bus } = track(setup());
    expect(() =>
      bus.emit({ type: 'settings.updated', actor, payload: { changes: 'x' } as never }),
    ).toThrow();
  });

  it('publishes after commit and never for rolled back events', () => {
    const { bus, db } = track(setup());
    const got: number[] = [];
    bus.subscribe(undefined, (e) => got.push(e.seq));
    db.transaction(() => {
      bus.emit({ type: 'settings.updated', actor, payload: { changes: ['a'] } });
      expect(got).toEqual([]);
    });
    expect(got).toHaveLength(1);
    expect(() =>
      db.transaction(() => {
        bus.emit({ type: 'settings.updated', actor, payload: { changes: ['b'] } });
        throw new Error('rollback');
      }),
    ).toThrow();
    expect(got).toHaveLength(1);
    expect(bus.list().events).toHaveLength(1);
  });

  it('filters live subscriptions and list() by refs and type patterns', () => {
    const { bus, ids } = track(setup());
    const runA = ids.next('run');
    const runB = ids.next('run');
    const live: string[] = [];
    bus.subscribe({ runId: runA, types: ['run.*'] }, (e) => live.push(`${e.type}:${e.runId}`));
    const emitStatus = (runId: string) =>
      bus.emit({
        type: 'run.status_changed',
        actor,
        payload: { runId, from: 'queued', to: 'running', reason: null },
      });
    emitStatus(runA);
    emitStatus(runB);
    bus.emit({ type: 'settings.updated', actor, payload: { changes: [] }, refs: { runId: runA } });
    expect(live).toEqual([`run.status_changed:${runA}`]);

    expect(bus.list({ runId: runB }).events).toHaveLength(1);
    expect(bus.list({ types: ['run.*'] }).events).toHaveLength(2);
    expect(bus.list({ types: ['settings.updated'] }).events).toHaveLength(1);
    expect(bus.list({ types: ['*.updated'] }).events).toHaveLength(1);
  });

  it('pages list() with since/limit/hasMore', () => {
    const { bus } = track(setup());
    for (let i = 0; i < 5; i++)
      bus.emit({ type: 'settings.updated', actor, payload: { changes: [`${i}`] } });
    const p1 = bus.list({ limit: 2 });
    expect(p1.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(p1.hasMore).toBe(true);
    const p2 = bus.list({ since: p1.lastSeq, limit: 10 });
    expect(p2.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(p2.hasMore).toBe(false);
    const p3 = bus.list({ since: p2.lastSeq });
    expect(p3).toEqual({ events: [], lastSeq: 5, hasMore: false });
  });

  it('delivers deltas filtered by session/run and never persists them', () => {
    const { bus, ids } = track(setup());
    const sessionId = ids.next('session');
    const got: string[] = [];
    bus.subscribeDeltas({ sessionId }, (d) => got.push(d.text));
    const base = { runId: ids.next('run'), messageId: ids.next('message'), index: 0 };
    bus.publishDelta({ ...base, sessionId, text: 'hel' });
    bus.publishDelta({ ...base, sessionId: ids.next('session'), text: 'nope' });
    bus.publishDelta({ ...base, sessionId, text: 'lo', index: 1 });
    expect(got).toEqual(['hel', 'lo']);
    expect(bus.lastSeq()).toBe(0);
  });

  it('waitFor resolves on a matching event or null on timeout/abort', async () => {
    const { bus } = track(setup());
    const p = bus.waitFor({ types: ['settings.updated'] }, (e) => e.type === 'settings.updated', {
      timeoutMs: 1000,
    });
    bus.emit({ type: 'settings.updated', actor, payload: { changes: ['x'] } });
    expect((await p)?.type).toBe('settings.updated');

    expect(await bus.waitFor(undefined, () => true, { timeoutMs: 10 })).toBeNull();
    const ac = new AbortController();
    const aborted = bus.waitFor(undefined, () => true, { timeoutMs: 10_000, signal: ac.signal });
    ac.abort();
    expect(await aborted).toBeNull();
  });

  it('deriveRefs reads well-known payload shapes', () => {
    expect(deriveRefs({ run: { id: 'r', sessionId: 's', projectId: 'p', taskId: null } })).toEqual({
      runId: 'r',
      sessionId: 's',
      projectId: 'p',
    });
    expect(deriveRefs({ task: { id: 't', projectId: 'p' } })).toEqual({
      taskId: 't',
      projectId: 'p',
    });
    expect(deriveRefs(null)).toEqual({});
  });
});
