import {
  CharacterMemory as CharacterMemorySchema,
  MEMORY_LIMITS,
  type CharacterMemory,
  type MemoryChange,
  type MemoryKind,
  type SystemActor,
} from '@acc/protocol';
import type { z } from 'zod';
import type { DaemonContext } from '../core/context';
import { EntityRepo } from '../core/repo';

export const MEMORY_SYSTEM: SystemActor = { kind: 'system', component: 'memory' };

/** Changes listed on a member's page. */
export const CHANGES_SHOWN = 12;

const KIND_ORDER: Record<MemoryKind, number> = { self: 0, relation: 1, you: 2 };

/**
 * A memory's text for comparing: no spaces or punctuation, lower case. A memory the person
 * dropped is kept as this (tombstone), so a later sorting that writes it again is caught even
 * when it changes a comma.
 */
export function normalizeMemory(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

/** A memory as one line, cut to the bound. */
export function clipMemory(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  const chars = [...one];
  return chars.length > MEMORY_LIMITS.textChars
    ? `${chars.slice(0, MEMORY_LIMITS.textChars - 1).join('')}…`
    : one;
}

/** A memory the sorting proposes (whole lists replace the automatic ones). */
export interface ProposedMemory {
  kind: MemoryKind;
  aboutId: string | null;
  text: string;
  work: boolean;
}

/** What one replacement changed (empty when nothing did). */
export interface MemoryDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

const keyOf = (m: { kind: MemoryKind; aboutId: string | null; text: string }) =>
  `${m.kind}:${m.aboutId ?? ''}:${normalizeMemory(m.text)}`;

/**
 * What members remember (`character_memories`), what the person made them forget
 * (tombstones) and how the memories changed (the log the page shows). Only two paths write:
 * the person (`character.memory.*`) and the daemon's sorting (`replaceAuto`).
 */
export class MemoryStore {
  readonly repo: EntityRepo<CharacterMemory, z.input<typeof CharacterMemorySchema>>;

  constructor(private readonly ctx: DaemonContext) {
    this.repo = new EntityRepo<CharacterMemory, z.input<typeof CharacterMemorySchema>>(ctx.db, {
      table: 'character_memories',
      kind: 'memory',
      schema: CharacterMemorySchema,
      columns: {
        character_id: (e) => e.characterId,
        kind: (e) => e.kind,
        created_at: (e) => e.createdAt,
      },
    });
  }

  /** A member's memories: about itself, then relations, then the person; oldest first. */
  list(characterId: string): CharacterMemory[] {
    return this.repo
      .find({ where: { character_id: characterId } })
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  /** The person has the member remember something. */
  add(input: {
    characterId: string;
    kind: MemoryKind;
    text: string;
    aboutId?: string | null | undefined;
    work?: boolean | undefined;
  }): CharacterMemory {
    const now = this.ctx.clock.iso();
    const memory = this.repo.insert({
      id: this.ctx.ids.next('memory'),
      characterId: input.characterId,
      kind: input.kind,
      aboutId: input.kind === 'relation' ? (input.aboutId ?? null) : null,
      text: clipMemory(input.text),
      work: input.kind === 'self' && !!input.work,
      at: now,
      source: 'person',
      createdAt: now,
      updatedAt: now,
    });
    this.unbury(input.characterId, memory.text);
    this.log(input.characterId, 'added', memory.kind, memory.text, 'person');
    return memory;
  }

  /** The person corrects a memory: it becomes theirs, so sorting keeps it as it is. */
  update(id: string, text: string): CharacterMemory {
    const cur = this.repo.require(id);
    const next = clipMemory(text);
    const memory = this.repo.update(id, (m) => ({
      ...m,
      text: next,
      source: 'person',
      updatedAt: this.ctx.clock.iso(),
    }));
    if (normalizeMemory(cur.text) !== normalizeMemory(next)) this.bury(cur.characterId, cur.text);
    this.unbury(cur.characterId, next);
    this.log(cur.characterId, 'changed', memory.kind, memory.text, 'person');
    return memory;
  }

  /** The person makes the member forget: a later sorting will not bring it back. */
  delete(id: string): CharacterMemory {
    const cur = this.repo.require(id);
    this.repo.delete(id);
    this.bury(cur.characterId, cur.text);
    this.log(cur.characterId, 'removed', cur.kind, cur.text, 'person');
    return cur;
  }

  /** Normalized texts the person made this member forget. */
  buried(characterId: string): Set<string> {
    return new Set(
      this.ctx.db
        .all<{ norm: string }>('SELECT norm FROM character_memory_tombstones WHERE character_id = ?', [characterId])
        .map((r) => r.norm),
    );
  }

  private bury(characterId: string, text: string): void {
    this.ctx.db.run(
      `INSERT INTO character_memory_tombstones (character_id, norm, deleted_at) VALUES (?, ?, ?)
       ON CONFLICT (character_id, norm) DO UPDATE SET deleted_at = excluded.deleted_at`,
      [characterId, normalizeMemory(text), this.ctx.clock.iso()],
    );
  }

  /** What the person writes again is no longer forgotten. */
  private unbury(characterId: string, text: string): void {
    this.ctx.db.run('DELETE FROM character_memory_tombstones WHERE character_id = ? AND norm = ?', [
      characterId,
      normalizeMemory(text),
    ]);
  }

  /**
   * Replace the automatic memories of a member with what a sorting proposed (the daemon's
   * guards ran before). The person's memories stay as they are; a proposed memory equal to
   * one already kept keeps its date; one the person corrected (`corrections`) becomes theirs.
   */
  replaceAuto(characterId: string, proposed: readonly ProposedMemory[], corrections: ReadonlySet<string>): MemoryDiff {
    const { ctx } = this;
    const now = ctx.clock.iso();
    const current = this.list(characterId);
    const personKeys = new Set(current.filter((m) => m.source === 'person').map(keyOf));
    const autos = new Map(current.filter((m) => m.source === 'auto').map((m) => [keyOf(m), m]));
    const diff: MemoryDiff = { added: [], removed: [], changed: [] };
    const kept = new Set<string>();
    for (const p of proposed) {
      const key = keyOf(p);
      if (personKeys.has(key) || kept.has(key)) continue;
      kept.add(key);
      const person = corrections.has(normalizeMemory(p.text));
      const old = autos.get(key);
      if (old) {
        if (person || old.work !== p.work) {
          this.repo.update(old.id, (m) => ({ ...m, work: p.work, source: person ? 'person' : m.source, updatedAt: now }));
        }
        continue;
      }
      this.repo.insert({
        id: ctx.ids.next('memory'),
        characterId,
        kind: p.kind,
        aboutId: p.kind === 'relation' ? p.aboutId : null,
        text: clipMemory(p.text),
        work: p.kind === 'self' && p.work,
        at: now,
        source: person ? 'person' : 'auto',
        createdAt: now,
        updatedAt: now,
      });
      diff.added.push(p.text);
      this.log(characterId, 'added', p.kind, p.text, 'digest');
    }
    for (const [key, m] of autos) {
      if (kept.has(key)) continue;
      this.repo.delete(m.id);
      diff.removed.push(m.text);
      this.log(characterId, 'removed', m.kind, m.text, 'digest');
    }
    return diff;
  }

  private log(characterId: string, change: MemoryChange['change'], kind: MemoryKind, text: string, by: MemoryChange['by']): void {
    this.ctx.db.run(
      'INSERT INTO character_memory_log (character_id, ts, change, kind, text, by) VALUES (?, ?, ?, ?, ?, ?)',
      [characterId, this.ctx.clock.iso(), change, kind, text, by],
    );
  }

  /** Latest changes, newest first. */
  changes(characterId: string, limit = CHANGES_SHOWN): MemoryChange[] {
    return this.ctx.db
      .all<{ ts: string; change: MemoryChange['change']; kind: MemoryKind; text: string; by: MemoryChange['by'] }>(
        'SELECT ts, change, kind, text, by FROM character_memory_log WHERE character_id = ? ORDER BY id DESC LIMIT ?',
        [characterId, limit],
      )
      .map((r) => ({ at: r.ts, change: r.change, kind: r.kind, text: r.text, by: r.by }));
  }
}

export const MEMORY_MIGRATION = `
CREATE TABLE character_memories (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX character_memories_owner ON character_memories(character_id);
CREATE TABLE character_memory_tombstones (
  character_id TEXT NOT NULL,
  norm TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (character_id, norm)
);
CREATE TABLE character_memory_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  change TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  by TEXT NOT NULL
);
CREATE INDEX character_memory_log_owner ON character_memory_log(character_id, id);
CREATE TABLE character_digest_marks (
  character_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  last_message_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (character_id, session_id)
);
CREATE TABLE character_digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  model TEXT,
  cost_micro INTEGER NOT NULL,
  outcome TEXT NOT NULL
);
CREATE INDEX character_digests_day ON character_digests(day, character_id);
`;
