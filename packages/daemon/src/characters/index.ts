import type { Actor, Character } from '@acc/protocol';
import { defineMethod } from '../api/registry';
import { forbidden, invalidParams, notFound } from '../core/errors';
import { assertRosterModel } from '../llm/roster';
import { defineModule } from '../module';
import { ASIDE_MIGRATION, askAside } from './aside';
import { MemoryDigest } from './digest';
import { MEMORY_MIGRATION } from './memory';
import { CharacterService } from './service';

export {
  CHARACTER_SESSIONS_SHOWN,
  CharacterService,
  type CharacterScene,
  faceOf,
  sceneOf,
} from './service';
export { characterFrame, characterRoster } from './frame';

declare module '../core/context' {
  interface Services {
    /** The roster of members (`character.*`). */
    characters: CharacterService;
    /** Sorting out what members said and heard into their memories. */
    memoryDigest: MemoryDigest;
  }
}

/**
 * Members (UI「メンバー」, snapshot 20261104_members-spec.md): a roster of named faces with a
 * profile and a default model. Conversations refer to a member by `characterId`; the frame
 * (sessions/framing.ts) reads the member at every run. Only people change the roster: the
 * assistant and supervisors may read it (to pass a member a person named).
 */
export const charactersModule = defineModule({
  name: 'characters',
  migrations: [
    {
      id: 'characters/0001_init',
      sql: `
CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  sort_key REAL NOT NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX characters_sort ON characters(sort_key);
`,
    },
    { id: 'characters/0002_memories', sql: MEMORY_MIGRATION },
    { id: 'characters/0003_calls', sql: ASIDE_MIGRATION },
  ],
  register(ctx) {
    const service = new CharacterService(ctx);
    ctx.provide('characters', service);
    const digest = new MemoryDigest(ctx, service, service.memory);
    ctx.provide('memoryDigest', digest);
    const { db, bus } = ctx;

    // The roster is the person's: an AI may read it, never change it (whatever its grant).
    const humansOnly = (actor: { kind: string }) => {
      if (actor.kind === 'agent') throw forbidden('メンバーを作ったり変えたりできるのは人だけです');
    };
    const emitMemory = (
      actor: Actor,
      characterId: string,
      d: { added?: string[]; removed?: string[]; changed?: string[] },
    ) =>
      bus.emit({
        type: 'character.memory_changed',
        actor,
        payload: {
          characterId,
          added: d.added ?? [],
          removed: d.removed ?? [],
          changed: d.changed ?? [],
          by: 'person',
          rejected: false,
        },
      });
    const assertModel = (actor: Parameters<typeof assertRosterModel>[1], model: string | null | undefined) => {
      if (model) assertRosterModel(ctx, actor, model);
    };

    ctx.methods.register(
      defineMethod('character.list', {
        handler: (p) => ({ items: service.list(p.includeArchived) }),
      }),

      defineMethod('character.get', {
        handler: (p) => {
          const character = service.repo.get(p.characterId);
          if (!character) throw notFound('character', p.characterId);
          return {
            character,
            sessions: service.sessionsOf(character.id),
            monthUsd: service.monthUsd(character.id),
            memories: service.memory.list(character.id),
            changes: service.memory.changes(character.id),
            memoryUsd: digest.monthUsd(character.id),
          };
        },
      }),

      defineMethod('character.create', {
        handler: (p, call) =>
          db.transaction(() => {
            humansOnly(call.actor);
            assertModel(call.actor, p.model);
            const character = service.insert(p);
            bus.emit({ type: 'character.created', actor: call.actor, payload: { character } });
            return character;
          }),
      }),

      defineMethod('character.update', {
        handler: (p, call) =>
          db.transaction(() => {
            humansOnly(call.actor);
            assertModel(call.actor, p.model);
            const changes: string[] = [];
            const character = service.repo.update(p.characterId, (cur) => {
              const next: Character = { ...cur };
              const assign = <K extends keyof Character>(key: K, value: Character[K] | undefined) => {
                if (value === undefined || cur[key] === value) return;
                next[key] = value;
                changes.push(key);
              };
              assign('name', p.name?.trim());
              assign('face', p.face === undefined ? undefined : p.face?.trim() || null);
              assign('tone', p.tone);
              assign('profile', p.profile?.trim());
              assign('model', p.model);
              if (changes.length > 0) next.updatedAt = ctx.clock.iso();
              return next;
            });
            if (changes.length > 0) {
              bus.emit({
                type: 'character.updated',
                actor: call.actor,
                payload: { character, changes },
              });
            }
            return character;
          }),
      }),

      defineMethod('character.reorder', {
        handler: (p, call) =>
          db.transaction(() => {
            humansOnly(call.actor);
            const all = service.list(true);
            const known = new Set(all.map((c) => c.id));
            for (const id of p.characterIds) if (!known.has(id)) throw notFound('character', id);
            const listed = new Set(p.characterIds);
            const order = [...p.characterIds, ...all.map((c) => c.id).filter((id) => !listed.has(id))];
            order.forEach((id, i) => {
              service.repo.update(id, (cur) => (cur.sortKey === i + 1 ? cur : { ...cur, sortKey: i + 1 }));
            });
            bus.emit({
              type: 'character.reordered',
              actor: call.actor,
              payload: { characterIds: order },
            });
            return { ok: true as const };
          }),
      }),

      defineMethod('character.archive', {
        handler: (p, call) =>
          db.transaction(() => {
            humansOnly(call.actor);
            const cur = service.repo.get(p.characterId);
            if (!cur) throw notFound('character', p.characterId);
            if (!!cur.archivedAt === p.archived) return cur;
            const character = service.repo.update(cur.id, (c) => ({
              ...c,
              archivedAt: p.archived ? ctx.clock.iso() : null,
              updatedAt: ctx.clock.iso(),
            }));
            // A member taken off the roster leaves the assistant's seat (it can come back).
            if (p.archived && ctx.settings.get().assistant.characterId === cur.id) {
              const changes = ctx.settings.update({ assistant: { characterId: null } });
              bus.emit({ type: 'settings.updated', actor: call.actor, payload: { changes } });
            }
            bus.emit({
              type: 'character.updated',
              actor: call.actor,
              payload: { character, changes: ['archivedAt'] },
            });
            return character;
          }),
      }),

      defineMethod('character.keep', {
        scope: (p) => {
          const s = ctx.repos.sessions.get(p.sessionId);
          return { projectIds: s?.projectId ? [s.projectId] : [], sessionIds: [p.sessionId] };
        },
        handler: (p, call) =>
          db.transaction(() => {
            humansOnly(call.actor);
            const session = ctx.repos.sessions.require(p.sessionId);
            if (session.characterId) {
              const kept = service.get(session.characterId);
              if (kept) return kept;
            }
            if (!session.persona?.trim()) {
              throw invalidParams('この会話には残せるキャラがありません');
            }
            const { name, profile } = service.fromPersona(session);
            const character = service.insert({ name, profile, model: session.model });
            const updated = ctx.repos.sessions.update(session.id, (cur) => ({
              ...cur,
              characterId: character.id,
              speaks: true,
              persona: null,
              updatedAt: ctx.clock.iso(),
            }));
            bus.emit({ type: 'character.created', actor: call.actor, payload: { character } });
            bus.emit({
              type: 'session.updated',
              actor: call.actor,
              payload: { session: updated, changes: ['characterId', 'persona', 'speaks'] },
            });
            return character;
          }),
      }),

      defineMethod('character.memory.add', {
        handler: (p, call) =>
          db.transaction(() => {
            humansOnly(call.actor);
            const member = service.repo.get(p.characterId);
            if (!member) throw notFound('character', p.characterId);
            if (p.kind === 'relation') {
              if (!p.aboutId || p.aboutId === member.id) throw invalidParams('関係の記憶には相手のメンバーが要ります');
              if (!service.get(p.aboutId)) throw notFound('character', p.aboutId);
            }
            const memory = service.memory.add(p);
            emitMemory(call.actor, member.id, { added: [memory.text] });
            return memory;
          }),
      }),

      defineMethod('character.memory.update', {
        handler: (p, call) =>
          db.transaction(() => {
            humansOnly(call.actor);
            const memory = service.memory.update(p.memoryId, p.text);
            emitMemory(call.actor, memory.characterId, { changed: [memory.text] });
            return memory;
          }),
      }),

      defineMethod('character.memory.delete', {
        handler: (p, call) =>
          db.transaction(() => {
            humansOnly(call.actor);
            const memory = service.memory.delete(p.memoryId);
            emitMemory(call.actor, memory.characterId, { removed: [memory.text] });
            return { ok: true as const };
          }),
      }),

      defineMethod('character.aside', {
        scope: (p) => {
          const s = ctx.repos.sessions.get(p.sessionId);
          return { projectIds: s?.projectId ? [s.projectId] : [], sessionIds: [p.sessionId] };
        },
        handler: (p, call) => {
          humansOnly(call.actor);
          return askAside(ctx, service, p, call.actor);
        },
      }),

      defineMethod('character.digest', {
        handler: async (p, call) => {
          humansOnly(call.actor);
          if (!service.get(p.characterId)) throw notFound('character', p.characterId);
          return { outcome: await digest.digest(p.characterId, { force: true }) };
        },
      }),
    );
    return { start: () => digest.start(), stop: () => digest.stop() };
  },
});
