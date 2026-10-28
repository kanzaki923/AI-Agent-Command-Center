import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type Mode = 'command' | 'focus' | 'timeline';
export type PanelTab = 'overview' | 'changes' | 'tests' | 'logs';
export const PANEL_TABS: PanelTab[] = ['overview', 'changes', 'tests', 'logs'];
export type ThemePref = 'dark' | 'light' | 'system';
export type MotionPref = 'system' | 'on' | 'off';

interface View {
  mode: Mode;
  sessionId: string | null;
}

export interface UiState {
  mode: Mode;
  /** Session shown in Focus Mode. */
  focusSessionId: string | null;
  /** Where Esc from Focus returns to (§7.2 ladder step 7). */
  focusOrigin: 'command' | 'timeline';
  /** Keyboard selection in Command Mode (board item id). */
  selectedId: string | null;
  /** Keyboard selection in Timeline Mode (event seq or run header key). */
  timelineSelected: string | null;
  projectId: string | null;
  sidebarOpen: boolean;
  sidebarWidth: number;
  panelWidth: number;
  panelOpen: Record<Mode, boolean>;
  panelTab: PanelTab;
  paletteOpen: boolean;
  /** Prefix the palette opens with (`#` session search, `>` commands). */
  paletteSeed: string;
  paletteQuery: string;
  palettePages: string[];
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  modelPickerOpen: boolean;
  theme: ThemePref;
  reduceMotion: MotionPref;
  drafts: Record<string, string>;
  viewedAt: Record<string, string>;
  collapsed: Record<string, boolean>;
  onboardingDone: boolean;
  recentCommands: string[];
  back: View[];
  forward: View[];
  /** Last time the Command list selection moved by keyboard (reorder hold, §3.2). */
  keyboardSelectAt: number;
  /** Integration under review: replaces the main area until closed (Esc). */
  reviewIntegrationId: string | null;
  /** Project dialog: add a repository, or edit one project's settings. */
  projectDialog: { kind: 'new' } | { kind: 'edit'; projectId: string } | null;
  /** Session whose orchestrator-grant dialog is open. */
  grantDialogSessionId: string | null;
  /** Suggested first message per session (demo: a one-click chip above the composer). */
  suggestions: Record<string, string>;
  /** Command Mode lists agents (sessions) or tasks (the task board). */
  commandView: CommandView;
  /** Task board scope: one goal (orchestrator session id / `human`) or every goal. */
  taskGoal: string | null;
  /**
   * A message to scroll to and flash once (palette search hit, Timeline "会話を開く").
   * `nonce` makes a repeated jump to the same message run again.
   */
  jumpTo: { sessionId: string; messageId: string; nonce: number } | null;
  /** OS notifications while the window is in the background (§8.5). */
  notifyOs: boolean;
  /** In-app toasts for things that happen outside the current view. */
  notifyInApp: boolean;
  /** Messages replaced by "edit and resend" (shown folded, this window only). */
  superseded: Record<string, true>;
  /** The unanswered message being edited in the composer (↑ in an empty composer). */
  editing: { sessionId: string; messageId: string } | null;
}

export type CommandView = 'agents' | 'tasks';

