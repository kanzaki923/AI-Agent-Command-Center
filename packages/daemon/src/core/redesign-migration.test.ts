/**
 * T0 acceptance (spec 20261029 §5.2): a database written by the daemon before the session-tree
 * redesign starts, is backed up, and reads in the new schema; the startup backfills fill the
 * tree, the usage ledger, attention items and states.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LedgerStore, dayOf } from '../cost';
import { modules } from '../modules';
import { HUMAN, createTestDaemon, type TestDaemonNoServer } from '../testing';
import { DAEMON_VERSION } from '../version';
import { backfillSessionTree, runOnce } from './backfills';
import { systemClock } from './clock';
import { type Db, type SqlValue, openDb } from './db';
import { createIdGenerator } from './ids';
import { coreMigrations, runMigrations } from './migrations';

/** Every migration that existed before the redesign (the schema of an older acc.sqlite). */
const OLD_MIGRATION_IDS = [
  'core/0001_init',
  'sessions/0001_fts',
  'policy/0001_budget_reservations',
  'runtime/0001_state',
  'runtime/0002_permission_rules',
];

const homes: string[] = [];
const daemons: TestDaemonNoServer[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 5 });
});

function insertRow(db: Db, table: string, cols: Record<string, SqlValue>, data: object) {
  const names = [...Object.keys(cols), 'data'];
  db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, [
    ...Object.values(cols),
    JSON.stringify(data),
  ]);
}

const usage = (costUsd: number) => ({
  inputTokens: Math.round(costUsd * 1000),
  outputTokens: 10,
  costUsd,
  costSource: 'estimated' as const,
});

/**
 * Write an "old" acc.sqlite: the pre-redesign schema and rows shaped like the old zod
 * schemas (no tree fields, non-null task / workspace projects, run-lifetime session grant).
 */
