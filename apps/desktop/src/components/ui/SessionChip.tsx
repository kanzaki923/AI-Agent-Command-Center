import type { Attention, SessionCard } from '@acc/protocol';
import { useState } from 'react';
import { useAttentionItems } from '../../daemon/home';
import { cn } from '../../lib/cn';
import { OUTPUT_META, STATE_META, formatUsd, isAlarm, isSettled, sessionTitle } from '../../lib/states';
import { Elapsed } from './Elapsed';
import { OutputIcon, RoleIcon } from './SemanticIcons';
import { StateIcon } from './StateIcon';
import { Tooltip } from './Tooltip';

/**
 * One session as a chip (spec §1.4): the home lanes (`md`) and a conversation's row of
 * children (`sm`). Line 1: state icon and title. Line 2: what it is doing now, the attention
 * it waits on (amber), its failure (red), its outputs when done or waiting for review.
 * Line 3 (md): time in this state and spend. Needs-you and failed chips get a coloured frame.
 */
export function SessionChip({
  card,
  size = 'md',
  selected = false,
  onOpen,
  attention,
  className,
}: {
  card: SessionCard;
  size?: 'md' | 'sm';
  selected?: boolean;
  onOpen?: (sessionId: string) => void;
  /** The attention items of this session (default: looked up from the home snapshot). */
  attention?: Attention[];
  className?: string;
}) {
  const looked = useAttentionItems(attention ? [] : card.attentionIds);
  const items = attention ?? looked;
  const meta = STATE_META[card.state];

  // One soft flash when the chip becomes needs_you (derived during render, no effect).
  const [prevState, setPrevState] = useState(card.state);
  const [flash, setFlash] = useState(0);
  if (prevState !== card.state) {
    setPrevState(card.state);
    if (card.state === 'needs_you') setFlash((n) => n + 1);
  }

  const alarm = isAlarm(card.state);
  const title = sessionTitle(card);
  const cost = formatUsd(card.costUsd);
  const line2 = <ChipDetail card={card} attention={items} />;

  return (
    <button
      type="button"
      data-session-chip={card.id}
      data-state={card.state}
      data-selected={selected || undefined}
      aria-label={`${title}（${meta.label}）`}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onOpen?.(card.id)}
      className={cn(
        'group relative flex min-w-0 flex-col items-stretch rounded-md border bg-surface text-left transition-[border-color,background-color] duration-200 hover:bg-raised',
        size === 'md' ? 'h-[66px] gap-0.5 px-2.5 py-2' : 'h-11 w-44 shrink-0 gap-0 px-2 py-1',
        alarm ? 'border-transparent' : 'border-line-subtle',
        selected && 'ring-2 ring-[var(--focus-ring)] ring-offset-1 ring-offset-[var(--bg-canvas)]',
        className,
      )}
      style={alarm ? { borderColor: `color-mix(in oklch, ${meta.color} 70%, transparent)` } : undefined}
    >
      {flash > 0 && <span key={flash} aria-hidden className="acc-alarm-once pointer-events-none absolute inset-0 rounded-md" />}
      <span className="flex min-w-0 items-center gap-1.5">
        <StateIcon state={card.state} size={size === 'md' ? 14 : 13} />
        <span className={cn('min-w-0 flex-1 truncate font-medium text-fg', size === 'md' ? 'text-ui' : 'text-meta')}>{title}</span>
        {card.startedBy === 'schedule' && <RoleIcon role={card.role} scheduled size={12} className="text-fg-3" />}
      </span>
      <span className={cn('flex h-4 min-w-0 items-center gap-1 pl-5 text-meta', size === 'sm' && 'pl-[19px]')}>{line2}</span>
      {size === 'md' && (
        <span className="mt-auto flex items-center justify-between pl-5">
          <Elapsed since={card.stateSince} settled={isSettled(card.state)} live={card.state === 'working'} />
          {cost && <span className="tabular text-meta text-fg-3">{cost}</span>}
        </span>
      )}
    </button>
  );
}

/** Line 2 of a chip: the one fact that matters for its state. */
function ChipDetail({ card, attention }: { card: SessionCard; attention: Attention[] }) {
  const first = attention[0] ?? null;
  if (card.state === 'needs_you' && first) {
    return <span className="truncate text-st-needs_you">{first.title}</span>;
  }
  if (card.state === 'failed') {
    const failure = attention.find((a) => a.kind === 'failure') ?? first;
    return <span className="truncate text-st-failed">{failure?.title ?? STATE_META.failed.label}</span>;
  }
  if ((card.state === 'done' || card.state === 'review') && card.outputs.length > 0) {
    return <Outputs card={card} />;
  }
  if (card.now) return <span className="truncate text-fg-2">{card.now}</span>;
  return null;
}

/** Output kinds with their counts (`📄 2`); review shows the kind name too. */
function Outputs({ card }: { card: SessionCard }) {
  const counts = new Map<string, number>();
  for (const o of card.outputs) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1);
  const kinds = [...counts.entries()] as [keyof typeof OUTPUT_META, number][];
  return (
    <Tooltip content={card.outputs.map((o) => o.title).join('、')}>
      <span className="flex min-w-0 items-center gap-2 text-fg-2">
        {kinds.map(([kind, n]) => (
          <span key={kind} className="flex items-center gap-0.5">
            <OutputIcon kind={kind} size={12} className="text-fg-3" />
            {card.state === 'review' ? <span className="truncate">{OUTPUT_META[kind].label}</span> : null}
            {n > 1 && <span className="tabular">{n}</span>}
          </span>
        ))}
      </span>
    </Tooltip>
  );
}