interface UiActions {
  setMode: (mode: Mode) => void;
  openSession: (sessionId: string, opts?: { from?: 'command' | 'timeline' }) => void;
  leaveFocus: () => void;
  select: (id: string | null, viaKeyboard?: boolean) => void;
  setTimelineSelected: (key: string | null) => void;
  setProject: (projectId: string | null) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (px: number) => void;
  setPanelWidth: (px: number) => void;
  togglePanel: (mode?: Mode) => void;
  setPanelOpen: (mode: Mode, open: boolean) => void;
  setPanelTab: (tab: PanelTab) => void;
  cyclePanelTab: (dir: 1 | -1) => void;
  openPalette: (seed?: string) => void;
  closePalette: () => void;
  setPaletteQuery: (q: string) => void;
  pushPalettePage: (page: string) => void;
  popPalettePage: () => void;
  setSettingsOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setModelPickerOpen: (open: boolean) => void;
  setTheme: (t: ThemePref) => void;
  setReduceMotion: (m: MotionPref) => void;
  setDraft: (sessionId: string, text: string) => void;
  markViewed: (sessionId: string, at: string) => void;
  toggleCollapsed: (key: string, defaultCollapsed?: boolean) => void;
  finishOnboarding: () => void;
  rememberCommand: (id: string) => void;
  goBack: () => void;
  goForward: () => void;
  openIntegration: (integrationId: string) => void;
  closeIntegration: () => void;
  setProjectDialog: (d: UiState['projectDialog']) => void;
  setGrantDialog: (sessionId: string | null) => void;
  setSuggestion: (sessionId: string, text: string | null) => void;
  setCommandView: (v: CommandView) => void;
  setTaskGoal: (goal: string | null) => void;
  /** Command Mode → task board with this task selected and its detail open. */
  openTask: (taskId: string) => void;
  /** Focus the session and scroll to one message. */
  openMessage: (sessionId: string, messageId: string, opts?: { from?: 'command' | 'timeline' }) => void;
  clearJump: () => void;
  setNotify: (patch: { os?: boolean; inApp?: boolean }) => void;
  markSuperseded: (messageId: string) => void;
  /** Start editing (text goes into the session's draft) or stop (`null`). */
  setEditing: (e: { sessionId: string; messageId: string; text: string } | null) => void;
}

export type UiStore = UiState & UiActions;

const initial: UiState = {
  mode: 'command',
  focusSessionId: null,
  focusOrigin: 'command',
  selectedId: null,
  timelineSelected: null,
  projectId: null,
  sidebarOpen: true,
  sidebarWidth: 248,
  panelWidth: 360,
  panelOpen: { command: false, focus: true, timeline: false },
  panelTab: 'overview',
  paletteOpen: false,
  paletteSeed: '',
  paletteQuery: '',
  palettePages: [],
  settingsOpen: false,
  shortcutsOpen: false,
  modelPickerOpen: false,
  theme: 'dark',
  reduceMotion: 'system',
  drafts: {},
  viewedAt: {},
  collapsed: {},
  onboardingDone: false,
  recentCommands: [],
  back: [],
  forward: [],
  keyboardSelectAt: 0,
  reviewIntegrationId: null,
  projectDialog: null,
  grantDialogSessionId: null,
  suggestions: {},
  commandView: 'agents',
  taskGoal: null,
  jumpTo: null,
  notifyOs: true,
  notifyInApp: true,
  superseded: {},
  editing: null,
};

let jumpNonce = 0;

const view = (s: UiState): View => ({ mode: s.mode, sessionId: s.focusSessionId });

/** Leaving or entering a session counts as having read it (sidebar unread dots). */
function touchViewed(s: UiState, ...ids: (string | null)[]): Record<string, string> {
  const now = new Date().toISOString();
  const next = { ...s.viewedAt };
  for (const id of ids) if (id) next[id] = now;
  return next;
}
const pushBack = (s: UiState): View[] => [...s.back.slice(-49), view(s)];