function writeOldDatabase(home: string) {
  const ids = createIdGenerator(systemClock);
  const now = new Date().toISOString();
  const db = openDb(join(home, 'acc.sqlite'));
  const all = [...coreMigrations, ...modules.flatMap((m) => m.migrations ?? [])];
  runMigrations(
    db,
    all.filter((m) => OLD_MIGRATION_IDS.includes(m.id)),
    () => now,
  );

  const prj = ids.next('project');
  insertRow(
    db,
    'projects',
    { id: prj, name: 'p', archived_at: null, created_at: now, updated_at: now },
    {
      id: prj,
      name: 'p',
      description: null,
      repoPath: null,
      defaultBranch: null,
      defaultModel: null,
      testCommand: null,
      commitAuthor: null,
      permissionProfile: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    },
  );

  const session = (id: string, parent: string | null, kind: 'chat' | 'agent') =>
    insertRow(
      db,
      'sessions',
      {
        id,
        project_id: prj,
        kind,
        task_id: null,
        parent_session_id: parent,
        archived_at: null,
        last_activity_at: now,
        created_at: now,
        updated_at: now,
      },
      {
        id,
        projectId: prj,
        kind,
        title: id.slice(-4),
        model: null,
        runtime: null,
        systemPrompt: null,
        workspaceId: null,
        taskId: null,
        parentSessionId: parent,
        activeRunId: null,
        pinned: false,
        createdBy: HUMAN,
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        archivedAt: null,
      },
    );
  const root = ids.next('session');
  const child = ids.next('session');
  const grandchild = ids.next('session');
  const other = ids.next('session');
  session(root, null, 'chat');
  session(child, root, 'agent');
  session(grandchild, child, 'agent');
  session(other, null, 'chat');

  const ws = ids.next('workspace');
  insertRow(
    db,
    'workspaces',
    {
      id: ws,
      project_id: prj,
      task_id: null,
      status: 'ready',
      locked_by_run_id: null,
      created_at: now,
      updated_at: now,
    },
    {
      id: ws,
      projectId: prj,
      kind: 'worktree',
      status: 'ready',
      path: join(home, 'wt'),
      branch: 'acc/x',
      baseRef: 'main',
      taskId: null,
      lockedByRunId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    },
  );

  const task = (status: string, assignee: string | null) => {
    const id = ids.next('task');
    insertRow(
      db,
      'tasks',
      {
        id,
        project_id: prj,
        parent_task_id: null,
        status,
        assignee_session_id: assignee,
        created_at: now,
        updated_at: now,
      },
      {
        id,
        projectId: prj,
        parentTaskId: null,
        title: `task ${status}`,
        description: '',
        acceptanceCriteria: [],
        status,
        statusReason: null,
        priority: 'normal',
        dependsOn: [],
        assigneeSessionId: assignee,
        workspaceId: null,
        resultSummary: null,
        createdBy: HUMAN,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      },
    );
    return id;
  };
  const failedTask = task('failed', grandchild);
  task('review', child);
  task('done', null);

  const run = (sessionId: string, kind: string, status: string, cost: number) => {
    const id = ids.next('run');
    insertRow(
      db,
      'runs',
      {
        id,
        session_id: sessionId,
        project_id: prj,
        task_id: null,
        kind,
        status,
        parent_run_id: null,
        created_at: now,
        updated_at: now,
      },
      {
        id,
        sessionId,
        projectId: prj,
        taskId: null,
        kind,
        status,
        statusReason: null,
        model: 'mock/echo',
        runtime: null,
        workspaceId: null,
        parentRunId: null,
        retryOfRunId: null,
        attempt: 1,
        budgetId: null,
        triggerMessageId: null,
        usage:
          cost > 0
            ? usage(cost)
            : { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'unknown' },
        error: null,
        createdBy: HUMAN,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        endedAt: status === 'running' ? null : now,
      },
    );
    return id;
  };
  run(root, 'chat', 'completed', 0.5);
  run(child, 'agent', 'completed', 0.25);
  run(grandchild, 'agent', 'failed', 0.125);
  run(other, 'chat', 'running', 0.0625); // cut off by the "crash": recovery interrupts it
  run(other, 'chat', 'completed', 0); // no usage: no ledger row

  const msg = ids.next('message');
  insertRow(
    db,
    'messages',
    { id: msg, session_id: root, run_id: null, created_at: now },
    {
      id: msg,
      sessionId: root,
      runId: null,
      role: 'user',
      content: [{ type: 'text', text: 'こんにちは' }],
      author: HUMAN,
      model: null,
      createdAt: now,
    },
  );

  const art = ids.next('artifact');
  insertRow(
    db,
    'artifacts',
    {
      id: art,
      kind: 'note',
      project_id: prj,
      session_id: child,
      run_id: null,
      task_id: null,
      created_at: now,
    },
    {
      id: art,
      kind: 'note',
      projectId: prj,
      sessionId: child,
      runId: null,
      taskId: null,
      workspaceId: null,
      title: 'メモ',
      createdBy: HUMAN,
      createdAt: now,
      data: { text: 'x' },
    },
  );

  const apr = ids.next('approval');
  insertRow(
    db,
    'approvals',
    {
      id: apr,
      status: 'pending',
      project_id: prj,
      session_id: child,
      run_id: null,
      task_id: null,
      created_at: now,
    },
    {
      id: apr,
      kind: 'integration',
      status: 'pending',
      title: 'テストを実行',
      detail: null,
      payload: null,
      projectId: prj,
      sessionId: child,
      runId: null,
      taskId: null,
      integrationId: null,
      requestedBy: HUMAN,
      resolvedBy: null,
      resolutionNote: null,
      createdAt: now,
      resolvedAt: null,
    },
  );

  const grant = ids.next('grant');
  insertRow(
    db,
    'grants',
    {
      id: grant,
      subject_kind: 'session',
      subject_id: root,
      parent_grant_id: null,
      revoked_at: null,
      created_at: now,
    },
    {
      id: grant,
      subject: { kind: 'session', sessionId: root },
      parentGrantId: null,
      permissions: ['session.get'],
      scope: {},
      limits: { maxWorkers: 2 },
      depth: 0,
      lifetime: 'run',
      expiresAt: null,
      revokedAt: null,
      reason: null,
      grantedBy: HUMAN,
      createdAt: now,
    },
  );

  const before = {
    tasks: db.all<{ id: string; project_id: string }>(
      'SELECT id, project_id FROM tasks ORDER BY id',
    ),
    workspaces: db.all<{ id: string; project_id: string }>(
      'SELECT id, project_id FROM workspaces ORDER BY id',
    ),
  };
  db.close();
  return { prj, root, child, grandchild, other, ws, failedTask, apr, grant, before };
}

async function startOn(home: string) {
  const d = await createTestDaemon({ home });
  daemons.push(d);
  return d;
}

