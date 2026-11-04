/**
 * Members (UI「メンバー」, snapshot 20261104_members-spec.md): a named face with a profile and a
 * default model that conversations, work and schedules can be "with". A member holds no
 * permissions: what a conversation may do is still its grant and budget.
 */
import { z } from 'zod';
import { CharacterId, SessionId, Timestamp } from '../common';
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

/** One member with what it has been in and what it cost (`character.get`). */
export const CharacterDetail = z.object({
  character: Character,
  /** Conversations with this member, most recently active first (up to 30). */
  sessions: z.array(Session),
  /** Spend of those conversations this month (the daemon's time zone). */
  monthUsd: z.number(),
});
export type CharacterDetail = z.infer<typeof CharacterDetail>;

export const characterDomain = { Character, CharacterDetail } as const;

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
} as const satisfies Record<string, MethodDef>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const characterEvents = {
  'character.created': z.object({ character: Character }),
  'character.updated': z.object({ character: Character, changes: z.array(z.string()) }),
  'character.reordered': z.object({ characterIds: z.array(CharacterId) }),
} as const;
