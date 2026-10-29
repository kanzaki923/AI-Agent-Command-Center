import type { Db } from './db';

interface SessionTreeRow {
  id: string;
  parent_session_id: string | null;
  root_session_id: string | null;
  state: string | null;
  json_root: string | null;
}

/**
 * Startup backfill of the session tree (spec 20261029 §1.12-1), run right after migrations
 * and before anything else touches sessions. Idempotent: every session's root is computed by
 * following parents, and rows whose column or JSON disagree are fixed in place (no events —
 * nothing observable changed). A session whose parent is missing, or that sits in a parent
 * cycle, becomes its own root. Rows that never had a `state` column value get the one in
 * their JSON (or `idle`); the derived state is computed later by the home module.
 */
export function backfillSessionTree(db: Db): number {
  const rows = db.all<SessionTreeRow>(
    `SELECT id, parent_session_id, root_session_id, state,
            json_extract(data, '$.rootSessionId') AS json_root FROM sessions`,
  );
  if (rows.length === 0) return 0;
  const parentOf = new Map(rows.map((r) => [r.id, r.parent_session_id]));
  const rootOf = new Map<string, string>();
  const resolve = (id: string): string => {
    const known = rootOf.get(id);
    if (known) return known;
    const path: string[] = [];
    const seen = new Set<string>();
    let cur = id;
    let root: string;
    for (;;) {
      const cached = rootOf.get(cur);
      if (cached) {
        root = cached;
        break;
      }
      path.push(cur);
      seen.add(cur);
      const parent = parentOf.get(cur) ?? null;
      if (!parent || !parentOf.has(parent) || seen.has(parent)) {
        // A missing parent or a cycle: the walk stops here.
        root = parent && seen.has(parent) ? id : cur;
        break;
      }
      cur = parent;
    }
    for (const p of path) rootOf.set(p, root);
    return root;
  };

  let fixed = 0;
  db.transaction(() => {
    for (const r of rows) {
      const root = resolve(r.id);
      const state = r.state ?? null;
      if (r.root_session_id === root && r.json_root === root && state !== null) continue;
      db.run(
        `UPDATE sessions SET root_session_id = ?,
                state = COALESCE(state, json_extract(data, '$.state'), 'idle'),
                data = json_set(data, '$.rootSessionId', ?)
          WHERE id = ?`,
        [root, root, r.id],
      );
      fixed += 1;
    }
  });
  return fixed;
}

/**
 * Run a one-time startup step: `fn` runs only if `id` was never recorded in
 * `schema_migrations` (backfill ids are namespaced `backfill/<module>/<name>`), and the id is
 * recorded once `fn` returns. Use it for data steps that must happen exactly once.
 */
export function runOnce(db: Db, id: string, nowIso: string, fn: () => void): boolean {
  const done = db.get<{ id: string }>('SELECT id FROM schema_migrations WHERE id = ?', [id]);
  if (done) return false;
  db.transaction(() => {
    fn();
    db.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [id, nowIso]);
  });
  return true;
}
