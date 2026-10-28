import type { SessionSearchHit } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import type { SqlValue } from '../core/db';
import type { Migration } from '../core/migrations';

/** Text of a message's `text` parts, joined by newlines (NULL when there are none). */
const MESSAGE_TEXT_SQL = (row: string) => `(
  SELECT group_concat(json_extract(value, '$.text'), char(10))
  FROM json_each(${row}.data, '$.content')
  WHERE json_extract(value, '$.type') = 'text'
)`;

/**
 * Full-text index over message text. The trigram tokenizer matches arbitrary substrings,
 * which works for Japanese (no word boundaries) as long as a term has >= 3 characters;
 * shorter terms fall back to LIKE. Kept in sync by triggers, so messages inserted by any
 * module are indexed.
 */
export const sessionsMigrations: Migration[] = [
  {
    id: 'sessions/0001_fts',
    sql: `
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  message_id UNINDEXED,
  session_id UNINDEXED,
  tokenize = 'trigram'
);

CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (text, message_id, session_id)
  VALUES (${MESSAGE_TEXT_SQL('NEW')}, NEW.id, NEW.session_id);
END;

CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = OLD.id;
END;

CREATE TRIGGER messages_fts_au AFTER UPDATE OF data ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = OLD.id;
  INSERT INTO messages_fts (text, message_id, session_id)
  VALUES (${MESSAGE_TEXT_SQL('NEW')}, NEW.id, NEW.session_id);
END;

INSERT INTO messages_fts (text, message_id, session_id)
SELECT ${MESSAGE_TEXT_SQL('messages')}, id, session_id FROM messages;
`,
  },
];

/** Trigram needs 3 characters (code points) per term to use the index. */
const MIN_INDEXED_CHARS = 3;

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** A short excerpt around the first match, on one line. */
export function makeSnippet(text: string, terms: string[], before = 30, after = 70): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  let at = -1;
  let len = 0;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i !== -1 && (at === -1 || i < at)) {
      at = i;
      len = t.length;
    }
  }
  if (at === -1) return flat.length > before + after ? `${flat.slice(0, before + after)}…` : flat;
  const start = Math.max(0, at - before);
  const end = Math.min(flat.length, at + len + after);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** session.search: messages containing every whitespace-separated term, newest first. */
export function searchMessages(
  ctx: DaemonContext,
  q: { query: string; projectId?: string | undefined; limit: number },
): SessionSearchHit[] {
  const terms = q.query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const long = terms.filter((t) => Array.from(t).length >= MIN_INDEXED_CHARS);
  const short = terms.filter((t) => Array.from(t).length < MIN_INDEXED_CHARS);

  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (long.length > 0) {
    clauses.push('messages_fts MATCH ?');
    params.push(long.map((t) => `"${t.replaceAll('"', '""')}"`).join(' AND '));
  }
  for (const t of short) {
    clauses.push("messages_fts.text LIKE ? ESCAPE '\\'");
    params.push(`%${likeEscape(t)}%`);
  }
  if (q.projectId) {
    clauses.push('s.project_id = ?');
    params.push(q.projectId);
  }
  const rows = ctx.db.all<{
    message_id: string;
    session_id: string;
    text: string | null;
    title: string | null;
    created_at: string;
  }>(
    `SELECT messages_fts.message_id, messages_fts.session_id, messages_fts.text,
            json_extract(s.data, '$.title') AS title, m.created_at
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.message_id
       JOIN sessions s ON s.id = messages_fts.session_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ?`,
    [...params, q.limit],
  );
  return rows.map((r) => ({
    sessionId: r.session_id,
    sessionTitle: r.title ?? '',
    messageId: r.message_id,
    snippet: makeSnippet(r.text ?? '', terms),
    createdAt: r.created_at,
  }));
}
