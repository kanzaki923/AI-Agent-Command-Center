/**
 * Members (UI「メンバー」, snapshot 20261104_members-spec.md): a named face with a profile and a
 * default model that conversations, work and schedules can be "with". A member holds no
 * permissions: what a conversation may do is still its grant and budget.
 */
import { z } from 'zod';
import { CharacterId, MemoryId, SessionId, Timestamp } from '../common';
import { Session } from '../domain';
import { type MethodDef, Ok, params } from '../method';

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** Number of member colours (`--member-1..8` in the UI). */
export const CHARACTER_TONES = 8;
export const CHARACTER_NAME_MAX = 40;
/** Same bound as a speaker's persona: the profile is part of every call of the member. */
export const CHARACTER_PROFILE_MAX = 4000;

export const Character = z.object({
  id: CharacterId,
  name: z.string().min(1).max(CHARACTER_NAME_MAX),
  /** One character (an emoji is fine) shown instead of the first letter of the name. */
  face: z.string().min(1).max(16).nullable().default(null),
  /** Colour index, fixed per member (0..7). */
  tone: z.int().min(0).max(CHARACTER_TONES - 1),
  /** Who the member is: voice, views, background, and how they work. Free text. */
  profile: z.string().max(CHARACTER_PROFILE_MAX).default(''),
  /** Model conversations with this member start on; null = the conversation's usual model. */
  model: z.string().min(1).nullable().default(null),
  /** Roster order (ascending). */
  sortKey: z.number(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  archivedAt: Timestamp.nullable().default(null),
});
export type Character = z.infer<typeof Character>;

/**
 * What a member remembers (snapshot 20261104_members-spec.md §2, §5): about itself (`self`,
 * including the ways of working it was taught: `work`), about another member (`relation`,
 * `aboutId`) and about the person (`you`, only what it heard itself).
 */
export const MemoryKind = z.enum(['self', 'relation', 'you']);
export type MemoryKind = z.infer<typeof MemoryKind>;

/** Bounds the daemon enforces on what a member keeps. */
export const MEMORY_LIMITS = { self: 20, relationPerMember: 5, you: 15, textChars: 80 } as const;

export const CharacterMemory = z.object({
  id: MemoryId,
  characterId: CharacterId,
  kind: MemoryKind,
  /** The other member of a `relation`. */
  aboutId: CharacterId.nullable().default(null),
  text: z.string().min(1).max(MEMORY_LIMITS.textChars),
  /** A way of working (`self`): read in work too, where the rest of the self is not. */
  work: z.boolean().default(false),
  /** When it happened or was learned. */
  at: Timestamp,
  /** `person`: written or corrected by the person; sorting never changes or drops it. */
  source: z.enum(['auto', 'person']),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type CharacterMemory = z.infer<typeof CharacterMemory>;

/** One change of a member's memories (the page's 最近の変化). */
export const MemoryChange = z.object({
  at: Timestamp,
  change: z.enum(['added', 'removed', 'changed']),
  kind: MemoryKind,
  text: z.string(),
  by: z.enum(['digest', 'person']),
});
export type MemoryChange = z.infer<typeof MemoryChange>;

/** One member with what it has been in and what it cost (`character.get`). */
export const CharacterDetail = z.object({
  character: Character,
  /** Conversations with this member, most recently active first (up to 30). */
  sessions: z.array(Session),
  /** Spend of those conversations this month (the daemon's time zone). */
  monthUsd: z.number(),
  /** What it remembers (kind order, then oldest first). Absent from older daemons. */
  memories: z.array(CharacterMemory).default([]),
  /** Latest changes of its memories, newest first (up to 12). */
  changes: z.array(MemoryChange).default([]),
  /** What sorting its memories cost this month (part of the total spend, not of monthUsd). */
  memoryUsd: z.number().default(0),
});
export type CharacterDetail = z.infer<typeof CharacterDetail>;

export const characterDomain = { Character, CharacterDetail, CharacterMemory, MemoryChange } as const;

const Face = z
  .string()
  .trim()
  .max(16)
  .nullable()
  .optional()
  .describe('One character (an emoji is fine) shown as the face; null shows the first letter');

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

export const characterMethods = {
  'character.list': {
    params: params({ includeArchived: z.boolean().default(false) }),
    result: z.object({ items: z.array(Character) }),
    description:
      'The members of the roster, in roster order: name, profile and default model. Give a member to a conversation (characterId) only when the person named it.',
  },
  'character.get': {
    params: params({ characterId: CharacterId }),
    result: CharacterDetail,
    description: 'One member, with the conversations it was in and what they cost this month.',
  },
  'character.create': {
    params: params({
      name: z.string().trim().min(1).max(CHARACTER_NAME_MAX),
      face: Face,
      profile: z.string().max(CHARACTER_PROFILE_MAX).optional(),
      model: z.string().min(1).nullable().optional(),
    }),
    result: Character,
    description: 'Add a member to the roster.',
    tool: false,
    mutates: true,
  },
  'character.update': {
    params: params({
      characterId: CharacterId,
      name: z.string().trim().min(1).max(CHARACTER_NAME_MAX).optional(),
      face: Face,
      tone: z.int().min(0).max(CHARACTER_TONES - 1).optional(),
      profile: z.string().max(CHARACTER_PROFILE_MAX).optional(),
      model: z.string().min(1).nullable().optional().describe('null: the usual model'),
    }),
    result: Character,
    description: 'Change a member (only the given fields). Conversations read it from their next turn.',
    tool: false,
    mutates: true,
  },
  'character.reorder': {
    params: params({ characterIds: z.array(CharacterId).min(1).max(500) }),
    result: Ok,
    description: 'Put the roster in this order (members not listed keep their place after).',
    tool: false,
    mutates: true,
  },
  'character.archive': {
    params: params({
      characterId: CharacterId,
      archived: z.boolean().default(true).describe('false brings the member back'),
    }),
    result: Character,
    description:
      'Take a member off the roster (or bring it back). Conversations it was in are kept and show its name.',
    tool: false,
    mutates: true,
  },
  'character.keep': {
    params: params({ sessionId: SessionId }),
    result: Character,
    description:
      'Keep the character a speaker played (its persona) as a member of the roster; the conversation then refers to that member.',
    tool: false,
    mutates: true,
  },
  'character.memory.add': {
    params: params({
      characterId: CharacterId,
      kind: MemoryKind,
      text: z.string().trim().min(1).max(MEMORY_LIMITS.textChars),
      aboutId: CharacterId.optional().describe('kind relation: the other member'),
      work: z.boolean().optional().describe('kind self: a way of working'),
    }),
    result: CharacterMemory,
    description: 'Have a member remember something (the person wrote it, so sorting keeps it).',
    tool: false,
    mutates: true,
  },
  'character.memory.update': {
    params: params({
      memoryId: MemoryId,
      text: z.string().trim().min(1).max(MEMORY_LIMITS.textChars),
    }),
    result: CharacterMemory,
    description: "Correct one memory (it becomes the person's, so sorting keeps it).",
    tool: false,
    mutates: true,
  },
  'character.memory.delete': {
    params: params({ memoryId: MemoryId }),
    result: Ok,
    description: 'Forget one memory (sorting will not bring it back).',
    tool: false,
    mutates: true,
  },
  'character.digest': {
    params: params({ characterId: CharacterId }),
    result: z.object({
      outcome: z.enum(['done', 'nothing_new', 'off', 'limit', 'rejected', 'failed']),
    }),
    description:
      'Sort out what a member said and heard since the last time into its memories now (normally done when it has been quiet for a while).',
    tool: false,
    mutates: true,
  },
} as const satisfies Record<string, MethodDef>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const characterEvents = {
  'character.created': z.object({ character: Character }),
  'character.updated': z.object({ character: Character, changes: z.array(z.string()) }),
  'character.reordered': z.object({ characterIds: z.array(CharacterId) }),
  'character.memory_changed': z.object({
    characterId: CharacterId,
    added: z.array(z.string()),
    removed: z.array(z.string()),
    changed: z.array(z.string()),
    by: z.enum(['digest', 'person']),
    /** A sorting the daemon threw away (it would have dropped half of the memories at once). */
    rejected: z.boolean().default(false),
  }),
} as const;
