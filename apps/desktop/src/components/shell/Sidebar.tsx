import { ChevronRight, LayoutGrid, MoreHorizontal, Pin, Plus, Settings, SquareActivity, Target } from 'lucide-react';
import { type ReactNode, memo } from 'react';
import { newChat, switchMode } from '../../app/commands';
import { archiveSession, setPinned } from '../../daemon/actions';
import { useRuntime } from '../../daemon/runtime';
import { useNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { DAY_BUCKET_LABEL, type DayBucket, dayBucket } from '../../lib/format';
import type { AttentionState } from '../../lib/status';
import { type BoardItem, attentionCounts, elapsedRange } from '../../model/board';
import { useBoard } from '../../model/useBoard';
import { type Mode, useUi } from '../../store/ui';
import { Kbd } from '../ui/Kbd';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu';
import { ElapsedTime, NumberRoll, TimeStamp } from '../ui/Meta';
import { ResizeHandle } from '../ui/ResizeHandle';
import { StatusIcon } from '../ui/StatusIcon';
import { ConnectionDot } from './TitleBar';

const MODES: { mode: Mode; label: string; icon: ReactNode; shortcut: 'modeCommand' | 'modeFocus' | 'modeTimeline' }[] = [
  { mode: 'command', label: '司令室', icon: <LayoutGrid size={15} strokeWidth={1.5} />, shortcut: 'modeCommand' },
  { mode: 'focus', label: 'フォーカス', icon: <Target size={15} strokeWidth={1.5} />, shortcut: 'modeFocus' },
  { mode: 'timeline', label: 'タイムライン', icon: <SquareActivity size={15} strokeWidth={1.5} />, shortcut: 'modeTimeline' },
];

const ATTN_ROWS: { state: AttentionState; label: string }[] = [
  { state: 'awaiting_approval', label: '承認待ち' },
  { state: 'failed', label: '失敗' },
  { state: 'interrupted', label: '中断' },
  { state: 'review', label: '統合待ち' },
];

function SectionHeader({
  label,
  count,
  collapsible,
  collapsed,
  onToggle,
}: {
  label: string;
  count?: number;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const content = (
    <>
      <span className="flex-1 text-left">{label}</span>
      {count != null && count > 0 && <span className="tabular text-fg-3">{count}</span>}
      {collapsible && (
        <ChevronRight
          size={12}
          strokeWidth={1.75}
          className={cn('text-fg-4 transition-transform duration-[120ms]', !collapsed && 'rotate-90')}
        />
      )}
    </>
  );
  const cls = 'flex h-7 w-full items-center gap-2 px-2 text-micro text-fg-3';
  return collapsible ? (
    <button type="button" className={cn(cls, 'rounded-sm hover:text-fg-2')} onClick={onToggle} aria-expanded={!collapsed}>
      {content}
    </button>
  ) : (
    <div className={cls}>{content}</div>
  );
}

const SessionRow = memo(function SessionRow({ item, active }: { item: BoardItem; active: boolean }) {
  const rt = useRuntime();
  const openSession = useUi((s) => s.openSession);
  const viewedAt = useUi((s) => (item.session ? s.viewedAt[item.session.id] : undefined));
  const session = item.session;
  if (!session) return null;
  const unread = !active && !!viewedAt && session.lastActivityAt > viewedAt;
  const range = elapsedRange(item);
  const live = item.state === 'running' || item.state === 'awaiting_approval';
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
        aria-label={`${item.title} を開く`}
        aria-current={active ? 'page' : undefined}
        onClick={() => openSession(session.id)}
      />
      <StatusIcon state={item.state} size={14} className="pointer-events-none relative" />
      <span className="pointer-events-none relative min-w-0 flex-1 truncate">
        {session.pinned && <Pin size={11} strokeWidth={1.75} className="mr-1 inline text-fg-3" />}
        {item.title}
      </span>
      <span className="pointer-events-none relative flex items-center gap-1.5 group-hover:invisible">
        {unread && <span className="size-1.5 rounded-full bg-accent" aria-label="未読" />}
        {live ? (
          <ElapsedTime start={range.start} />
        ) : (
          <TimeStamp iso={item.run?.endedAt ?? session.lastActivityAt} />
        )}
      </span>
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label="セッションの操作"
            className="invisible absolute right-1 flex size-6 items-center justify-center rounded-sm text-fg-3 group-hover:visible hover:bg-selected hover:text-fg data-[state=open]:visible"
          >
            <MoreHorizontal size={14} strokeWidth={1.5} />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem onSelect={() => openSession(session.id)}>開く</MenuItem>
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

export function Sidebar() {
  const rt = useRuntime();
  const mode = useUi((s) => s.mode);
  const width = useUi((s) => s.sidebarWidth);
  const setWidth = useUi((s) => s.setSidebarWidth);
  const focusSessionId = useUi((s) => s.focusSessionId);
  const collapsed = useUi((s) => s.collapsed);
  const toggleCollapsed = useUi((s) => s.toggleCollapsed);
  const select = useUi((s) => s.select);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const { items } = useBoard();
  const now = useNow();
  const counts = attentionCounts(items);
  const sessions = items.filter((i) => i.kind === 'session');
  const runningCount = sessions.filter((i) => i.state === 'running' || i.state === 'awaiting_approval').length;

  const attention = sessions.filter((i) => i.zone === 'attention');
  // 実行中 lists live sessions only; failed / review items are reached via 要対応.
  const live = sessions.filter(
    (i) => i.state === 'awaiting_approval' || i.state === 'running' || i.state === 'queued',
  );
  const recentGroups = (() => {
    const rest = sessions
      .filter((i) => !live.includes(i))
      .sort((a, b) => {
        const pa = a.session?.pinned ? 1 : 0;
        const pb = b.session?.pinned ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return (b.session?.lastActivityAt ?? '').localeCompare(a.session?.lastActivityAt ?? '');
      });
    const groups: { bucket: DayBucket | 'pinned'; items: BoardItem[] }[] = [];
    for (const it of rest) {
      const bucket = it.session?.pinned ? 'pinned' : dayBucket(it.session?.lastActivityAt ?? '', now);
      const last = groups[groups.length - 1];
      if (last?.bucket === bucket) last.items.push(it);
      else groups.push({ bucket, items: [it] });
    }
    return groups;
  })();

  const jumpTo = (state: AttentionState) => {
    const target = attention.find((i) => i.state === state) ?? items.find((i) => i.state === state);
    if (!target) return;
    select(target.id, true);
    switchMode(rt, 'command');
  };

  const isCollapsed = (key: string, def = false) => collapsed[key] ?? def;

  return (
    <nav
      aria-label="サイドバー"
      className="relative flex h-full shrink-0 flex-col bg-app"
      style={{ width }}
      data-region="sidebar"
    >
      <div className="flex flex-col gap-px px-2 pt-1">
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            onClick={() => switchMode(rt, m.mode)}
            aria-current={mode === m.mode ? 'page' : undefined}
            className={cn(
              'group flex h-7 items-center gap-2 rounded-sm px-2 text-ui focus-inset',
              mode === m.mode ? 'bg-selected text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg',
            )}
          >
            <span className={mode === m.mode ? 'text-fg' : 'text-fg-3'}>{m.icon}</span>
            <span className="flex-1 text-left">{m.label}</span>
            {m.mode === 'command' && runningCount > 0 && (
              <span className="tabular text-meta text-fg-3 group-hover:hidden">{runningCount}</span>
            )}
            <span className="hidden group-hover:inline-flex">
              <Kbd id={m.shortcut} />
            </span>
          </button>
        ))}
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <SectionHeader label="要対応" count={counts.total} />
        {counts.total === 0 ? (
          <div className="px-2 pb-1 text-meta text-fg-4">要対応はありません</div>
        ) : (
          <div className="flex flex-col gap-px" aria-live="polite">
            {ATTN_ROWS.filter((r) => counts[r.state] > 0).map((r) => (
              <button
                key={r.state}
                type="button"
                onClick={() => jumpTo(r.state)}
                className="flex h-7 items-center gap-2 rounded-sm pr-2 pl-4 text-ui text-fg-2 hover:bg-hover hover:text-fg focus-inset"
              >
                <StatusIcon state={r.state} size={13} />
                <span className="flex-1 text-left">{r.label}</span>
                <NumberRoll value={counts[r.state]} className="text-meta text-fg-2" />
              </button>
            ))}
          </div>
        )}

        {live.length > 0 && (
          <>
            <div className="mt-3" />
            <SectionHeader
              label="実行中"
              count={live.length}
              collapsible
              collapsed={isCollapsed('sb.running')}
              onToggle={() => toggleCollapsed('sb.running')}
            />
            {!isCollapsed('sb.running') && (
              <div className="flex flex-col gap-px">
                {live.map((it) => (
                  <SessionRow key={it.id} item={it} active={mode === 'focus' && focusSessionId === it.id} />
                ))}
              </div>
            )}
          </>
        )}

        <div className="mt-3" />
        <SectionHeader
          label="最近"
          collapsible
          collapsed={isCollapsed('sb.recent')}
          onToggle={() => toggleCollapsed('sb.recent')}
        />
        {!isCollapsed('sb.recent') &&
          recentGroups.map((g) => (
            <div key={g.bucket} className="mb-1">
              <div className="flex h-6 items-center px-2 text-[11px] text-fg-4">
                {g.bucket === 'pinned' ? 'ピン留め' : DAY_BUCKET_LABEL[g.bucket]}
              </div>
              <div className="flex flex-col gap-px">
                {g.items.map((it) => (
                  <SessionRow key={it.id} item={it} active={mode === 'focus' && focusSessionId === it.id} />
                ))}
              </div>
            </div>
          ))}
        {!isCollapsed('sb.recent') && recentGroups.length === 0 && (
          <div className="px-2 text-meta text-fg-4">まだセッションはありません</div>
        )}
      </div>

      <div className="flex flex-col gap-px border-t border-line-subtle px-2 py-2">
        <button
          type="button"
          onClick={() => void newChat(rt)}
          className="group flex h-7 items-center gap-2 rounded-sm px-2 text-ui text-fg-2 hover:bg-hover hover:text-fg focus-inset"
        >
          <Plus size={15} strokeWidth={1.5} className="text-fg-3" />
          <span className="flex-1 text-left">新しいチャット</span>
          <Kbd id="newChat" />
        </button>
        <div className="flex h-7 items-center gap-2 rounded-sm pr-2 text-ui text-fg-2">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex h-7 flex-1 items-center gap-2 rounded-sm px-2 hover:bg-hover hover:text-fg focus-inset"
          >
            <Settings size={15} strokeWidth={1.5} className="text-fg-3" />
            <span className="flex-1 text-left">設定</span>
          </button>
          <ConnectionDot withLabel />
        </div>
      </div>
      <ResizeHandle edge="right" width={width} onResize={setWidth} label="サイドバーの幅" />
    </nav>
  );
}
