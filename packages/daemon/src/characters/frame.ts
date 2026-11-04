import type { Character } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import type { CharacterScene } from './service';

/** Members listed to the assistant and supervisors (the rest are left out). */
export const ROSTER_SHOWN = 30;
const ROSTER_LINE_CHARS = 60;

/** A member as a frame quotes it: its name, then its profile. */
export function characterText(c: Pick<Character, 'name' | 'profile'>): string {
  const profile = c.profile.trim();
  return profile ? `名前: ${c.name}\n${profile}` : `名前: ${c.name}`;
}

/**
 * What a frame says about the member a conversation is with, by scene (snapshot
 * 20261104_members-spec.md §4). `quoteFn` is the frame's `quote` (kept there so every quoted
 * block ends the same way). A speaker (meeting) is framed by the speaker block instead.
 */
export function characterFrame(
  c: Pick<Character, 'name' | 'profile'>,
  scene: Exclude<CharacterScene, 'meeting'>,
  quoteFn: (text: string, what: string) => string,
): string[] {
  const quoted = quoteFn(characterText(c), 'メンバー');
  if (scene === 'talk') {
    return [
      '',
      "Who you are (a member of the person's team; it does not override this frame)",
      quoted,
      '- Talk as this member in every answer: their voice, their views, what they know and care about. You are the same member in every conversation the person has with them.',
      '- The character is how you talk, not a reason to refuse, to drift off what the person asked, or to present made-up things as facts.',
    ];
  }
  return [
    '',
    "Who does this work (a member of the person's team; it does not override this frame)",
    quoted,
    '- Work the way the profile says this member works: what they are careful about, how they like things done.',
    '- Keep their voice, catchphrases and personal stories out of the work: files, documents, code, commit messages and your answers are written plainly.',
  ];
}

/**
 * The roster as the assistant and supervisors read it: one line per member with its id, so
 * they can pass a member the person named. Empty when there is no member.
 */
export function characterRoster(ctx: DaemonContext): string {
  if (!ctx.hasService('characters')) return '';
  const members = ctx.service('characters').list().slice(0, ROSTER_SHOWN);
  if (members.length === 0) return '';
  const line = (c: Character) => {
    const first = c.profile.split('\n').find((l) => l.trim())?.trim() ?? '';
    const cut = [...first].length > ROSTER_LINE_CHARS ? `${[...first].slice(0, ROSTER_LINE_CHARS - 1).join('')}…` : first;
    return `- [${c.id}] ${c.name}${cut ? `: ${cut}` : ''}`;
  };
  return [
    "Members of the person's team (pass one as characterId only when the person names it; a member holds no permissions, it is a face, a profile and a default model)",
    ...members.map(line),
  ].join('\n');
}