describe('migrating an older database', () => {
  it('backs it up, keeps every row readable and preserves tasks / workspaces', async () => {
    const home = mkdtempSync(join(tmpdir(), 'acc-migrate-'));
    homes.push(home);
    const old = writeOldDatabase(home);

    const d = await startOn(home);
    const { repos } = d.ctx;

    // Backup taken before the tables were rebuilt: still the old schema and rows.
    const backup = join(home, `acc.sqlite.bak-${DAEMON_VERSION}`);
    expect(existsSync(backup)).toBe(true);
    const bak = openDb(backup);
    try {
      expect(bak.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n).toBe(3);
      expect(
        bak.get('SELECT id FROM schema_migrations WHERE id = ?', ['core/0002_nullable_project']),
      ).toBeUndefined();
    } finally {
      bak.close();
    }

    // Every row parses with the new schemas.
    for (const repo of [
      repos.projects,
      repos.workspaces,
      repos.sessions,
      repos.messages,
      repos.tasks,
      repos.runs,
      repos.artifacts,
      repos.integrations,
      repos.approvals,
      repos.grants,
      repos.budgets,
    ]) {
      expect(() => repo.find({})).not.toThrow();
    }
    expect(repos.sessions.count()).toBe(4);
    expect(repos.runs.count()).toBe(5);
    const note = repos.artifacts.find({})[0]!;
    expect(note).toMatchObject({ kind: 'note', role: 'output', review: { state: 'none' } });
    expect(repos.messages.find({})[0]).toMatchObject({ delivery: 'delivered', meta: null });
    expect(repos.tasks.find({}).every((t) => t.autoStart)).toBe(true);

    // tasks / workspaces were rebuilt with their rows and projects intact, now NULL-able.
    const rows = (table: string) =>
      d.ctx.db.all<{ id: string; project_id: string }>(
        `SELECT id, project_id FROM ${table} ORDER BY id`,
      );
    expect(rows('tasks')).toEqual(old.before.tasks);
    expect(rows('workspaces')).toEqual(old.before.workspaces);
    const now = d.ctx.clock.iso();
    const orphan = repos.tasks.insert({
      id: d.ctx.ids.next('task'),
      projectId: null,
      parentTaskId: null,
      title: 'no project',
      description: '',
      acceptanceCriteria: [],
      status: 'ready',
      statusReason: null,
      priority: 'normal',
      dependsOn: [],
      assigneeSessionId: null,
      workspaceId: null,
      resultSummary: null,
      createdBy: HUMAN,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    expect(repos.tasks.require(orphan.id).projectId).toBeNull();

    // A session's run-lifetime grant reads as `work` and survives the restart (D17).
    expect(repos.grants.require(old.grant).revokedAt).toBeNull();
  });

  it('fills the session tree (three levels), column and JSON', async () => {
    const home = mkdtempSync(join(tmpdir(), 'acc-migrate-'));
    homes.push(home);
    const old = writeOldDatabase(home);
    const d = await startOn(home);
    const rootOf = (id: string) => ({
      json: d.ctx.repos.sessions.require(id).rootSessionId,
      column: d.ctx.db.get<{ r: string }>(
        'SELECT root_session_id AS r FROM sessions WHERE id = ?',
        [id],
      )!.r,
    });
    for (const id of [old.root, old.child, old.grandchild]) {
      expect(rootOf(id)).toEqual({ json: old.root, column: old.root });
    }
    expect(rootOf(old.other)).toEqual({ json: old.other, column: old.other });
    expect(
      d.ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sessions WHERE json_extract(data, '$.rootSessionId') IS NULL",
      )!.n,
    ).toBe(0);
    // New sessions under the tree get the root without a backfill.
    const later = await d.call(HUMAN, 'session.create', { parentSessionId: old.grandchild });
    expect(later.rootSessionId).toBe(old.root);
  });

  it('backfills the usage ledger from ended runs, once, and totals Session.cost up the tree', async () => {
    const home = mkdtempSync(join(tmpdir(), 'acc-migrate-'));
    homes.push(home);
    const old = writeOldDatabase(home);
    const d = await startOn(home);
    const store = new LedgerStore(d.ctx.db);
    const ledger = store.rows();
    const runs = d.ctx.repos.runs.find({});
    const spent = runs.reduce((n, r) => n + r.usage.costUsd, 0);
    expect(ledger).toHaveLength(4); // the zero-usage run has no row
    expect(ledger.reduce((n, r) => n + r.cost_micro, 0)).toBe(Math.round(spent * 1e6));
    const interrupted = runs.find((r) => r.status === 'interrupted')!;
    const row = ledger.find((r) => r.run_id === interrupted.id)!;
    expect(row).toMatchObject({
      session_id: old.other,
      root_session_id: old.other,
      component: 'llm',
      source: 'estimated',
      day: dayOf(interrupted.endedAt!, d.ctx.settings.get().limits.timezone),
    });
    expect(ledger.find((r) => r.session_id === old.child)?.component).toBe('agent');

    const cost = (id: string) => d.ctx.repos.sessions.require(id).cost;
    expect(cost(old.root)).toEqual({ ownUsd: 0.5, treeUsd: 0.875, source: 'estimated' });
    expect(cost(old.child)).toEqual({ ownUsd: 0.25, treeUsd: 0.375, source: 'estimated' });
    expect(cost(old.grandchild)).toEqual({ ownUsd: 0.125, treeUsd: 0.125, source: 'estimated' });
    expect(d.ctx.service('ledger').usedToday()).toBeCloseTo(spent, 6);

    // Idempotent: a second start adds nothing.
    await d.close();
    daemons.splice(daemons.indexOf(d), 1);
    const d2 = await startOn(home);
    expect(new LedgerStore(d2.ctx.db).rows()).toHaveLength(4);
    expect(d2.ctx.repos.sessions.require(old.root).cost.treeUsd).toBe(0.875);
  });

  it('opens attention for what already waited on a human and derives states once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'acc-migrate-'));
    homes.push(home);
    const old = writeOldDatabase(home);
    const d = await startOn(home);
    const items = d.ctx.repos.attention.find({ direction: 'asc' });
    expect(items.map((a) => [a.kind, a.sessionId, a.rootSessionId])).toEqual([
      ['approval', old.child, old.root],
      ['failure', old.grandchild, old.root],
      ['review', old.child, old.root],
    ]);
    expect(items[0]).toMatchObject({
      status: 'open',
      title: 'テストを実行',
      refs: { approvalId: old.apr },
      choices: [{ id: 'approve' }, { id: 'reject' }],
    });
    expect(items[1]!.refs.taskId).toBe(old.failedTask);
    expect(items.every((a) => a.title.length <= 80 && a.priority > 0)).toBe(true);

    const state = (id: string) => d.ctx.repos.sessions.require(id).state;
    expect(state(old.child)).toBe('needs_you');
    expect(state(old.grandchild)).toBe('failed');
    expect(state(old.root)).toBe('idle');
    expect(
      d.ctx.db.get<{ s: string }>('SELECT state AS s FROM sessions WHERE id = ?', [old.child])!.s,
    ).toBe('needs_you');

    // Run once: a restart does not duplicate the items.
    await d.close();
    daemons.splice(daemons.indexOf(d), 1);
    const d2 = await startOn(home);
    expect(d2.ctx.repos.attention.count()).toBe(3);
  });

  it('a fresh database needs no backup', async () => {
    const home = mkdtempSync(join(tmpdir(), 'acc-migrate-'));
    homes.push(home);
    await startOn(home);
    expect(existsSync(join(home, `acc.sqlite.bak-${DAEMON_VERSION}`))).toBe(false);
  });

  it('an older config.json reads its renamed settings; the new ones update and show', async () => {
    const home = mkdtempSync(join(tmpdir(), 'acc-migrate-'));
    homes.push(home);
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ maxConcurrentRuns: 3, autoResumeOrchestrators: false }),
    );
    const d = await startOn(home);
    expect(d.ctx.settings.get()).toMatchObject({
      maxConcurrentRuns: 3,
      maxConcurrentAgents: 3,
      maxConcurrentChats: 16,
      autoResume: false,
      limits: { dailyUsd: 20 },
    });
    const view = await d.call(HUMAN, 'settings.update', {
      limits: { dailyUsd: null, timezone: 'Asia/Tokyo' },
      maxConcurrentChats: 8,
    });
    expect(view).toMatchObject({
      limits: { dailyUsd: null, timezone: 'Asia/Tokyo' },
      maxConcurrentAgents: 3,
      maxConcurrentChats: 8,
      autoResume: false,
    });
  });
});

