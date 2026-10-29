import type { Run, Session, SessionCard, SessionState } from '@acc/protocol';
import { ArrowUp, MoreHorizontal, Pin, Play, Square } from 'lucide-react';
import { useState } from 'react';
import { archiveSession, renameSession, resumeTree, setPinned, stopTree } from '../../daemon/actions';
import { useHomeSelect } from '../../daemon/home';
import { useSessions } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { type SessionTree, treeRelations } from '../../daemon/tree';
import { cn } from '../../lib/cn';
import { STATE_META, formatUsd, isSettled, sessionTitle } from '../../lib/states';
import { useUi } from '../../store/ui';
import { DelegateButton } from '../delegate/DelegateButton';
import { RepeatButton } from '../schedule/RepeatButton';
import { IconButton } from '../ui/Button';
import { CostMeter } from '../ui/CostMeter';
import { Elapsed } from '../ui/Elapsed';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger } from '../ui/Menu';
import { SessionChip } from '../ui/SessionChip';
import { StateIcon } from '../ui/StateIcon';
import { Tooltip } from '../ui/Tooltip';

const MOVING: ReadonlySet<SessionState> = new Set(['working', 'supervising', 'queued']);

/**
 * What the stop / resume control offers for a session and everything under it: stop while
 * anything moves, resume when nothing moves and something was stopped, nothing otherwise.
 */
export function treeControl(
  session: Pick<Session, 'state' | 'activeRunId' | 'supervision'>,
  subtree: readonly Pick<SessionCard, 'state'>[],
): 'stop' | 'resume' | null {
  if (session.activeRunId || MOVING.has(session.state) || subtree.some((n) => MOVING.has(n.state))) return 'stop';
  if (session.state === 'stopped' || session.supervision === 'paused' || subtree.some((n) => n.state === 'stopped')) {
    return 'resume';
  }
  return null;
}

function TitleEditor({ session }: { session: Session }) {
  const rt = useRuntime();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const start = () => {
    setValue(session.title);
    setEditing(true);
  };
  if (!editing) {
    return (
      <Tooltip content="ダブルクリックで名前を変更">
        <h1
          tabIndex={0}
          data-title
          onDoubleClick={start}
          onKeyDown={(e) => {
            if (e.key === 'F2' || e.key === 'Enter') {
              e.preventDefault();
              start();
            }
          }}
          className="min-w-0 cursor-default truncate rounded-xs px-1 text-title text-fg outline-none select-none hover:bg-hover focus-visible:bg-hover"
        >
          {sessionTitle(session)}
        </h1>
      </Tooltip>
    );
  }
  const commit = () => {
    setEditing(false);
    const t = value.trim();
    if (t && t !== session.title) void renameSession(rt, session, t);
  };
  return (
    <input
      autoFocus
      data-inline-edit
      aria-label="会話の名前"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          // Ladder step 2: cancel the inline edit only.
          e.stopPropagation();
          setEditing(false);
        }
      }}
      className="h-7 min-w-0 flex-1 rounded-xs border border-line bg-canvas px-1.5 text-title text-fg focus:border-[var(--focus-ring)]"
    />
  );
}

/** "↑ 親の題": back to the conversation that leads this one. */
function ParentChip({ id, title, state }: { id: string; title: string; state: SessionState | null }) {
  const openSession = useUi((s) => s.openSession);
  return (
    <Tooltip content="親の会話へ（Esc）">
      <button
        type="button"
        data-parent-chip={id}
        onClick={() => openSession(id)}
        className="flex h-6 max-w-56 shrink-0 items-center gap-1 rounded-sm bg-selected pr-2 pl-1.5 text-meta text-fg-2 hover:bg-hover hover:text-fg"
      >
        <ArrowUp size={12} strokeWidth={2} aria-hidden />
        {state && <StateIcon state={state} size={11} />}
        <span className="truncate">{title}</span>
      </button>
    </Tooltip>
  );
}

/** Spend of the session and of each child under it (the cost meter opens it). */
function CostBreakdown({ session, children }: { session: Session; children: SessionCard[] }) {
  const openSession = useUi((s) => s.openSession);
  const max = Math.max(session.cost.ownUsd, ...children.map((c) => c.costUsd), 0.0001);
  const rows: { id: string | null; title: string; state: SessionState | null; usd: number }[] = [
    { id: null, title: 'この会話', state: null, usd: session.cost.ownUsd },
    ...children.map((c) => ({ id: c.id, title: sessionTitle(c), state: c.state, usd: c.costUsd })),
  ];
  return (
    <div className="flex w-96 flex-col py-1.5" data-testid="cost-breakdown">
      {rows.map((r) => (
        <button
          key={r.id ?? 'self'}
          type="button"
          disabled={!r.id}
          onClick={() => r.id && openSession(r.id)}
          className="grid h-7 grid-cols-[14px_1fr_64px_48px] items-center gap-2 px-3 text-left text-ui text-fg-2 enabled:hover:bg-hover enabled:hover:text-fg"
        >
          {r.state ? <StateIcon state={r.state} size={12} /> : <span />}
          <span className="truncate">{r.title}</span>
          <span className="h-1 overflow-hidden rounded-full bg-selected">
            <span className="block h-full rounded-full bg-fg-3" style={{ width: `${(r.usd / max) * 100}%` }} />
          </span>
          <span className="text-right tabular text-meta">{formatUsd(r.usd) ?? '$0'}</span>
        </button>
      ))}
      <div className="mt-1 flex h-7 items-center justify-between border-t border-line-subtle px-3 pt-1 text-ui text-fg">
        <span>合計</span>
        <span className="tabular">{formatUsd(session.cost.treeUsd) ?? '$0'}</span>
      </div>
    </div>
  );
}

