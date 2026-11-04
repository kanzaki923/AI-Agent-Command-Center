import { Diamond, Hand, House, Plus, Rows3, Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import { newChat } from '../../app/commands';
import { useAssistantId } from '../../daemon/assistant';
import { useHomeSelect } from '../../daemon/home';
import { useAssistantSeat } from '../../daemon/members';
import { useSessions, useSettings } from '../../daemon/queries';
import { cn } from '../../lib/cn';
import type { ShortcutId } from '../../lib/shortcuts';
import { useUi, useUnread } from '../../store/ui';
import { Roster } from '../members/Roster';
import { ConversationTree } from '../sidebar/ConversationTree';
import { MemberFace } from '../ui/Face';
import { Kbd } from '../ui/Kbd';
import { NumberRoll } from '../ui/Meta';
import { ResizeHandle } from '../ui/ResizeHandle';
import { UnreadDot } from '../ui/UnreadDot';
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

/** The fixed row of the assistant (right-hand spec §2.2): its conversation, with the unread dot. */
function AssistantRow() {
  const id = useAssistantId();
  const session = useSessions().data?.find((s) => s.id === id);
  const active = useUi((s) => s.mode === 'session' && !!id && s.focusSessionId === id);
  const openSession = useUi((s) => s.openSession);
  const unread = useUnread(session ?? { id: '', state: 'idle', stateSince: null });
  // A member in the assistant's seat lends it its face and name; the seat stays 右腕.
  const seat = useAssistantSeat(useSettings().data?.assistant?.characterId);
  if (!id) return null;
  return (
    <NavRow
      icon={seat ? <MemberFace member={seat} size={16} /> : <Diamond size={15} strokeWidth={1.75} />}
      label={seat ? seat.name : '右腕'}
      active={active}
      onClick={() => openSession(id)}
    >
      {seat && <span className="text-micro text-fg-3 group-hover:hidden">右腕</span>}
      {unread && <UnreadDot className="group-hover:hidden" />}
    </NavRow>
  );
}

/**
 * Sidebar (ui-redesign spec §2, §4): new conversation, home (with the attention count), the
 * assistant, timeline, the conversation tree, and settings with the connection at the bottom.
 */
export function Sidebar() {
  const mode = useUi((s) => s.mode);
  const width = useUi((s) => s.sidebarWidth);
  const setWidth = useUi((s) => s.setSidebarWidth);
  const drafting = useUi((s) => s.mode === 'session' && !s.focusSessionId);
  const goHome = useUi((s) => s.goHome);
  const openTimeline = useUi((s) => s.openTimeline);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const needsYou = useHomeSelect((s) => s.totals.needsYou) ?? 0;

  return (
    <nav aria-label="サイドバー" className="relative flex h-full shrink-0 flex-col bg-app" style={{ width }} data-region="sidebar">
      <div className="flex flex-col gap-px px-2 pt-1">
        <NavRow icon={<Plus size={15} strokeWidth={1.75} />} label="新しい会話" shortcut="newChat" active={drafting} onClick={() => newChat()} />
        <NavRow icon={<House size={15} strokeWidth={1.75} />} label="ホーム" shortcut="modeHome" active={mode === 'home'} onClick={goHome}>
          {needsYou > 0 && (
            <span className="flex items-center gap-0.5 text-meta text-st-needs_you group-hover:hidden">
              <Hand size={12} strokeWidth={2} aria-hidden />
              <NumberRoll value={needsYou} />
            </span>
          )}
        </NavRow>
        <AssistantRow />
        <NavRow icon={<Rows3 size={15} strokeWidth={1.75} />} label="タイムライン" shortcut="modeTimeline" active={mode === 'timeline'} onClick={openTimeline} />
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto border-t border-line-subtle px-2 pt-2 pb-2">
        <ConversationTree />
      </div>

      <Roster />

      <div className="flex h-11 items-center gap-2 border-t border-line-subtle px-2 pr-4 text-ui text-fg-2">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex h-7 flex-1 items-center gap-2 rounded-sm px-2 hover:bg-hover hover:text-fg focus-inset"
        >
          <Settings size={15} strokeWidth={1.75} className="text-fg-3" />
          <span className="flex-1 text-left">設定</span>
        </button>
        <ConnectionDot />
      </div>
      <ResizeHandle edge="right" width={width} onResize={setWidth} label="サイドバーの幅" />
    </nav>
  );
}
