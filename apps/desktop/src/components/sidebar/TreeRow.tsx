import type { Session, SessionState } from '@acc/protocol';
import { Archive, ChevronRight, Clock, MoreHorizontal, Pin } from 'lucide-react';
import { useState } from 'react';
import { archiveSession, setPinned } from '../../daemon/actions';
import { useRuntime } from '../../daemon/runtime';
import { useSlowNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { STATE_META, formatNextRun, isAlarm, sessionTitle } from '../../lib/states';
import { useUi, useUnread } from '../../store/ui';
import { Elapsed } from '../ui/Elapsed';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu';
import { StateIcon } from '../ui/StateIcon';
import { Tooltip } from '../ui/Tooltip';
import { UnreadDot } from '../ui/UnreadDot';
import { type VisibleRow, childDots, stateCountsLabel } from './model';

/** Left padding of a root row, and the indent of each level (px). */
export const ROW_PAD = 8;
export const INDENT = 18;
const ICON = 13;
/** x of the centre of the state icon of a row at `depth` (where its children's line starts). */
const iconCenter = (depth: number) => ROW_PAD + depth * INDENT + ICON / 2;

/** Hollow dots: nothing is happening there. */
const HOLLOW = new Set<SessionState>(['queued', 'stopped', 'idle']);

/**
 * One child's state as a dot: needing you / failed keep their shape (hand, warning) so they
 * read without colour; the rest are 6px dots in the state colour, hollow when nothing moves.
 */
function Dot({ state }: { state: SessionState }) {
  if (isAlarm(state)) return <StateIcon state={state} size={11} className="mx-px" />;
  const color = STATE_META[state].color;
  return (
    <span
      role="img"
      aria-label={STATE_META[state].label}
      data-state={state}
      className="mx-[2px] inline-block size-1.5 shrink-0 rounded-full transition-colors duration-200"
      style={HOLLOW.has(state) ? { boxShadow: `inset 0 0 0 1.25px ${color}` } : { background: color }}
    />
  );
}

/** Folded children as dots (max 6, then +N); the button unfolds them. */
function ChildToggle({
  descendants,
  open,
  onToggle,
}: {
  descendants: Session[];
  open: boolean;
  onToggle: () => void;
}) {
  const dots = childDots(descendants);
  return (
    <Tooltip content={open ? null : stateCountsLabel(descendants)}>
      <button
        type="button"
        tabIndex={-1}
        aria-expanded={open}
        aria-label={open ? '子をたたむ' : '子を表示'}
        data-child-toggle
        onClick={onToggle}
        className="relative flex h-6 shrink-0 items-center gap-px rounded-sm pr-0.5 pl-1 text-fg-3 hover:bg-selected hover:text-fg-2"
      >
        {!open && (
          <span className="flex items-center" data-child-dots>
            {dots.states.map((s, i) => (
              <Dot key={i} state={s} />
            ))}
            {dots.more > 0 && <span className="ml-0.5 text-micro text-fg-3 tabular">+{dots.more}</span>}
          </span>
        )}
        <ChevronRight
          size={12}
          strokeWidth={2}
          aria-hidden
          className={cn('transition-transform duration-150', open && 'rotate-90')}
        />
      </button>
    </Tooltip>
  );
}

function NextRun({ at }: { at: string }) {
  const now = useSlowNow();
  return (
    <span className="relative flex shrink-0 items-center gap-0.5 text-meta text-fg-3 tabular" data-next-run>
      <Clock size={11} strokeWidth={2} aria-hidden />
      {formatNextRun(at, now)}
    </span>
  );
}

/**
 * Tree lines of a row: guides of the ancestors, ├ or └ to this row, and (open) the start of
 * the line down to its children. Lines reach 1px past the row, over the gap between rows.
 */
function TreeLines({ row }: { row: VisibleRow }) {
  const { depth, guides, last, open } = row;
  if (depth === 0 && !open) return null;
  const x = iconCenter(depth - 1);
  return (
    <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0">
      {guides.map((on, i) =>
        on ? (
          <span key={i} className="absolute top-0 -bottom-px border-l border-line" style={{ left: iconCenter(i) - 0.5 }} />
        ) : null,
      )}
      {depth > 0 && (
        <span
          className="absolute top-0 h-1/2 rounded-bl-[5px] border-b border-l border-line"
          style={{ left: x - 0.5, width: ROW_PAD + depth * INDENT - x - 2 }}
        />
      )}
      {depth > 0 && !last && <span className="absolute top-1/2 -bottom-px border-l border-line" style={{ left: x - 0.5 }} />}
      {open && (
        <span
          className="absolute -bottom-px border-l border-line"
          style={{ left: iconCenter(depth) - 0.5, top: `calc(50% + ${ICON / 2 + 2}px)` }}
        />
      )}
    </span>
  );
}

/**
 * One conversation in the sidebar tree (spec §4): state icon, title, and on the right the
 * folded children as dots (or the time it has been working, or the next scheduled run).
 * Hover / right-click: the row menu.
 */
export function TreeRow({
  row,
  active,
  nextRunAt,
  onToggle,
}: {
  row: VisibleRow;
  active: boolean;
  nextRunAt: string | null;
  onToggle: (id: string) => void;
}) {
  const rt = useRuntime();
  const openSession = useUi((s) => s.openSession);
  const [menuOpen, setMenuOpen] = useState(false);
  const { node, depth } = row;
  const s = node.session;
  const title = sessionTitle(s);
  const hasChildren = node.children.length > 0;
  const working = s.state === 'working';
  const unread = useUnread(s) && depth === 0;

  return (
    <div
      data-sidebar-item={s.id}
      data-depth={depth}
      className={cn(
        'group relative flex h-7 shrink-0 items-center gap-2 rounded-sm pr-1 text-ui',
        active ? 'bg-selected text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg',
      )}
      style={{ paddingLeft: ROW_PAD + depth * INDENT }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
    >
      <TreeLines row={row} />
      <button
        type="button"
        data-sidebar-row={s.id}
        className="absolute inset-0 rounded-sm focus-inset"
        aria-label={title}
        aria-current={active ? 'page' : undefined}
        aria-expanded={hasChildren ? row.open : undefined}
        onClick={() => openSession(s.id)}
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault();
            setMenuOpen(true);
          }
        }}
      />
      <StateIcon state={s.state} size={ICON} className="pointer-events-none relative" />
      <span className={cn('pointer-events-none relative min-w-0 flex-1 truncate', depth === 0 && 'font-medium', unread && 'text-fg')}>
        {s.pinned && depth === 0 && <Pin size={11} strokeWidth={1.75} className="mr-1 inline text-fg-3" aria-label="ピン留め" />}
        {title}
      </span>
      {unread && <UnreadDot className="pointer-events-none relative mx-1" />}
      {nextRunAt && <NextRun at={nextRunAt} />}
      {!hasChildren && working && (
        <Elapsed since={s.stateSince} settled={false} live className="pointer-events-none relative" />
      )}
      {hasChildren && <ChildToggle descendants={node.descendants} open={row.open} onToggle={() => onToggle(s.id)} />}
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <MenuTrigger asChild>
          <button
            type="button"
            tabIndex={-1}
            aria-label="操作"
            className="relative hidden size-6 shrink-0 items-center justify-center rounded-sm text-fg-3 group-hover:flex hover:bg-selected hover:text-fg data-[state=open]:flex"
          >
            <MoreHorizontal size={14} strokeWidth={1.5} />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          {depth === 0 && (
            <MenuItem icon={<Pin size={14} strokeWidth={1.5} />} onSelect={() => void setPinned(rt, s, !s.pinned)}>
              {s.pinned ? 'ピン留めを外す' : 'ピン留め'}
            </MenuItem>
          )}
          <MenuItem icon={<Archive size={14} strokeWidth={1.5} />} shortcut="archive" onSelect={() => void archiveSession(rt, s)}>
            アーカイブ
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
