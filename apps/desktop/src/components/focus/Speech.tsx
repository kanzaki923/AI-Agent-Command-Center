import type { SessionCard } from '@acc/protocol';
import { useMemo } from 'react';
import { useSessionTree } from '../../daemon/tree';
import { cn } from '../../lib/cn';
import { useUi } from '../../store/ui';
import { Markdown } from './Markdown';

/**
 * Speakers (children with a persona) in a conversation between AIs: each has a tone — the
 * categorical series colours, in the order the speakers were started under their parent — so
 * a speaker looks the same in the leading conversation, in the quotes passed to the others
 * and in its own conversation. Colour names who speaks; the name is always next to it.
 */
const TONES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'] as const;

/** Tone index of every speaker of a tree (nodes depth first, so in the order they started). */
export function speakerTones(nodes: readonly Pick<SessionCard, 'id' | 'parentId' | 'role'>[]): Map<string, number> {
  const next = new Map<string, number>();
  const tones = new Map<string, number>();
  for (const n of nodes) {
    if (n.role !== 'speaker') continue;
    const key = n.parentId ?? '';
    const i = next.get(key) ?? 0;
    tones.set(n.id, i % TONES.length);
    next.set(key, i + 1);
  }
  return tones;
}

/** The tones of the speakers of the tree `sessionId` belongs to. */
export function useSpeakerTones(sessionId: string | null | undefined): Map<string, number> {
  const nodes = useSessionTree(sessionId).data?.nodes;
  return useMemo(() => speakerTones(nodes ?? []), [nodes]);
}

function toneColor(tone: number | undefined): string {
  return tone === undefined ? 'var(--text-secondary)' : TONES[tone % TONES.length]!;
}

/** A speaker's mark: the first letter of its name on its tone. */
export function SpeakerMark({ title, tone, size = 20 }: { title: string; tone: number | undefined; size?: number }) {
  const color = toneColor(tone);
  return (
    <span
      aria-hidden
      data-speaker-mark
      className="inline-flex shrink-0 items-center justify-center rounded-full text-micro font-semibold"
      style={{ width: size, height: size, color, background: `color-mix(in oklch, ${color} 18%, transparent)` }}
    >
      {[...title.trim()][0] ?? '?'}
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
  tone: number | undefined;
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
          style={{ color: toneColor(tone) }}
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
