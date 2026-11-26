import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/** Tabs of the settings dialog: what to set, and what was used. */
export type SettingsTab = 'general' | 'projects' | 'usage';

/** The screen of the settings' projects tab: the list, adding one, or one project's settings. */
export type ProjectsView = { kind: 'list' } | { kind: 'new' } | { kind: 'edit'; projectId: string };
/** How 利用統計 shows the use: bars, or a table of the figures. */
export type UsageView = 'chart' | 'table';

/**
 * The screens (ui-redesign spec §2): home (the app's face), one conversation, the timeline,
 * and the page of a member (snapshot 20261104_members-spec.md §6).
 */
export type Mode = 'home' | 'session' | 'timeline' | 'member';
export type ThemePref = 'dark' | 'light' | 'system';
export type MotionPref = 'system' | 'on' | 'off';
/** Where the desktop shows through: the wings (title bar, sidebar, outputs panel) or everything. */
export type GlassScope = 'wings' | 'all';
/** How much of the desktop shows through. */
export type GlassStrength = 'weak' | 'mid' | 'strong';

interface View {
  mode: Mode;
  sessionId: string | null;
  memberId?: string | null;
}

export interface UiState {
  mode: Mode;
  /**
   * Conversation shown in mode 'session' (kept when leaving, for back / forward). null in
   * mode 'session' is the draft of a new conversation (openDraft).
   */
  focusSessionId: string | null;
  /** Member whose page mode 'member' shows. */
  memberId: string | null;
  /** Member the draft of a new conversation is with (null: nobody). */
  draftMemberId: string | null;
  /** Remarks asked for (@name) and not answered yet, per conversation. Not persisted. */
  asking: Record<string, { id: string; characterId: string; text: string }[]>;
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
  /** Tab of the settings dialog (back to 一般 when it closes). */
  settingsTab: SettingsTab;
  projectsView: ProjectsView;
  /** Chart or table under 利用統計 (kept). */
  usageView: UsageView;
  shortcutsOpen: boolean;
  modelPickerOpen: boolean;
  theme: ThemePref;
  reduceMotion: MotionPref;
  /** Let the desktop show through the app ground (only when the shell applied a material). */
  glass: 'on' | 'off';
  glassScope: GlassScope;
  glassStrength: GlassStrength;
  drafts: Record<string, string>;
  /**
   * What the home field is set to besides its words (where, which project, which model): kept
   * while the app runs, so it survives the empty home turning into the board. Not persisted.
   */
  homeChoice: {
    kind: 'none' | 'folder' | 'worktree';
    projectId: string | null;
    model: string | null;
  };
  viewedAt: Record<string, string>;
  /** Answers that settled before this (the first run of this store) are not shown as unread. */
  readBaseline: string;
  collapsed: Record<string, boolean>;
  onboardingDone: boolean;
  /** The connection prompt (first real request without a configured LLM) is open. */
  connectPromptOpen: boolean;
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
  /**
   * When this window last spoke to the assistant from the home field (ISO). The line above
   * the field shows only exchanges from then on; a fresh window shows none.
   */
  assistantAskedAt: string | null;
}

interface UiActions {
  setMode: (mode: Mode) => void;
  /** Open a conversation (recorded in back / forward). */
  openSession: (sessionId: string) => void;
  /**
   * A new conversation that does not exist yet (Ctrl+N): mode 'session' without a session.
   * The first send creates it (spec §5.3) and then opens it.
   */
  openDraft: (memberId?: string | null) => void;
  setDraftMember: (memberId: string | null) => void;
  /** A remark asked for (`add`) or answered / failed (`remove`). */
  setAsking: (sessionId: string, id: string, ask: { characterId: string; text: string } | null) => void;
  /** The home screen (Ctrl+1). */
  goHome: () => void;
  /** The timeline (Ctrl+2). */
  openTimeline: () => void;
  /** The page of a member (recorded in back / forward). */
  openMember: (characterId: string) => void;
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
  /** Open (on a tab) or close the settings dialog. */
  setSettingsOpen: (open: boolean, tab?: SettingsTab) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  setProjectsView: (v: ProjectsView) => void;
  /** Open the settings on the projects tab (on one project's settings when given). */
  openProjects: (projectId?: string) => void;
  setUsageView: (view: UsageView) => void;
  setShortcutsOpen: (open: boolean) => void;
  setModelPickerOpen: (open: boolean) => void;
  setTheme: (t: ThemePref) => void;
  setReduceMotion: (reduceMotion: MotionPref) => void;
  setGlass: (g: 'on' | 'off') => void;
  setGlassScope: (s: GlassScope) => void;
  setGlassStrength: (s: GlassStrength) => void;
  setDraft: (sessionId: string, text: string) => void;
  setHomeChoice: (patch: Partial<UiState['homeChoice']>) => void;
  markViewed: (sessionId: string, at: string) => void;
  toggleCollapsed: (key: string, defaultCollapsed?: boolean) => void;
  finishOnboarding: () => void;
  setConnectPromptOpen: (open: boolean) => void;
  noteAssistantAsk: (at: string) => void;
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
  memberId: null,
  draftMemberId: null,
  asking: {},
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
  settingsTab: 'general',
  projectsView: { kind: 'list' },
  usageView: 'chart',
  shortcutsOpen: false,
  modelPickerOpen: false,
  theme: 'dark',
  reduceMotion: 'system',
  glass: 'on',
  glassScope: 'wings',
  glassStrength: 'mid',
  drafts: {},
  homeChoice: { kind: 'none', projectId: null, model: null },
  viewedAt: {},
  readBaseline: '',
  collapsed: {},
  onboardingDone: false,
  connectPromptOpen: false,
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
  assistantAskedAt: null,
};

