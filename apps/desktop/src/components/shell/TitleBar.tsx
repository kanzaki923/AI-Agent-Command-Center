import { ChevronDown, ChevronRight, Folder, PanelLeft, Plus, Search, Settings2 } from 'lucide-react';
import { ProjectFacts } from '../project/ProjectDialog';
import { useMemo } from 'react';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { useProjects, useRuns, useSessions } from '../../daemon/queries';
import { sumUsage } from '../../lib/format';
import { attentionCounts, untitled } from '../../model/board';
import { useBoard } from '../../model/useBoard';
import { useIsDemo } from '../../model/useDemo';
import { useUi } from '../../store/ui';
import { goToAttention } from '../../app/commands';
import { IconButton } from '../ui/Button';
import { Kbd } from '../ui/Kbd';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '../ui/Menu';
import { Cost, NumberRoll } from '../ui/Meta';
import { Tooltip } from '../ui/Tooltip';
import { WindowControls } from './WindowControls';

const MODE_LABEL = { command: '司令室', focus: 'フォーカス', timeline: 'タイムライン' } as const;

export function ConnectionDot({ withLabel = false }: { withLabel?: boolean }) {
  const state = useConnectionState();
  const color =
    state === 'open' ? 'var(--st-completed)' : state === 'closed' ? 'var(--st-failed)' : 'var(--st-awaiting_approval)';
  const label =
    state === 'open' ? '接続中' : state === 'closed' ? '切断' : state === 'connecting' ? '接続しています' : '再接続中';
  return (
    <Tooltip content={`Core Daemon: ${label}`}>
      <span className="inline-flex items-center gap-1.5" role="status" aria-label={`Core Daemon ${label}`}>
        <span className="size-1.5 rounded-full" style={{ background: color }} />
        {withLabel && <span className="text-meta text-fg-3">{label}</span>}
      </span>
    </Tooltip>
  );
}

function todayStart(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** 40px custom title bar (§4.1). Empty space drags the window under Tauri. */
export function TitleBar() {
  const rt = useRuntime();
  const mode = useUi((s) => s.mode);
  const focusSessionId = useUi((s) => s.focusSessionId);
  const projectId = useUi((s) => s.projectId);
  const setProject = useUi((s) => s.setProject);
  const setProjectDialog = useUi((s) => s.setProjectDialog);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const openPalette = useUi((s) => s.openPalette);
  const projects = useProjects().data ?? [];
  const sessions = useSessions().data;
  const runs = useRuns().data;
  const demo = useIsDemo();
  const { items } = useBoard();
  const counts = attentionCounts(items);
  const project = projects.find((p) => p.id === projectId) ?? null;
  const session = mode === 'focus' ? sessions?.find((s) => s.id === focusSessionId) : undefined;

  const today = useMemo(() => {
    const since = todayStart();
    return sumUsage((runs ?? []).filter((r) => r.createdAt >= since).map((r) => r.usage));
  }, [runs]);

  return (
    <header
      data-tauri-drag-region
      className="relative z-30 grid h-10 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center bg-app"
    >
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-1 pl-2">
        <IconButton label="サイドバーを切替" shortcut="toggleSidebar" onClick={toggleSidebar}>
          <PanelLeft size={16} strokeWidth={1.5} />
        </IconButton>
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              className="flex h-7 max-w-56 min-w-0 items-center gap-1.5 rounded-sm px-2 text-ui font-medium text-fg hover:bg-hover"
            >
              <span className="truncate">{project?.name ?? 'すべてのプロジェクト'}</span>
              <ChevronDown size={14} strokeWidth={1.5} className="shrink-0 text-fg-3" />
            </button>
          </MenuTrigger>
          <MenuContent className="min-w-72">
            <MenuLabel>プロジェクト</MenuLabel>
            <MenuItem checked={!projectId} onSelect={() => setProject(null)}>
              すべてのプロジェクト
            </MenuItem>
            {projects.length > 0 && <MenuSeparator />}
            {projects.map((p) => (
              <MenuItem
                key={p.id}
                icon={<Folder size={14} strokeWidth={1.5} />}
                checked={p.id === projectId}
                onSelect={() => setProject(p.id)}
              >
                <span className="flex flex-col py-0.5">
                  <span className="truncate">{p.name}</span>
                  <ProjectFacts project={p} />
                </span>
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem icon={<Plus size={14} strokeWidth={1.5} />} onSelect={() => setProjectDialog({ kind: 'new' })}>
              プロジェクトを追加…
            </MenuItem>
            {project && (
              <MenuItem
                icon={<Settings2 size={14} strokeWidth={1.5} />}
                onSelect={() => setProjectDialog({ kind: 'edit', projectId: project.id })}
              >
                「{project.name}」の設定…
              </MenuItem>
            )}
          </MenuContent>
        </Menu>
        {demo && (
          <Tooltip content="組み込みの模擬モデルで動いています。費用はかかりません">
            <span className="shrink-0 rounded-xs bg-selected px-1.5 text-micro whitespace-nowrap text-fg-2">デモ</span>
          </Tooltip>
        )}
        <ChevronRight size={14} strokeWidth={1.5} className="shrink-0 text-fg-4" />
        <span data-tauri-drag-region className="truncate text-ui text-fg-3">
          {MODE_LABEL[mode]}
          {session && (
            <>
              <span className="px-1.5 text-fg-4">/</span>
              <span className="text-fg-2">{untitled(session)}</span>
            </>
          )}
        </span>
      </div>

      <button
        type="button"
        onClick={() => openPalette()}
        className="flex h-7 w-[320px] items-center gap-2 rounded-sm border border-line-subtle bg-hover px-2.5 text-ui text-fg-3 transition-colors duration-[120ms] hover:border-line hover:text-fg-2 hover:duration-0"
      >
        <Search size={14} strokeWidth={1.5} />
        <span className="flex-1 text-left">検索・コマンド</span>
        <Kbd id="palette" />
      </button>

      <div data-tauri-drag-region className="flex min-w-0 items-center justify-end gap-3 pl-3">
        <span data-tauri-drag-region className="flex items-center gap-1.5 text-meta text-fg-3">
          今日
          {demo ? (
            <Tooltip content="デモモードでは費用はかかりません">
              <span className="tabular text-meta text-fg-2">$0.00（デモ）</span>
            </Tooltip>
          ) : (
            <Cost usd={today.costUsd} source={today.costSource} className="text-fg-2" />
          )}
        </span>
        {counts.total > 0 && (
          <Tooltip content="次の要対応へ（Ctrl J）">
            <button
              type="button"
              onClick={() => goToAttention(rt)}
              aria-live="polite"
              aria-label={`要対応 ${counts.total} 件`}
              className="flex h-5 items-center gap-1 rounded-xs px-1.5 text-micro text-st-awaiting_approval"
              style={{ background: 'color-mix(in oklch, var(--st-awaiting_approval) 14%, transparent)' }}
            >
              要対応
              <NumberRoll value={counts.total} />
            </button>
          </Tooltip>
        )}
        <span className="flex items-center pr-3">
          <ConnectionDot />
        </span>
        <WindowControls />
      </div>
    </header>
  );
}
