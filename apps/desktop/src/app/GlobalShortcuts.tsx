import type { Run, Session } from '@acc/protocol';
import { qk } from '../daemon/keys';
import { useRuntime } from '../daemon/runtime';
import { useWindowKeydown } from '../hooks/useWindowKeydown';
import { resolveEscape } from '../lib/escape';
import { overlayOpen } from '../lib/overlay';
import { isTypingTarget, matchShortcut } from '../lib/shortcuts';
import { undoLatest } from '../store/toast';
import { useUi } from '../store/ui';
import { focusComposerSoon, goToAttention, goUp, newChat, retry, stop } from './commands';

const REGIONS = ['sidebar', 'main', 'panel', 'composer'] as const;

function focusRegion(dir: 1 | -1) {
  const present = REGIONS.filter((r) =>
    r === 'composer' ? !!document.querySelector('[data-composer-input]') : !!document.querySelector(`[data-region="${r}"]`),
  );
  if (present.length === 0) return;
  const active = document.activeElement;
  const cur = present.findIndex((r) =>
    r === 'composer'
      ? active?.hasAttribute('data-composer-input')
      : !!active?.closest(`[data-region="${r}"]`),
  );
  const next = present[(cur + dir + present.length) % present.length]!;
  const el =
    next === 'composer'
      ? document.querySelector<HTMLElement>('[data-composer-input]')
      : document.querySelector<HTMLElement>(`[data-region="${next}"]`);
  if (!el) return;
  const target =
    next === 'composer'
      ? el
      : (el.querySelector<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])') ?? el);
  if (!target.hasAttribute('tabindex') && target === el) el.tabIndex = -1;
  target.focus();
}

/**
 * Global keyboard map (ui-redesign spec §2): Ctrl+K search, Ctrl+N new conversation, Ctrl+1
 * home, Ctrl+2 timeline, Alt+← / → back and forward, Esc closes what is open, then goes up
 * (parent conversation, then home). Single-key shortcuts never fire while typing; keys of the
 * home screen itself (J / K, 1–4, Y / N) belong to the home view.
 */
export function GlobalShortcuts() {
  const rt = useRuntime();

  useWindowKeydown((e) => {
    const ui = useUi.getState();
    const typing = isTypingTarget(e.target);

    if (matchShortcut(e, 'palette')) {
      e.preventDefault();
      if (ui.paletteOpen) ui.closePalette();
      else ui.openPalette();
      return;
    }
    if (ui.paletteOpen) return; // the palette owns the keyboard while open

    if (matchShortcut(e, 'modeHome')) {
      e.preventDefault();
      ui.goHome();
    } else if (matchShortcut(e, 'modeTimeline')) {
      e.preventDefault();
      ui.openTimeline();
    } else if (matchShortcut(e, 'nextAttention')) {
      e.preventDefault();
      goToAttention(rt, 1);
    } else if (matchShortcut(e, 'prevAttention')) {
      e.preventDefault();
      goToAttention(rt, -1);
    } else if (matchShortcut(e, 'newChat')) {
      e.preventDefault();
      newChat(rt);
    } else if (matchShortcut(e, 'toggleSidebar')) {
      e.preventDefault();
      ui.toggleSidebar();
    } else if (matchShortcut(e, 'togglePanel')) {
      e.preventDefault();
      ui.togglePanel();
    } else if (matchShortcut(e, 'focusComposer')) {
      e.preventDefault();
      focusComposerSoon();
    } else if (matchShortcut(e, 'modelPicker')) {
      if (ui.mode !== 'session') return;
      e.preventDefault();
      ui.setModelPickerOpen(true);
    } else if (matchShortcut(e, 'globalSearch')) {
      e.preventDefault();
      ui.openPalette('#');
    } else if (matchShortcut(e, 'stopRun')) {
      if (ui.mode !== 'session') return;
      e.preventDefault();
      const sessions = rt.queryClient.getQueryData<Session[]>(qk.sessions) ?? [];
      const runs = rt.queryClient.getQueryData<Run[]>(qk.runs) ?? [];
      const s = sessions.find((x) => x.id === ui.focusSessionId);
      const run = s?.activeRunId ? runs.find((r) => r.id === s.activeRunId) : undefined;
      if (run) void stop(rt, run);
    } else if (matchShortcut(e, 'back')) {
      // In a text field Alt+←/→ (macOS Option+←/→) moves by word.
      if (typing) return;
      e.preventDefault();
      ui.goBack();
    } else if (matchShortcut(e, 'forward')) {
      if (typing) return;
      e.preventDefault();
      ui.goForward();
    } else if (matchShortcut(e, 'settings')) {
      e.preventDefault();
      ui.setSettingsOpen(true);
    } else if (matchShortcut(e, 'undo')) {
      // In a text field Ctrl+Z is the field's own undo.
      if (typing || overlayOpen()) return;
      if (undoLatest()) e.preventDefault();
    } else if (matchShortcut(e, 'filter') && ui.mode !== 'timeline') {
      // Screens without their own filter field search the conversations instead.
      e.preventDefault();
      ui.openPalette('#');
    } else if (matchShortcut(e, 'regionNext')) {
      e.preventDefault();
      focusRegion(1);
    } else if (matchShortcut(e, 'regionPrev')) {
      e.preventDefault();
      focusRegion(-1);
    } else if (e.key === 'Escape') {
      if (e.defaultPrevented) return;
      const active = document.activeElement as HTMLElement | null;
      if (ui.reviewIntegrationId && !overlayOpen() && !isTypingTarget(active)) {
        // The full-screen review closes back to where it was opened.
        ui.closeIntegration();
        return;
      }
      const action = resolveEscape({
        overlayOpen: overlayOpen(),
        inlineEditing: !!active?.hasAttribute('data-inline-edit'),
        inputFocused: isTypingTarget(active),
        composerGenerating: active?.getAttribute('data-generating') === 'true',
        multiSelect: false,
        overlayPanelOpen: !!document.querySelector('[data-region="panel"][data-overlay="true"]'),
        mode: ui.mode,
      });
      if (action === 'blur-input') {
        active?.blur();
        document.querySelector<HTMLElement>('[data-region="main"]')?.focus({ preventScroll: true });
      } else if (action === 'close-panel') {
        ui.setPanelOpen(false);
      } else if (action === 'go-up') {
        goUp(rt);
      }
    } else if (!typing && !overlayOpen()) {
      if (matchShortcut(e, 'help')) {
        e.preventDefault();
        ui.setShortcutsOpen(true);
      } else if (ui.mode === 'session' && matchShortcut(e, 'retry')) {
        // The chat's 再試行 button shows R: the open conversation's latest run, if it failed.
        const runs = rt.queryClient.getQueryData<Run[]>(qk.runs) ?? [];
        const latest = runs
          .filter((r) => r.sessionId === ui.focusSessionId)
          .reduce<Run | undefined>((a, r) => (!a || r.createdAt > a.createdAt ? r : a), undefined);
        if (latest && (latest.status === 'failed' || latest.status === 'interrupted')) {
          e.preventDefault();
          void retry(rt, latest);
        }
      }
    }
  });

  return null;
}
