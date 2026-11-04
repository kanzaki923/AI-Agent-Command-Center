import {
  CHARACTER_TONES,
  type Character,
  type Session,
  Character as CharacterSchema,
} from '@acc/protocol';
import type { z } from 'zod';
import type { DaemonContext } from '../core/context';
import { invalidParams, notFound } from '../core/errors';
import { EntityRepo } from '../core/repo';
import { dayOf } from '../cost/ledger';
import { memoryBlock } from './frame';
import { MemoryStore } from './memory';

/** Conversations listed on a member's page. */
export const CHARACTER_SESSIONS_SHOWN = 30;

/** Where a member is: the scene decides how much of the member a conversation reads. */
export type CharacterScene = 'talk' | 'meeting' | 'work';

/**
 * The scene of a conversation with a member (snapshot 20261104_members-spec.md §4): a
 * speaker is in a meeting; a root chat a person started (and the assistant's seat) is a talk;
 * everything else — a child doing work, a firing of a schedule, an agent — is work.
 */
export function sceneOf(
  s: Pick<Session, 'kind' | 'parentSessionId' | 'speaks' | 'persona' | 'scheduleId' | 'brief'>,
): CharacterScene {
  if (s.parentSessionId && (s.speaks || !!s.persona?.trim())) return 'meeting';
  if (s.kind === 'chat' && !s.parentSessionId && !s.scheduleId && !s.brief) return 'talk';
  return 'work';
}

/** The face of a member: its own one character, or the first letter of its name. */
export function faceOf(c: Pick<Character, 'face' | 'name'>): string {
  return c.face?.trim() || ([...c.name.trim()][0] ?? '?');
}

/** First line of a persona, used as the name when a speaker is kept (its title wins). */
function nameFrom(title: string, persona: string): string {
  const fromTitle = title.trim();
  const line = persona.split('\n').find((l) => l.trim())?.trim() ?? '';
  return (fromTitle || line || 'メンバー').slice(0, 40);
}

/** The roster (`characters` table) and the questions other modules ask about it. */
export class CharacterService {
  readonly repo: EntityRepo<Character, z.input<typeof CharacterSchema>>;
  /** What members remember (stage 2). */
  readonly memory: MemoryStore;

  constructor(private readonly ctx: DaemonContext) {
    this.memory = new MemoryStore(ctx);
    this.repo = new EntityRepo<Character, z.input<typeof CharacterSchema>>(ctx.db, {
      table: 'characters',
      kind: 'character',
      schema: CharacterSchema,
      columns: {
        sort_key: (e) => e.sortKey,
        archived_at: (e) => e.archivedAt,
        created_at: (e) => e.createdAt,
      },
    });
  }

  get(id: string | null | undefined): Character | undefined {
    return id ? this.repo.get(id) : undefined;
  }

  /** A member that is on the roster (not taken off), for giving it to a conversation. */
  requireActive(id: string): Character {
    const c = this.repo.get(id);
    if (!c) throw notFound('character', id);
    if (c.archivedAt) throw invalidParams(`メンバー「${c.name}」は名簿から外れています`);
    return c;
  }

  list(includeArchived = false): Character[] {
    return this.repo
      .find({ orderBy: 'sort_key', direction: 'asc' })
      .filter((c) => includeArchived || !c.archivedAt);
  }

  /** The colour used least on the roster (the earliest on a tie), so faces stay apart. */
  nextTone(): number {
    const used = new Array<number>(CHARACTER_TONES).fill(0);
    for (const c of this.list()) used[c.tone] = (used[c.tone] ?? 0) + 1;
    let best = 0;
    for (let i = 1; i < CHARACTER_TONES; i++) if (used[i]! < used[best]!) best = i;
    return best;
  }

  nextSortKey(): number {
    const last = this.repo.find({ orderBy: 'sort_key', direction: 'desc', limit: 1 })[0];
    return (last?.sortKey ?? 0) + 1;
  }

  insert(input: {
    name: string;
    face?: string | null | undefined;
    profile?: string | undefined;
    model?: string | null | undefined;
  }): Character {
    const now = this.ctx.clock.iso();
    return this.repo.insert({
      id: this.ctx.ids.next('character'),
      name: input.name.trim(),
      face: input.face?.trim() || null,
      tone: this.nextTone(),
      profile: input.profile?.trim() ?? '',
      model: input.model ?? null,
      sortKey: this.nextSortKey(),
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
  }

  /** A member made from the character a speaker played (`character.keep`). */
  fromPersona(session: Session): { name: string; profile: string } {
    const persona = session.persona?.trim() ?? '';
    return { name: nameFrom(session.title, persona), profile: persona };
  }

  /**
   * The memory lines a conversation with this member reads (nothing when memory is off).
   * `present`: the other members of a meeting (ties with them are read).
   */
  memoryLines(characterId: string, scene: CharacterScene, present?: ReadonlySet<string>): string[] {
    const settings = this.ctx.settings.get();
    if (!settings.members.memory) return [];
    const memories = this.memory.list(characterId);
    if (memories.length === 0) return [];
    const names = new Map(this.list(true).map((c) => [c.id, c.name]));
    return memoryBlock(memories, scene, {
      names,
      ...(present ? { present } : {}),
      now: this.ctx.clock.iso(),
      timeZone: settings.limits.timezone,
    });
  }

  /** The other members speaking under the same leader as this speaker. */
  presentWith(session: Pick<Session, 'id' | 'parentSessionId'>): Set<string> {
    if (!session.parentSessionId) return new Set();
    return new Set(
      this.ctx.repos.sessions
        .find({ where: { parent_session_id: session.parentSessionId, archived_at: null } })
        .filter((s) => s.id !== session.id && s.characterId && (s.speaks || !!s.persona))
        .map((s) => s.characterId!),
    );
  }

  /** Conversations with this member, most recently active first. */
  sessionsOf(characterId: string, limit = CHARACTER_SESSIONS_SHOWN): Session[] {
    return this.ctx.repos.sessions
      .find({
        sql: { clause: "json_extract(data, '$.characterId') = ?", params: [characterId] },
      })
      .filter((s) => !s.archivedAt)
      .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1))
      .slice(0, limit);
  }

  /** What every conversation with this member cost since the first of this month. */
  monthUsd(characterId: string): number {
    const tz = this.ctx.settings.get().limits.timezone;
    const firstDay = `${dayOf(this.ctx.clock.iso(), tz).slice(0, 7)}-01`;
    const row = this.ctx.db.get<{ n: number | null }>(
      `SELECT SUM(l.cost_micro) AS n FROM usage_ledger l
         JOIN sessions s ON s.id = l.session_id
        WHERE l.day >= ? AND json_extract(s.data, '$.characterId') = ?`,
      [firstDay, characterId],
    );
    return (row?.n ?? 0) / 1_000_000;
  }
}