/** localStorage may throw (private mode, blocked storage): degrade to memory. */
const safeStorage = createJSONStorage(() => {
  try {
    const ls = globalThis.localStorage;
    const probe = '__acc_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    const mem = new Map<string, string>();
    return {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
  }
});

export const createUiStore = () =>
  create<UiStore>()(
    persist(
      (set, get) => ({
        ...initial,
        setMode: (mode) =>
          set((s) =>
            s.mode === mode
              ? s.reviewIntegrationId
                ? { reviewIntegrationId: null }
                : s
              : {
                  mode,
                  reviewIntegrationId: null,
                  back: pushBack(s),
                  forward: [],
                  focusOrigin: mode === 'focus' ? s.focusOrigin : mode === 'timeline' ? 'timeline' : 'command',
                },
          ),
        openSession: (sessionId, opts) =>
          set((s) => ({
            viewedAt: touchViewed(s, s.focusSessionId, sessionId),
            mode: 'focus',
            reviewIntegrationId: null,
            focusSessionId: sessionId,
            focusOrigin: opts?.from ?? (s.mode === 'timeline' ? 'timeline' : s.mode === 'command' ? 'command' : s.focusOrigin),
            selectedId: s.mode === 'command' ? s.selectedId : sessionId,
            back: s.mode === 'focus' && s.focusSessionId === sessionId ? s.back : pushBack(s),
            forward: [],
          })),
        leaveFocus: () =>
          set((s) => ({
            viewedAt: touchViewed(s, s.focusSessionId),
            mode: s.focusOrigin,
            selectedId: s.focusSessionId ?? s.selectedId,
            back: pushBack(s),
            forward: [],
          })),
        select: (id, viaKeyboard = false) =>
          set(viaKeyboard ? { selectedId: id, keyboardSelectAt: Date.now() } : { selectedId: id }),
        setTimelineSelected: (key) => set({ timelineSelected: key }),
        setProject: (projectId) => set({ projectId }),
        toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
        setSidebarWidth: (px) => set({ sidebarWidth: Math.round(Math.min(360, Math.max(200, px))) }),
        setPanelWidth: (px) => set({ panelWidth: Math.round(Math.min(560, Math.max(320, px))) }),
        togglePanel: (mode) =>
          set((s) => {
            const m = mode ?? s.mode;
            return { panelOpen: { ...s.panelOpen, [m]: !s.panelOpen[m] } };
          }),
        setPanelOpen: (mode, open) =>
          set((s) => (s.panelOpen[mode] === open ? s : { panelOpen: { ...s.panelOpen, [mode]: open } })),
        setPanelTab: (panelTab) => set({ panelTab }),
        cyclePanelTab: (dir) =>
          set((s) => {
            const tabs: PanelTab[] = ['overview', 'changes', 'tests', 'logs'];
            const i = tabs.indexOf(s.panelTab);
            return { panelTab: tabs[(i + dir + tabs.length) % tabs.length]! };
          }),
        openPalette: (seed = '') =>
          set({ paletteOpen: true, paletteSeed: seed, paletteQuery: seed, palettePages: [] }),
        closePalette: () => set({ paletteOpen: false }),
        setPaletteQuery: (paletteQuery) => set({ paletteQuery }),
        pushPalettePage: (page) => set((s) => ({ palettePages: [...s.palettePages, page], paletteQuery: '' })),
        popPalettePage: () => set((s) => ({ palettePages: s.palettePages.slice(0, -1), paletteQuery: '' })),
        setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
        setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
        setModelPickerOpen: (modelPickerOpen) => set({ modelPickerOpen }),
        setTheme: (theme) => set({ theme }),
        setReduceMotion: (reduceMotion) => set({ reduceMotion }),
        setDraft: (sessionId, text) =>
          set((s) => {
            if ((s.drafts[sessionId] ?? '') === text) return s;
            const drafts = { ...s.drafts };
            if (text) drafts[sessionId] = text;
            else delete drafts[sessionId];
            return { drafts };
          }),
        markViewed: (sessionId, at) =>
          set((s) =>
            (s.viewedAt[sessionId] ?? '') >= at ? s : { viewedAt: { ...s.viewedAt, [sessionId]: at } },
          ),
        toggleCollapsed: (key, defaultCollapsed = false) =>
          set((s) => ({ collapsed: { ...s.collapsed, [key]: !(s.collapsed[key] ?? defaultCollapsed) } })),
        finishOnboarding: () => set({ onboardingDone: true }),
        rememberCommand: (id) =>
          set((s) => ({ recentCommands: [id, ...s.recentCommands.filter((x) => x !== id)].slice(0, 8) })),
        goBack: () => {
          const s = get();
          const prev = s.back[s.back.length - 1];
          if (!prev) return;
          set({
            mode: prev.mode,
            focusSessionId: prev.sessionId ?? s.focusSessionId,
            back: s.back.slice(0, -1),
            forward: [...s.forward, view(s)],
          });
        },
        goForward: () => {
          const s = get();
          const next = s.forward[s.forward.length - 1];
          if (!next) return;
          set({
            mode: next.mode,
            focusSessionId: next.sessionId ?? s.focusSessionId,
            forward: s.forward.slice(0, -1),
            back: [...s.back, view(s)],
          });
        },
        openIntegration: (reviewIntegrationId) =>
          set((s) => ({
            reviewIntegrationId,
            // The review lives in the Command board's place; selection follows it back.
            mode: s.mode === 'focus' ? 'command' : s.mode,
            selectedId: reviewIntegrationId,
          })),
        closeIntegration: () => set({ reviewIntegrationId: null }),
        setProjectDialog: (projectDialog) => set({ projectDialog }),
        setGrantDialog: (grantDialogSessionId) => set({ grantDialogSessionId }),
        setCommandView: (commandView) => set({ commandView }),
        setTaskGoal: (taskGoal) => set({ taskGoal }),
        openTask: (taskId) =>
          set((s) => ({
            mode: 'command',
            reviewIntegrationId: null,
            commandView: 'tasks',
            selectedId: taskId,
            panelOpen: { ...s.panelOpen, command: true },
            back: s.mode === 'command' ? s.back : pushBack(s),
            forward: s.mode === 'command' ? s.forward : [],
          })),
        openMessage: (sessionId, messageId, opts) => {
          get().openSession(sessionId, opts);
          set({ jumpTo: { sessionId, messageId, nonce: ++jumpNonce } });
        },
        clearJump: () => set((s) => (s.jumpTo ? { jumpTo: null } : s)),
        setNotify: (patch) =>
          set((s) => ({ notifyOs: patch.os ?? s.notifyOs, notifyInApp: patch.inApp ?? s.notifyInApp })),
        markSuperseded: (messageId) => set((s) => ({ superseded: { ...s.superseded, [messageId]: true } })),
        setEditing: (e) =>
          set((s) => {
            if (!e) {
              const cur = s.editing;
              if (!cur) return s;
              const drafts = { ...s.drafts };
              delete drafts[cur.sessionId];
              return { editing: null, drafts };
            }
            return {
              editing: { sessionId: e.sessionId, messageId: e.messageId },
              drafts: { ...s.drafts, [e.sessionId]: e.text },
            };
          }),
        setSuggestion: (sessionId, text) =>
          set((s) => {
            const suggestions = { ...s.suggestions };
            if (text) suggestions[sessionId] = text;
            else delete suggestions[sessionId];
            return { suggestions };
          }),
      }),
      {
        name: 'acc.ui',
        version: 1,
        storage: safeStorage,
        partialize: (s) => ({
          theme: s.theme,
          reduceMotion: s.reduceMotion,
          sidebarOpen: s.sidebarOpen,
          sidebarWidth: s.sidebarWidth,
          panelWidth: s.panelWidth,
          panelOpen: s.panelOpen,
          panelTab: s.panelTab,
          projectId: s.projectId,
          drafts: s.drafts,
          viewedAt: s.viewedAt,
          collapsed: s.collapsed,
          onboardingDone: s.onboardingDone,
          recentCommands: s.recentCommands,
          suggestions: s.suggestions,
          commandView: s.commandView,
          taskGoal: s.taskGoal,
          notifyOs: s.notifyOs,
          notifyInApp: s.notifyInApp,
        }),
      },
    ),
  );

export const useUi = createUiStore();