let jumpNonce = 0;
/** Matches the acc-flash animation (index.css). */
const FLASH_MS = 1700;

const view = (s: UiState): View => ({
  mode: s.mode,
  sessionId: s.focusSessionId,
  memberId: s.memberId,
});

/** Screens of the old layout read as the new ones: 司令室 (command) is home, フォーカス (focus) a conversation. */
export function normalizeMode(mode: unknown): Mode {
  if (mode === 'session' || mode === 'focus') return 'session';
  if (mode === 'timeline') return 'timeline';
  if (mode === 'member') return 'member';
  return 'home';
}

/**
 * Persisted state of an older version, read into the current shape: the per-mode panel
 * flags of v1 become the outputs panel flag (it was the Focus detail panel); state of
 * screens that no longer exist (task board, panel tabs) is dropped.
 */
export function migrateUi(persisted: unknown, version: number): Partial<UiState> {
  const p = {
    ...((persisted && typeof persisted === 'object' ? persisted : {}) as Record<string, unknown>),
  };
  if (version < 2) {
    const panel = p.panelOpen;
    p.panelOpen =
      panel && typeof panel === 'object'
        ? (panel as Record<string, unknown>).focus !== false
        : panel !== false;
    delete p.panelTab;
    delete p.commandView;
    delete p.taskGoal;
    if ('mode' in p) p.mode = normalizeMode(p.mode);
    for (const k of ['back', 'forward'] as const) {
      const list = p[k];
      if (Array.isArray(list))
        p[k] = (list as View[]).map((v) => ({ ...v, mode: normalizeMode(v.mode) }));
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
        setDraftMember: (draftMemberId) => set({ draftMemberId }),
        setAsking: (sessionId, id, ask) =>
          set((s) => {
            const list = (s.asking[sessionId] ?? []).filter((a) => a.id !== id);
            return { asking: { ...s.asking, [sessionId]: ask ? [...list, { id, ...ask }] : list } };
          }),
        openDraft: (memberId) =>
          set((s) => ({
            // A plain new conversation (Ctrl+N) is with nobody until one is chosen.
            draftMemberId: memberId ?? null,
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
          if (s.mode === 'session')
            set({ selectedId: s.focusSessionId, viewedAt: touchViewed(s, s.focusSessionId) });
          get().setMode('home');
        },
        openTimeline: () => get().setMode('timeline'),
        openMember: (memberId) =>
          set((s) =>
            s.mode === 'member' && s.memberId === memberId
              ? s
              : {
                  mode: 'member',
                  memberId,
                  reviewIntegrationId: null,
                  back: pushBack(s),
                  forward: [],
                },
          ),
        select: (id, viaKeyboard = false) =>
          set(viaKeyboard ? { selectedId: id, keyboardSelectAt: Date.now() } : { selectedId: id }),
        setTimelineSelected: (key) => set({ timelineSelected: key }),
        setProject: (projectId) => set({ projectId }),
        toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
        setSidebarWidth: (px) =>
          set({ sidebarWidth: Math.round(Math.min(360, Math.max(200, px))) }),
        setPanelWidth: (px) => set({ panelWidth: Math.round(Math.min(560, Math.max(320, px))) }),
        togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
        setPanelOpen: (open) => set((s) => (s.panelOpen === open ? s : { panelOpen: open })),
        openPalette: (seed = '') =>
          set({ paletteOpen: true, paletteSeed: seed, paletteQuery: seed, palettePages: [] }),
        closePalette: () => set({ paletteOpen: false }),
        setPaletteQuery: (paletteQuery) => set({ paletteQuery }),
        pushPalettePage: (page) =>
          set((s) => ({ palettePages: [...s.palettePages, page], paletteQuery: '' })),
        popPalettePage: () =>
          set((s) => ({ palettePages: s.palettePages.slice(0, -1), paletteQuery: '' })),
        setSettingsOpen: (settingsOpen, tab) =>
          set({ settingsOpen, settingsTab: tab ?? (settingsOpen ? get().settingsTab : 'general') }),
        setSettingsTab: (settingsTab) => set({ settingsTab, projectsView: { kind: 'list' } }),
        setProjectsView: (projectsView) => set({ projectsView }),
        openProjects: (projectId) =>
          set({
            settingsOpen: true,
            settingsTab: 'projects',
            projectsView: projectId ? { kind: 'edit', projectId } : { kind: 'list' },
          }),
        setUsageView: (usageView) => set({ usageView }),
        setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
        setModelPickerOpen: (modelPickerOpen) => set({ modelPickerOpen }),
        setTheme: (theme) => set({ theme }),
        setReduceMotion: (reduceMotion) => set({ reduceMotion }),
        setGlass: (glass) => set({ glass }),
        setGlassScope: (glassScope) => set({ glassScope }),
        setGlassStrength: (glassStrength) => set({ glassStrength }),
        setHomeChoice: (patch) => set((s) => ({ homeChoice: { ...s.homeChoice, ...patch } })),
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
            (s.viewedAt[sessionId] ?? '') >= at
              ? s
              : { viewedAt: { ...s.viewedAt, [sessionId]: at } },
          ),
        toggleCollapsed: (key, defaultCollapsed = false) =>
          set((s) => ({
            collapsed: { ...s.collapsed, [key]: !(s.collapsed[key] ?? defaultCollapsed) },
          })),
        finishOnboarding: () => set({ onboardingDone: true, connectPromptOpen: false }),
        setConnectPromptOpen: (connectPromptOpen) => set({ connectPromptOpen }),
        noteAssistantAsk: (assistantAskedAt) => set({ assistantAskedAt }),
        rememberCommand: (id) =>
          set((s) => ({
            recentCommands: [id, ...s.recentCommands.filter((x) => x !== id)].slice(0, 8),
          })),
        goBack: () => {
          const s = get();
          // The full-screen code view is a step of its own: 戻る first closes it, back to
          // the conversation it was opened from (as its own 戻る and Esc do).
          if (s.reviewIntegrationId) {
            set({ reviewIntegrationId: null });
            return;
          }
          const prev = s.back[s.back.length - 1];
          if (!prev) return;
          set({
            mode: prev.mode,
            reviewIntegrationId: null,
            focusSessionId: prev.mode === 'session' ? prev.sessionId : s.focusSessionId,
            memberId: prev.mode === 'member' ? (prev.memberId ?? null) : s.memberId,
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
            memberId: next.mode === 'member' ? (next.memberId ?? null) : s.memberId,
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
          set((s) => ({
            notifyOs: patch.os ?? s.notifyOs,
            notifyInApp: patch.inApp ?? s.notifyInApp,
          })),
        markSuperseded: (messageId) =>
          set((s) => ({ superseded: { ...s.superseded, [messageId]: true } })),
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
              s.editing?.sessionId === e.sessionId
                ? s.editing.prevDraft
                : (s.drafts[e.sessionId] ?? '');
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
          glass: s.glass,
          glassScope: s.glassScope,
          glassStrength: s.glassStrength,
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
          usageView: s.usageView,
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
export function isUnread(
  s: Pick<UiState, 'viewedAt' | 'readBaseline' | 'mode' | 'focusSessionId'>,
  c: Settling,
): boolean {
  if ((c.state !== 'idle' && c.state !== 'done') || !c.stateSince) return false;
  if (s.mode === 'session' && s.focusSessionId === c.id) return false;
  const seen = s.viewedAt[c.id] ?? '';
  return c.stateSince > (seen > s.readBaseline ? seen : s.readBaseline);
}

/** isUnread for one conversation, re-rendering only when the answer changes. */
export function useUnread(c: Settling): boolean {
  return useUi((s) => isUnread(s, c));
}
