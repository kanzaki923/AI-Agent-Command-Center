import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/** The three screens (ui-redesign spec §2): home (the app's face), one conversation, the timeline. */
export type Mode = 'home' | 'session' | 'timeline';
export type ThemePref = 'dark' | 'light' | 'system';
export type MotionPref = 'system' | 'on' | 'off';

interface View {
  mode: Mode;
  sessionId: string | null;
}

export interface UiState {
  mode: Mode;
  /**
   * Conversation shown in mode 'session' (kept when leaving, for back / forward). null in
   * mode 'session' is the draft of a new conversation (openDraft).
   */
  focusSessionId: string | null;
  /** Keyboard selection on the home screen (an attention id or a session id). */
  selectedId: string | null;
  /** Keyboard selection in Timeline Mode (event seq or run header key). */
  timelineSelected: string | null;
  /** Project a new conversation starts in (the draft's project chip). */
  projectId: string | null;
  sidebarOpen: boolean;
  sidebarWidth: number;
  /** Width of the outputs panel beside a conversation. */
  panelWidth: number;
  /** The outputs panel is shown (when the conversation has outputs). */
  panelOpen: boolean;
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
  /** Answers that settled before this (the first run of this store) are not shown as unread. */
  readBaseline: string;
  collapsed: Record<string, boolean>;
  onboardingDone: boolean;
  recentCommands: string[];
  back: View[];
  forward: View[];
  /** Last time the home selection moved by keyboard (reorder hold, §3.2). */
  keyboardSelectAt: number;
  /** Integration under review: replaces the main area until closed (Esc). */
  reviewIntegrationId: string | null;
  /** Project dialog: add a repository, or edit one project's settings. */
  projectDialog: { kind: 'new' } | { kind: 'edit'; projectId: string } | null;
  /** Suggested first message per session (demo: a one-click chip above the composer). */
  suggestions: Record<string, string>;
  /**
   * A message to scroll to and flash once (palette search hit, Timeline "会話を開く").
   * `nonce` makes a repeated jump to the same message run again.
   */
  jumpTo: { sessionId: string; messageId: string; nonce: number } | null;
  /** The message a jump just landed on, highlighted for a moment (cleared by a timer). */
  flash: { sessionId: string; messageId: string; nonce: number } | null;
  /** OS notifications while the window is in the background (§8.5). */
  notifyOs: boolean;
  /** In-app toasts for things that happen outside the current view. */
  notifyInApp: boolean;
  /** Messages replaced by "edit and resend" (shown folded, this window only). */
  superseded: Record<string, true>;
  /** The unanswered message being edited in the composer (↑ in an empty composer). */
  /** `prevDraft`: what the composer held before the edit started; it comes back afterwards. */
  editing: { sessionId: string; messageId: string; prevDraft: string } | null;
}

interface UiActions {
  setMode: (mode: Mode) => void;
  /** Open a conversation (recorded in back / forward). */
  openSession: (sessionId: string) => void;
  /**
   * A new conversation that does not exist yet (Ctrl+N): mode 'session' without a session.
   * The first send creates it (spec §5.3) and then opens it.
   */
  openDraft: () => void;
  /** The home screen (Ctrl+1). */
  goHome: () => void;
  /** The timeline (Ctrl+2). */
  openTimeline: () => void;
  select: (id: string | null, viaKeyboard?: boolean) => void;
  setTimelineSelected: (key: string | null) => void;
  setProject: (projectId: string | null) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (px: number) => void;
  setPanelWidth: (px: number) => void;
  togglePanel: () => void;
  setPanelOpen: (open: boolean) => void;
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
  setSuggestion: (sessionId: string, text: string | null) => void;
  /** Open the conversation and scroll to one message. */
  openMessage: (sessionId: string, messageId: string) => void;
  clearJump: () => void;
  /**
   * The chat has scrolled to `jumpTo`: drop the request at once (so reopening the session
   * later does not jump again) and flash the message for a moment.
   */
  landJump: () => void;
  setNotify: (patch: { os?: boolean; inApp?: boolean }) => void;
  markSuperseded: (messageId: string) => void;
  /**
   * Start editing (text goes into the session's draft, the draft that was there is kept
   * aside) or stop (`null`: the kept draft comes back, so cancelling loses nothing).
   */
  setEditing: (e: { sessionId: string; messageId: string; text: string } | null) => void;
}

