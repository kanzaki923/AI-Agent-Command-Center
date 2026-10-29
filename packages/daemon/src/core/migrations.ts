import { existsSync } from 'node:fs';
import type { Db } from './db';

/**
 * A schema migration. IDs are globally unique strings namespaced by owner:
 * `core/0001_init`, `sessions/0001_fts`, ... They are applied once, in list order
 * (core first, then each module's `migrations` in `modules.ts` order) and recorded in
 * `schema_migrations`. Never edit a migration that has shipped; add a new one.
 */
export interface Migration {
  id: string;
  sql: string;
  /**
   * The migration rebuilds tables (CREATE new → copy → DROP → RENAME). Before the first such
   * pending migration runs on an existing database, `runMigrations` calls `beforeRebuild`
   * (the daemon copies acc.sqlite to acc.sqlite.bak-<version>; downgrades are unsupported).
   */
  rebuildsTables?: boolean;
}

/**
 * Entity tables share one shape: indexed columns for filtering/sorting plus `data`, the full
 * JSON entity (validated by zod on write and read). Adding a field to an entity needs no
 * migration; adding a filterable column does.
 */
export const coreMigrations: Migration[] = [
  {
    id: 'core/0001_init',
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  status TEXT NOT NULL,
  locked_by_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX workspaces_project ON workspaces(project_id);
CREATE INDEX workspaces_task ON workspaces(task_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  kind TEXT NOT NULL,
  task_id TEXT,
  parent_session_id TEXT,
  archived_at TEXT,
  last_activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX sessions_project ON sessions(project_id);
CREATE INDEX sessions_activity ON sessions(last_activity_at, id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX messages_session ON messages(session_id, id);
CREATE INDEX messages_run ON messages(run_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_task_id TEXT,
  status TEXT NOT NULL,
  assignee_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX tasks_project ON tasks(project_id, status);
CREATE INDEX tasks_parent ON tasks(parent_task_id);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  parent_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX runs_session ON runs(session_id, id);
CREATE INDEX runs_task ON runs(task_id);
CREATE INDEX runs_status ON runs(status);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT,
  run_id TEXT,
  task_id TEXT,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX artifacts_run ON artifacts(run_id);
CREATE INDEX artifacts_task ON artifacts(task_id);

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX integrations_project ON integrations(project_id);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT,
  run_id TEXT,
  task_id TEXT,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX approvals_status ON approvals(status);
CREATE INDEX approvals_run ON approvals(run_id);

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  parent_grant_id TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX grants_subject ON grants(subject_kind, subject_id);
CREATE INDEX grants_parent ON grants(parent_grant_id);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  subject_kind TEXT NOT NULL,
  subject_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX budgets_parent ON budgets(parent_id);
CREATE INDEX budgets_subject ON budgets(subject_kind, subject_id);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  ts TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT,
  run_id TEXT,
  task_id TEXT,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX events_session ON events(session_id, seq);
CREATE INDEX events_run ON events(run_id, seq);
CREATE INDEX events_task ON events(task_id, seq);
CREATE INDEX events_project ON events(project_id, seq);
CREATE INDEX events_type ON events(type, seq);
`,
  },
  {
    // Work outside any project (spawned children, scratch folders): project_id becomes NULL-able.
    id: 'core/0002_nullable_project',
    rebuildsTables: true,
    sql: `
CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  parent_task_id TEXT,
  status TEXT NOT NULL,
  assignee_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
INSERT INTO tasks_new (id, project_id, parent_task_id, status, assignee_session_id, created_at, updated_at, data)
  SELECT id, project_id, parent_task_id, status, assignee_session_id, created_at, updated_at, data FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX tasks_project ON tasks(project_id, status);
CREATE INDEX tasks_parent ON tasks(parent_task_id);
CREATE INDEX tasks_assignee ON tasks(assignee_session_id);

CREATE TABLE workspaces_new (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  task_id TEXT,
  status TEXT NOT NULL,
  locked_by_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
INSERT INTO workspaces_new (id, project_id, task_id, status, locked_by_run_id, created_at, updated_at, data)
  SELECT id, project_id, task_id, status, locked_by_run_id, created_at, updated_at, data FROM workspaces;
DROP TABLE workspaces;
ALTER TABLE workspaces_new RENAME TO workspaces;
CREATE INDEX workspaces_project ON workspaces(project_id);
CREATE INDEX workspaces_task ON workspaces(task_id);
`,
  },
  {
    // Session trees: every session knows its root; the daemon keeps a derived state.
    // Existing rows are filled by the startup backfill (core/backfills.ts).
    id: 'core/0003_session_tree',
    sql: `
ALTER TABLE sessions ADD COLUMN root_session_id TEXT;
ALTER TABLE sessions ADD COLUMN state TEXT;
CREATE INDEX sessions_root ON sessions(root_session_id);
CREATE INDEX sessions_parent ON sessions(parent_session_id);
`,
  },
];

export interface RunMigrationsOptions {
  /** Called once, outside any transaction, before the first pending table rebuild. */
  beforeRebuild?: () => void;
}

/** Apply pending migrations. Returns the ids applied in this call. */
export function runMigrations(
  db: Db,
  migrations: readonly Migration[],
  nowIso: () => string,
  opts: RunMigrationsOptions = {},
): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    db.all<{ id: string }>('SELECT id FROM schema_migrations').map((r) => r.id),
  );
  const seen = new Set<string>();
  const ran: string[] = [];
  let backedUp = false;
  for (const m of migrations) {
    if (seen.has(m.id)) throw new Error(`Duplicate migration id: ${m.id}`);
    seen.add(m.id);
    if (applied.has(m.id)) continue;
    // A fresh database has nothing to lose; an existing one is copied before tables are rebuilt.
    if (m.rebuildsTables && !backedUp && applied.size > 0) {
      backedUp = true;
      opts.beforeRebuild?.();
    }
    db.transaction(() => {
      db.exec(m.sql);
      db.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [m.id, nowIso()]);
    });
    ran.push(m.id);
  }
  return ran;
}

/**
 * Copy the database to `<path>.bak-<version>` (`-2`, `-3`, ... when taken) with
 * `VACUUM INTO`, which writes a consistent snapshot including the WAL. Returns the path.
 */
export function backupDatabase(db: Db, dbPath: string, version: string): string {
  let target = `${dbPath}.bak-${version}`;
  for (let n = 2; existsSync(target); n++) target = `${dbPath}.bak-${version}-${n}`;
  db.run('VACUUM INTO ?', [target]);
  return target;
}
