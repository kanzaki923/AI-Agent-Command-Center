import type { SessionCard } from '@acc/protocol';
import { useMemo } from 'react';
import { useSessionTree } from '../../daemon/tree';
import { cn } from '../../lib/cn';
import { useUi } from '../../store/ui';
import { faceOf, useAllMembers } from '../../daemon/members';
import { Face, toneColor } from '../ui/Face';
import { Markdown } from './Markdown';

/**
 * Speakers in a conversation between AIs: each has a voice — a face and a colour — so a
 * speaker looks the same in the leading conversation, in the quotes passed to the others and
 * in its own conversation. A member of the roster brings its own face and colour; a speaker
 * made on the spot (a persona) gets the first letter of its name and the next of the first
 * four colours, in the order the speakers started under their parent. Colour names who
 * speaks; the name is always next to it.
 */
export interface Voice {
  tone: number;
  /** The member's own face; the first letter of the name otherwise. */
  face?: string;
}

type VoiceOf = (characterId: string) => Voice | undefined;

/** The voice of every speaker of a tree (nodes depth first, so in the order they started). */
export function speakerTones(
  nodes: readonly Pick<SessionCard, 'id' | 'parentId' | 'role' | 'characterId'>[],
  memberVoice?: VoiceOf,
): Map<string, Voice> {
  const next = new Map<string, number>();
  const tones = new Map<string, Voice>();
  for (const n of nodes) {
    if (n.role !== 'speaker') continue;
    const member = n.characterId ? memberVoice?.(n.characterId) : undefined;
    if (member) {
      tones.set(n.id, member);
      continue;
    }
    const key = n.parentId ?? '';
    const i = next.get(key) ?? 0;
    tones.set(n.id, { tone: i % PERSONA_TONES });
    next.set(key, i + 1);
  }
  return tones;
}

/** How the roster lends its faces to speakers. */
export function useMemberVoice(): VoiceOf {
  const members = useAllMembers();
  return useMemo(() => {
    const byId = new Map(members.map((m) => [m.id, { tone: m.tone, face: faceOf(m) }]));
    return (id: string) => byId.get(id);
  }, [members]);
}

/** The voices of the speakers of the tree `sessionId` belongs to. */
export function useSpeakerTones(sessionId: string | null | undefined): Map<string, Voice> {
  const nodes = useSessionTree(sessionId).data?.nodes;
  const voice = useMemberVoice();
  return useMemo(() => speakerTones(nodes ?? [], voice), [nodes, voice]);
}

/** Speakers made on the spot use the first four colours (the chart series). */
const PERSONA_TONES = 4;

const voiceOf = (tone: number | Voice | undefined): Voice | undefined =>
  typeof tone === 'number' ? { tone } : tone;

/** A speaker's mark: its face (the member's own, or the first letter of its name) on its colour. */
export function SpeakerMark({ title, tone, size = 20 }: { title: string; tone: number | Voice | undefined; size?: number }) {
  const v = voiceOf(tone);
  return (
    <span data-speaker-mark className="inline-flex">
      <Face text={v?.face ?? [...title.trim()][0] ?? '?'} tone={v?.tone} size={size} />
    </span>
  );
}

/**
 * One turn of a speaker: its mark, its name (press to open its conversation) and its words.
 * `compact` for a quote inside another message.
 */
export function Speech({
  sessionId,
  title,
  text,
  cut = false,
  tone,
  compact = false,
}: {
  sessionId: string;
  title: string;
  text: string;
  cut?: boolean;
  tone: number | Voice | undefined;
  compact?: boolean;
}) {
  const openSession = useUi((s) => s.openSession);
  return (
    <div
      data-speech={sessionId}
      className={cn('grid min-w-0 items-start gap-x-2.5', compact ? 'grid-cols-[16px_minmax(0,1fr)]' : 'grid-cols-[22px_minmax(0,1fr)]')}
    >
      <span className={compact ? 'pt-px' : 'pt-0.5'}>
        <SpeakerMark title={title} tone={tone} size={compact ? 16 : 22} />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <button
          type="button"
          onClick={() => openSession(sessionId)}
          className={cn('self-start truncate font-medium hover:underline', compact ? 'text-meta' : 'text-ui')}
          style={{ color: toneColor(voiceOf(tone)?.tone) }}
        >
          {title}
        </button>
        <div className={cn('selectable min-w-0', compact && 'text-fg-2')}>
          <Markdown text={text} compact={compact} />
        </div>
        {cut && (
          <button
            type="button"
            onClick={() => openSession(sessionId)}
            className="self-start text-meta text-fg-3 hover:text-fg hover:underline"
          >
            続きを読む
          </button>
        )}
      </div>
    </div>
  );
}