/**
 * The conversation's head (spec §5.1). Line 1: the parent (for a child), the title (double-click
 * to rename), its state, the spend against the budget, then the actions as icons: 任せる and
 * 繰り返す (a top-level conversation), stop / resume the whole tree, and more. Line 2: the
 * children as small chips (only when there are children).
 */
export function FocusHeader({
  session,
  tree,
}: {
  session: Session;
  tree: SessionTree | undefined;
  /** The run in progress (kept for callers; the controls read the session state). */
  activeRun?: Run | null;
}) {
  const rt = useRuntime();
  const connected = useConnectionState() === 'open';
  const sessions = useSessions().data;
  const openSession = useUi((s) => s.openSession);
  const [costOpen, setCostOpen] = useState(false);
  const rel = treeRelations(tree, session.id);
  const children = rel.children;
  const subtree = (tree?.nodes ?? []).filter((n) => n.id !== session.id && rel.subtree.has(n.id));
  const parentSession = session.parentSessionId ? sessions?.find((s) => s.id === session.parentSessionId) : undefined;
  const parent = session.parentSessionId
    ? {
        id: session.parentSessionId,
        title: rel.parent ? sessionTitle(rel.parent) : parentSession ? sessionTitle(parentSession) : '親の会話',
        state: rel.parent?.state ?? parentSession?.state ?? null,
      }
    : null;
  const root = !session.parentSessionId;

  // Budget: a top-level conversation's is its whole tree's (as on home); a child's is its own.
  const treeSpend = useHomeSelect((s) => s.trees.find((t) => t.root.id === session.id)?.spend ?? null);
  const budget =
    treeSpend?.limitUsd != null
      ? { limitUsd: treeSpend.limitUsd, usedUsd: treeSpend.treeUsd }
      : (rel.self?.budget ?? null);
  const hasChildren = children.length > 0;
  const used = budget ? budget.usedUsd : hasChildren ? session.cost.treeUsd : session.cost.ownUsd;
  const estimated = session.cost.source === 'estimated';

  const control = treeControl(session, subtree);
  const meta = STATE_META[session.state];
  const costShown = !!budget || !!formatUsd(used);
  const meter = <CostMeter usedUsd={used} limitUsd={budget?.limitUsd ?? null} estimated={estimated} />;

  return (
    <header className="shrink-0 border-b border-line-subtle" data-focus-header>
      <div className="flex h-11 items-center gap-2 px-4">
        {parent && <ParentChip id={parent.id} title={parent.title} state={parent.state} />}
        <TitleEditor session={session} />
        <Tooltip content={session.now ? `${meta.label} · ${session.now}` : meta.label}>
          <span className="flex shrink-0 items-center gap-1.5" data-testid="session-state" data-state={session.state}>
            <StateIcon state={session.state} size={14} />
            <Elapsed since={session.stateSince} settled={isSettled(session.state)} live={session.state === 'working'} />
          </span>
        </Tooltip>
        {session.pinned && <Pin size={12} strokeWidth={1.75} className="shrink-0 text-fg-3" aria-label="ピン留め" />}
        <span className="flex-1" />
        {hasChildren && costShown ? (
          <Popover open={costOpen} onOpenChange={setCostOpen}>
            <PopoverTrigger asChild>
              <button type="button" aria-label="費用の内訳" className="flex h-7 shrink-0 items-center rounded-sm px-1.5 hover:bg-hover">
                {meter}
              </button>
            </PopoverTrigger>
            <PopoverContent align="end">
              <CostBreakdown session={session} children={children} />
            </PopoverContent>
          </Popover>
        ) : (
          costShown && <span className="flex shrink-0 items-center px-1.5">{meter}</span>
        )}
        <span className="flex shrink-0 items-center gap-0.5">
          {root && <DelegateButton sessionId={session.id} />}
          {root && <RepeatButton sessionId={session.id} />}
          {control === 'stop' && (
            <IconButton label="止める" disabled={!connected} onClick={() => void stopTree(rt, session.id)}>
              <Square size={13} strokeWidth={2} />
            </IconButton>
          )}
          {control === 'resume' && (
            <IconButton label="再開" disabled={!connected} onClick={() => void resumeTree(rt, session.id)}>
              <Play size={14} strokeWidth={2} />
            </IconButton>
          )}
          <Menu>
            <MenuTrigger asChild>
              <IconButton label="その他の操作">
                <MoreHorizontal size={15} strokeWidth={1.5} />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => void setPinned(rt, session, !session.pinned)}>
                {session.pinned ? 'ピン留めを外す' : 'ピン留め'}
              </MenuItem>
              {hasChildren && (
                // After the menu has closed and returned focus, or the popover would close at once.
                <MenuItem onSelect={() => setTimeout(() => setCostOpen(true), 60)}>費用の内訳</MenuItem>
              )}
              <MenuSeparator />
              <MenuItem shortcut="archive" onSelect={() => void archiveSession(rt, session)}>
                アーカイブ
              </MenuItem>
            </MenuContent>
          </Menu>
        </span>
      </div>
      {hasChildren && (
        <nav aria-label="子の会話" className="flex gap-2 overflow-x-auto px-4 pb-2" data-children-row>
          {children.map((c) => (
            <SessionChip key={c.id} card={c} size="sm" onOpen={openSession} className={cn('shrink-0')} />
          ))}
        </nav>
      )}
    </header>
  );
}