export type UiStore = UiState & UiActions;

const initial: UiState = {
  mode: 'home',
  focusSessionId: null,
  selectedId: null,
  timelineSelected: null,
  projectId: null,
  sidebarOpen: true,
  sidebarWidth: 248,
  panelWidth: 360,
  panelOpen: true,
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
  readBaseline: '',
  collapsed: {},
  onboardingDone: false,
  recentCommands: [],
  back: [],
  forward: [],
  keyboardSelectAt: 0,
  reviewIntegrationId: null,
  projectDialog: null,
  suggestions: {},
  jumpTo: null,
  flash: null,
  notifyOs: true,
  notifyInApp: true,
  superseded: {},
  editing: null,
};

let jumpNonce = 0;
/** Matches the acc-flash animation (index.css). */
const FLASH_MS = 1700;

const view = (s: UiState): View => ({ mode: s.mode, sessionId: s.focusSessionId });

/** Screens of the old layout read as the new ones: 司令室 (command) is home, フォーカス (focus) a conversation. */
export function normalizeMode(mode: unknown): Mode {
  if (mode === 'session' || mode === 'focus') return 'session';
  if (mode === 'timeline') return 'timeline';
  return 'home';
}

/**
 * Persisted state of an older version, read into the current shape: the per-mode panel
 * flags of v1 become the outputs panel flag (it was the Focus detail panel); state of
 * screens that no longer exist (task board, panel tabs) is dropped.
 */
