import type { Character } from '@acc/protocol';
import { faceOf, useMember } from '../../daemon/members';
import { cn } from '../../lib/cn';

/** Member colours (`--member-1..8`); the first four are the chart series. */
export const MEMBER_TONES = 8;

/** The colour of a tone, or the secondary ink without one. */
export function toneColor(tone: number | undefined): string {
  return tone === undefined ? 'var(--text-secondary)' : `var(--member-${(tone % MEMBER_TONES) + 1})`;
}

/**
 * A face: one character on a wash of its colour. Members and speakers look the same
 * everywhere (sidebar, conversations, cast, home). `busy` puts the working ring around it.
 * Decorative: the name is always next to it or in its label.
 */
export function Face({
  text,
  tone,
  size = 20,
  busy = false,
  muted = false,
  className,
}: {
  text: string;
  tone: number | undefined;
  size?: number;
  busy?: boolean;
  /** A member taken off the roster: grey. */
  muted?: boolean;
  className?: string;
}) {
  const color = muted ? 'var(--text-tertiary)' : toneColor(tone);
  return (
    <span
      aria-hidden
      data-face
      data-busy={busy || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold leading-none',
        busy && 'ring-[1.5px] ring-accent ring-offset-[1.5px] ring-offset-[var(--bg-app)]',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.48)),
        color,
        background: `color-mix(in oklch, ${color} 18%, transparent)`,
      }}
    >
      {text}
    </span>
  );
}

/** A member's face. */
export function MemberFace({
  member,
  size,
  busy,
  className,
}: {
  member: Pick<Character, 'face' | 'name' | 'tone' | 'archivedAt'>;
  size?: number;
  busy?: boolean;
  className?: string;
}) {
  return (
    <Face
      text={faceOf(member)}
      tone={member.tone}
      size={size}
      busy={busy}
      muted={!!member.archivedAt}
      className={className}
    />
  );
}

/** The face of the member a conversation is with (nothing without one). */
export function MemberFaceOf({
  characterId,
  size = 14,
  className,
}: {
  characterId: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const member = useMember(characterId);
  if (!member) return null;
  return (
    <span data-member-face={member.id} className={cn('inline-flex shrink-0', className)} title={member.name}>
      <MemberFace member={member} size={size} />
    </span>
  );
}
