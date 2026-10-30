import type { Attention, SessionCard } from '@acc/protocol';
import { useState } from 'react';
import { useAttentionItems } from '../../daemon/home';
import { useSlowNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { LONG_WORK_MS, OUTPUT_META, STATE_META, formatSince, formatUsd, isAlarm, isLongWork, isSettled, sessionTitle } from '../../lib/states';
import { Elapsed } from './Elapsed';
import { OutputIcon, RoleIcon } from './SemanticIcons';
import { StateIcon } from './StateIcon';
import { Tooltip } from './Tooltip';

export { LONG_WORK_MS };

/**
 * One session as a chip (ui-rework spec §2): the home lanes (`md`) and a conversation's row
 * of children (`sm`). Line 1: state icon and title. Line 2: what it is doing now, the
 * attention it waits on (amber), its failure (red), its outputs when done or waiting for
 * review. No numbers on the face: time in state and spend live in the tooltip, except a
 * working chip that has been at it for over ten minutes, which says so at the right end.
 * A working chip breathes; one that just arrived (done / review) lights once; needs-you and
 * failed chips get a coloured frame.
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
  const now = useSlowNow();

  // One soft flash when the chip becomes needs_you, one light when its work arrives
  // (derived during render, no effect).
  const [prevState, setPrevState] = useState(card.state);
  const [flash, setFlash] = useState<{ n: number; kind: 'alarm' | 'arrive'; color?: string }>({ n: 0, kind: 'alarm' });
  if (prevState !== card.state) {
    setPrevState(card.state);
    if (card.state === 'needs_you') setFlash((f) => ({ n: f.n + 1, kind: 'alarm' }));
    else if (card.state === 'done' || card.state === 'review') {
      setFlash((f) => ({ n: f.n + 1, kind: 'arrive', color: STATE_META[card.state].color }));
    }
  }

  const alarm = isAlarm(card.state);
  const working = card.state === 'working';
  const title = sessionTitle(card);
  const since = card.stateSince ? formatSince(card.stateSince, Math.max(now, Date.parse(card.stateSince)), isSettled(card.state)) : null;
  const cost = formatUsd(card.costUsd);
  const tip = [meta.label, since, cost].filter(Boolean).join(' · ');
  const longWork = isLongWork(card.state, card.stateSince, now);

  return (
    <Tooltip content={tip}>
      <button
        type="button"
        data-session-chip={card.id}
        data-state={card.state}
        data-selected={selected || undefined}
        aria-label={`${title}（${meta.label}）`}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onOpen?.(card.id)}
        className={cn(
          'group relative flex min-w-0 flex-col items-stretch overflow-hidden rounded-md border bg-surface text-left transition-[border-color,background-color] duration-200 hover:bg-raised',
          size === 'md' ? 'h-14 gap-0.5 px-2.5 py-2' : 'h-11 w-44 shrink-0 gap-0 px-2 py-1',
          alarm ? '' : 'border-transparent',
          working && 'acc-breathe-face',
          selected && 'ring-2 ring-[var(--focus-ring)] ring-offset-1 ring-offset-[var(--bg-canvas)]',
          className,
        )}
        style={alarm ? { borderColor: `color-mix(in oklch, ${meta.color} 60%, transparent)` } : undefined}
      >
        {flash.n > 0 && (
          <span
            key={flash.n}
            aria-hidden
            className={cn('pointer-events-none absolute inset-0 rounded-md', flash.kind === 'alarm' ? 'acc-alarm-once' : 'acc-arrive-once')}
            style={flash.kind === 'arrive' ? ({ '--arrive-color': flash.color } as React.CSSProperties) : undefined}
          />
        )}
        <span className="relative flex min-w-0 items-center gap-1.5">
          <StateIcon state={card.state} size={size === 'md' ? 14 : 13} />
          <span className={cn('min-w-0 flex-1 truncate font-medium text-fg', size === 'md' ? 'text-[14px] leading-5' : 'text-meta')}>
            {title}
          </span>
          {card.startedBy === 'schedule' && <RoleIcon role={card.role} scheduled size={12} className="text-fg-3" />}
        </span>
        <span className={cn('relative flex h-4 min-w-0 items-center gap-1 pl-5 text-meta', size === 'sm' && 'pl-[19px]')}>
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <ChipDetail card={card} attention={items} />
          </span>
          {longWork && size === 'md' && (
            <Elapsed since={card.stateSince} settled={false} live={false} className="shrink-0" />
          )}
        </span>
      </button>
    </Tooltip>
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
  if (card.state === 'working' || card.state === 'queued' || card.state === 'stopped') {
    return <span className="truncate text-fg-3">{STATE_META[card.state].label}</span>;
  }
  return null;
}

/** One output: its icon and title. Several: the kinds with their counts (`📄 2`). */
function Outputs({ card }: { card: SessionCard }) {
  if (card.outputs.length === 1) {
    const o = card.outputs[0]!;
    // An output named like its session (a code change) says its kind instead of repeating the title.
    const text = o.title.trim() === sessionTitle(card).trim() ? OUTPUT_META[o.kind].label : o.title;
    return (
      <span className="flex min-w-0 items-center gap-1 text-fg-2">
        <OutputIcon kind={o.kind} size={12} className="shrink-0 text-fg-3" />
        <span className="truncate">{text}</span>
      </span>
    );
  }
  const counts = new Map<string, number>();
  for (const o of card.outputs) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1);
  const kinds = [...counts.entries()] as [keyof typeof OUTPUT_META, number][];
  return (
    <span className="flex min-w-0 items-center gap-2 text-fg-2" title={card.outputs.map((o) => o.title).join('、')}>
      {kinds.map(([kind, n]) => (
        <span key={kind} className="flex items-center gap-0.5">
          <OutputIcon kind={kind} size={12} className="text-fg-3" />
          {card.state === 'review' ? <span className="truncate">{OUTPUT_META[kind].label}</span> : null}
          {n > 1 && <span className="tabular">{n}</span>}
        </span>
      ))}
    </span>
  );
}