export function migrateUi(persisted: unknown, version: number): Partial<UiState> {
  const p = { ...((persisted && typeof persisted === 'object' ? persisted : {}) as Record<string, unknown>) };
  if (version < 2) {
    const panel = p.panelOpen;
    p.panelOpen =
      panel && typeof panel === 'object' ? (panel as Record<string, unknown>).focus !== false : panel !== false;
    delete p.panelTab;
    delete p.commandView;
    delete p.taskGoal;
    if ('mode' in p) p.mode = normalizeMode(p.mode);
    for (const k of ['back', 'forward'] as const) {
      const list = p[k];
      if (Array.isArray(list)) p[k] = (list as View[]).map((v) => ({ ...v, mode: normalizeMode(v.mode) }));
    }
  }
  return p;
}

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
        readBaseline: new Date().toISOString(),
        setMode: (mode) =>
          set((s) =>
            s.mode === mode
              ? s.reviewIntegrationId
                ? { reviewIntegrationId: null }
                : s
              : { mode, reviewIntegrationId: null, back: pushBack(s), forward: [] },
          ),
        openSession: (sessionId) =>
          set((s) => {
            const same = s.mode === 'session' && s.focusSessionId === sessionId;
            return {
              viewedAt: touchViewed(s, s.focusSessionId, sessionId),
              mode: 'session',
              reviewIntegrationId: null,
              focusSessionId: sessionId,
              back: same ? s.back : pushBack(s),
              forward: same ? s.forward : [],
            };
          }),
        openDraft: () =>
          set((s) => ({
            viewedAt: touchViewed(s, s.focusSessionId),
            mode: 'session',
            reviewIntegrationId: null,
            focusSessionId: null,
            back: s.mode === 'session' && !s.focusSessionId ? s.back : pushBack(s),
            forward: [],
          })),
        goHome: () => {
          const s = get();
          // Coming back from a conversation selects it on the home screen.
          if (s.mode === 'session') set({ selectedId: s.focusSessionId, viewedAt: touchViewed(s, s.focusSessionId) });
          get().setMode('home');
        },
        openTimeline: () => get().setMode('timeline'),
        select: (id, viaKeyboard = false) =>
          set(viaKeyboard ? { selectedId: id, keyboardSelectAt: Date.now() } : { selectedId: id }),
        setTimelineSelected: (key) => set({ timelineSelected: key }),
        setProject: (projectId) => set({ projectId }),
        toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
        setSidebarWidth: (px) => set({ sidebarWidth: Math.round(Math.min(360, Math.max(200, px))) }),
        setPanelWidth: (px) => set({ panelWidth: Math.round(Math.min(560, Math.max(320, px))) }),
        togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
        setPanelOpen: (open) => set((s) => (s.panelOpen === open ? s : { panelOpen: open })),
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
            reviewIntegrationId: null,
            focusSessionId: prev.mode === 'session' ? prev.sessionId : s.focusSessionId,
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
            reviewIntegrationId: null,
            focusSessionId: next.mode === 'session' ? next.sessionId : s.focusSessionId,
            forward: s.forward.slice(0, -1),
            back: [...s.back, view(s)],
          });
        },
        // The full-screen review of a code output replaces the main area until closed (Esc).
        openIntegration: (reviewIntegrationId) => set({ reviewIntegrationId }),
        closeIntegration: () => set({ reviewIntegrationId: null }),
        setProjectDialog: (projectDialog) => set({ projectDialog }),
        openMessage: (sessionId, messageId) => {
          get().openSession(sessionId);
          set({ jumpTo: { sessionId, messageId, nonce: ++jumpNonce } });
        },
        clearJump: () => set((s) => (s.jumpTo ? { jumpTo: null } : s)),
        landJump: () => {
          const flash = get().jumpTo;
          if (!flash) return;
          set({ jumpTo: null, flash });
          setTimeout(() => set((s) => (s.flash === flash ? { flash: null } : s)), FLASH_MS);
        },
        setNotify: (patch) =>
          set((s) => ({ notifyOs: patch.os ?? s.notifyOs, notifyInApp: patch.inApp ?? s.notifyInApp })),
        markSuperseded: (messageId) => set((s) => ({ superseded: { ...s.superseded, [messageId]: true } })),
        setEditing: (e) =>
          set((s) => {
            if (!e) {
              const cur = s.editing;
              if (!cur) return s;
              const drafts = { ...s.drafts };
              if (cur.prevDraft) drafts[cur.sessionId] = cur.prevDraft;
              else delete drafts[cur.sessionId];
              return { editing: null, drafts };
            }
            // Switching to another message keeps the draft from before the first edit.
            const prevDraft =
              s.editing?.sessionId === e.sessionId ? s.editing.prevDraft : (s.drafts[e.sessionId] ?? '');
            return {
              editing: { sessionId: e.sessionId, messageId: e.messageId, prevDraft },
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
        version: 2,
        storage: safeStorage,
        migrate: (persisted, version) => migrateUi(persisted, version) as UiStore,
        partialize: (s) => ({
          theme: s.theme,
          reduceMotion: s.reduceMotion,
          sidebarOpen: s.sidebarOpen,
          sidebarWidth: s.sidebarWidth,
          panelWidth: s.panelWidth,
          panelOpen: s.panelOpen,
          projectId: s.projectId,
          drafts: s.drafts,
          viewedAt: s.viewedAt,
          readBaseline: s.readBaseline,
          collapsed: s.collapsed,
          onboardingDone: s.onboardingDone,
          recentCommands: s.recentCommands,
          suggestions: s.suggestions,
          notifyOs: s.notifyOs,
          notifyInApp: s.notifyInApp,
        }),
      },
    ),
  );

export const useUi = createUiStore();

/** A top-level conversation's state, as far as unread goes. */
interface Settling {
  id: string;
  state: string;
  stateSince: string | null;
}

/**
 * A conversation whose answer (or whole tree's work) settled after you last looked at it:
 * idle or done since later than you left it, and not the one open now.
 */
export function isUnread(s: Pick<UiState, 'viewedAt' | 'readBaseline' | 'mode' | 'focusSessionId'>, c: Settling): boolean {
  if ((c.state !== 'idle' && c.state !== 'done') || !c.stateSince) return false;
  if (s.mode === 'session' && s.focusSessionId === c.id) return false;
  const seen = s.viewedAt[c.id] ?? '';
  return c.stateSince > (seen > s.readBaseline ? seen : s.readBaseline);
}

/** isUnread for one conversation, re-rendering only when the answer changes. */
export function useUnread(c: Settling): boolean {
  return useUi((s) => isUnread(s, c));
}
