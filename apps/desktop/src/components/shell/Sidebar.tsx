import type { Session } from '@acc/protocol';
import { Hand, House, MoreHorizontal, Pin, Plus, Rows3, Settings } from 'lucide-react';
import { type ReactNode, memo } from 'react';
import { newChat } from '../../app/commands';
import { archiveSession, setPinned } from '../../daemon/actions';
import { useHomeSelect } from '../../daemon/home';
import { useSessions } from '../../daemon/queries';
import { useRuntime } from '../../daemon/runtime';
import { cn } from '../../lib/cn';
import { sessionTitle } from '../../lib/states';
import type { ShortcutId } from '../../lib/shortcuts';
import { useUi } from '../../store/ui';
import { Kbd } from '../ui/Kbd';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu';
import { NumberRoll } from '../ui/Meta';
import { ResizeHandle } from '../ui/ResizeHandle';
import { StateIcon } from '../ui/StateIcon';
import { ConnectionDot } from './TitleBar';

function NavRow({
  icon,
  label,
  active,
  shortcut,
  onClick,
  children,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  shortcut?: ShortcutId;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex h-7 items-center gap-2 rounded-sm px-2 text-ui focus-inset',
        active ? 'bg-selected text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg',
      )}
    >
      <span className={active ? 'text-fg' : 'text-fg-3'}>{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {children}
      {shortcut && (
        <span className="hidden group-hover:inline-flex">
          <Kbd id={shortcut} />
        </span>
      )}
    </button>
  );
}

const TreeRow = memo(function TreeRow({ session, active }: { session: Session; active: boolean }) {
  const rt = useRuntime();
  const openSession = useUi((s) => s.openSession);
  const title = sessionTitle(session);
  return (
    <div
      className={cn(
        'group relative flex h-7 items-center gap-2 rounded-sm pr-1 pl-2 text-ui',
        active ? 'bg-selected text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg',
      )}
    >
      <button
        type="button"
        className="absolute inset-0 rounded-sm focus-inset"
        aria-label={title}
        aria-current={active ? 'page' : undefined}
        onClick={() => openSession(session.id)}
      />
      <StateIcon state={session.state} size={13} className="pointer-events-none relative" />
      <span className="pointer-events-none relative min-w-0 flex-1 truncate">
        {session.pinned && <Pin size={11} strokeWidth={1.75} className="mr-1 inline text-fg-3" />}
        {title}
      </span>
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label="操作"
            className="invisible relative flex size-6 items-center justify-center rounded-sm text-fg-3 group-hover:visible hover:bg-selected hover:text-fg data-[state=open]:visible"
          >
            <MoreHorizontal size={14} strokeWidth={1.5} />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem onSelect={() => void setPinned(rt, session, !session.pinned)}>
            {session.pinned ? 'ピン留めを外す' : 'ピン留め'}
          </MenuItem>
          <MenuItem shortcut="archive" onSelect={() => void archiveSession(rt, session)}>
            アーカイブ
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
});

/**
 * Sidebar (ui-redesign spec §2, §4). Owned by track U2, which builds the tree rows; this
 * version keeps the new frame: new conversation, home (with the attention count), timeline,
 * the root conversations, settings and the connection at the bottom.
 */
export function Sidebar() {
  const mode = useUi((s) => s.mode);
  const width = useUi((s) => s.sidebarWidth);
  const setWidth = useUi((s) => s.setSidebarWidth);
  const focusSessionId = useUi((s) => s.focusSessionId);
  const goHome = useUi((s) => s.goHome);
  const openTimeline = useUi((s) => s.openTimeline);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const needsYou = useHomeSelect((s) => s.totals.needsYou) ?? 0;
  const sessions = useSessions().data ?? [];
  const roots = sessions
    .filter((s) => !s.parentSessionId && !s.archivedAt)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivityAt.localeCompare(a.lastActivityAt));
  const activeRoot = (() => {
    const cur = sessions.find((s) => s.id === focusSessionId);
    return mode === 'session' ? (cur?.rootSessionId ?? focusSessionId) : null;
  })();

  return (
    <nav aria-label="サイドバー" className="relative flex h-full shrink-0 flex-col bg-app" style={{ width }} data-region="sidebar">
      <div className="flex flex-col gap-px px-2 pt-1">
        <NavRow icon={<Plus size={15} strokeWidth={1.5} />} label="新しい会話" shortcut="newChat" active={mode === 'session' && !focusSessionId} onClick={() => newChat()} />
        <NavRow icon={<House size={15} strokeWidth={1.5} />} label="ホーム" shortcut="modeHome" active={mode === 'home'} onClick={goHome}>
          {needsYou > 0 && (
            <span className="flex items-center gap-0.5 text-meta text-st-needs_you group-hover:hidden">
              <Hand size={12} strokeWidth={2} aria-hidden />
              <NumberRoll value={needsYou} />
            </span>
          )}
        </NavRow>
        <NavRow icon={<Rows3 size={15} strokeWidth={1.5} />} label="タイムライン" shortcut="modeTimeline" active={mode === 'timeline'} onClick={openTimeline} />
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto border-t border-line-subtle px-2 pt-2 pb-2">
        <div className="flex flex-col gap-px">
          {roots.map((s) => (
            <TreeRow key={s.id} session={s} active={activeRoot === s.id} />
          ))}
        </div>
      </div>

      <div className="flex h-11 items-center gap-2 border-t border-line-subtle px-2 pr-4 text-ui text-fg-2">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex h-7 flex-1 items-center gap-2 rounded-sm px-2 hover:bg-hover hover:text-fg focus-inset"
        >
          <Settings size={15} strokeWidth={1.5} className="text-fg-3" />
          <span className="flex-1 text-left">設定</span>
        </button>
        <ConnectionDot />
      </div>
      <ResizeHandle edge="right" width={width} onResize={setWidth} label="サイドバーの幅" />
    </nav>
  );
}
