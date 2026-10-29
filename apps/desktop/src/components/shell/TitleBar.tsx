import { ArrowLeft, ArrowRight, Hand, PanelLeft, Search } from 'lucide-react';
import { goToAttention } from '../../app/commands';
import { useHomeSelect, useTodaySpend } from '../../daemon/home';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { CostPopover } from '../cost/CostPopover';
import { IconButton } from '../ui/Button';
import { CostMeter } from '../ui/CostMeter';
import { Kbd } from '../ui/Kbd';
import { NumberRoll } from '../ui/Meta';
import { Tooltip } from '../ui/Tooltip';
import { WindowControls } from './WindowControls';

/** Connection to the Core Daemon: a dot (green / amber / red), the words in the tooltip. */
export function ConnectionDot({ withLabel = false }: { withLabel?: boolean }) {
  const state = useConnectionState();
  const color = state === 'open' ? 'var(--st-done)' : state === 'closed' ? 'var(--st-failed)' : 'var(--st-needs_you)';
  const label =
    state === 'open' ? '接続中' : state === 'closed' ? '切断' : state === 'connecting' ? '接続しています' : '再接続中';
  return (
    <Tooltip content={label}>
      <span className="inline-flex items-center gap-1.5" role="status" aria-label={label}>
        <span className="size-1.5 rounded-full" style={{ background: color }} />
        {withLabel && <span className="text-meta text-fg-3">{label}</span>}
      </span>
    </Tooltip>
  );
}

/**
 * 40px title bar (ui-redesign spec §2): sidebar toggle, back / forward, search, today's spend
 * against the daily limit (press for the cost popover), the number of attention items (press
 * for the first one; nothing at 0) and the connection dot. Empty space drags the window.
 */
export function TitleBar() {
  const rt = useRuntime();
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const openPalette = useUi((s) => s.openPalette);
  const goBack = useUi((s) => s.goBack);
  const goForward = useUi((s) => s.goForward);
  const canBack = useUi((s) => s.back.length > 0);
  const canForward = useUi((s) => s.forward.length > 0);
  const today = useTodaySpend();
  const needsYou = useHomeSelect((s) => s.totals.needsYou) ?? 0;

  return (
    <header
      data-tauri-drag-region
      className="relative z-30 grid h-10 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center bg-app"
    >
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-0.5 pl-2">
        <IconButton label="サイドバー" shortcut="toggleSidebar" onClick={toggleSidebar}>
          <PanelLeft size={16} strokeWidth={1.5} />
        </IconButton>
        <IconButton label="戻る" shortcut="back" onClick={goBack} disabled={!canBack}>
          <ArrowLeft size={16} strokeWidth={1.5} />
        </IconButton>
        <IconButton label="進む" shortcut="forward" onClick={goForward} disabled={!canForward}>
          <ArrowRight size={16} strokeWidth={1.5} />
        </IconButton>
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
        {today && (today.usedUsd > 0 || today.limitUsd != null) && (
          <CostPopover>
            <button
              type="button"
              aria-label="今日の費用"
              data-testid="today-cost"
              className="flex h-7 items-center rounded-sm px-1.5 hover:bg-hover"
            >
              <CostMeter usedUsd={today.usedUsd} limitUsd={today.limitUsd} estimated={today.estimated} />
            </button>
          </CostPopover>
        )}
        {needsYou > 0 && (
          <Tooltip
            content={
              <span className="inline-flex items-center gap-2">
                次の出番へ <Kbd id="nextAttention" />
              </span>
            }
          >
            <button
              type="button"
              onClick={() => goToAttention(rt)}
              aria-live="polite"
              aria-label={`出番 ${needsYou}`}
              data-testid="attention-count"
              className="flex h-6 items-center gap-1 rounded-sm px-1.5 text-meta font-medium text-st-needs_you"
              style={{ background: 'color-mix(in oklch, var(--st-needs_you) 14%, transparent)' }}
            >
              <Hand size={13} strokeWidth={2} aria-hidden />
              <NumberRoll value={needsYou} />
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