describe('core backfill helpers', () => {
  it('a missing parent or a parent cycle ends the walk instead of looping', () => {
    const db = openDb(':memory:');
    try {
      runMigrations(db, coreMigrations, () => new Date().toISOString());
      const add = (id: string, parent: string | null) =>
        db.run(
          `INSERT INTO sessions (id, project_id, kind, task_id, parent_session_id, archived_at,
             last_activity_at, created_at, updated_at, data)
           VALUES (?, NULL, 'chat', NULL, ?, NULL, 't', 't', 't', ?)`,
          [id, parent, JSON.stringify({ id, parentSessionId: parent })],
        );
      add('a', 'gone'); // parent was deleted
      add('b', 'a');
      add('x', 'y'); // x <-> y
      add('y', 'x');
      expect(backfillSessionTree(db)).toBe(4);
      const roots = Object.fromEntries(
        db
          .all<{ id: string; r: string }>('SELECT id, root_session_id AS r FROM sessions')
          .map((r) => [r.id, r.r]),
      );
      expect(roots).toMatchObject({ a: 'a', b: 'a' });
      expect(roots.x === roots.y).toBe(true);
      expect(backfillSessionTree(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('runOnce runs a step exactly once', () => {
    const db = openDb(':memory:');
    try {
      runMigrations(db, [], () => 't');
      let n = 0;
      expect(runOnce(db, 'backfill/test/x', 't', () => n++)).toBe(true);
      expect(runOnce(db, 'backfill/test/x', 't', () => n++)).toBe(false);
      expect(n).toBe(1);
    } finally {
      db.close();
    }
  });
});
