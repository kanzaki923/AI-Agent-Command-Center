import { create } from 'zustand';
import {
  type ActorKind,
  EMPTY_FILTERS,
  EVENT_GROUPS,
  type EventGroup,
  type TimelineFilters,
} from '../model/timeline';

/** Filters live in the URL (§5.3) so a view can be shared / restored. */
export function filtersFromSearch(search: string): TimelineFilters {
  const p = new URLSearchParams(search);
  const list = (k: string) => (p.get(k) ?? '').split(',').filter(Boolean);
  return {
    groups: list('tl.types').filter((g): g is EventGroup => (EVENT_GROUPS as string[]).includes(g)),
    actors: list('tl.actors').filter((a): a is ActorKind => ['human', 'agent', 'system'].includes(a)),
    sessionId: p.get('tl.session'),
    runId: p.get('tl.run'),
    text: p.get('tl.q') ?? '',
  };
}

export function filtersToSearch(base: string, f: TimelineFilters): string {
  const p = new URLSearchParams(base);
  const put = (k: string, v: string | null) => (v ? p.set(k, v) : p.delete(k));
  put('tl.types', f.groups.join(','));
  put('tl.actors', f.actors.join(','));
  put('tl.session', f.sessionId);
  put('tl.run', f.runId);
  put('tl.q', f.text.trim() || null);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** What survives a restart (the desktop window has no address bar to keep the URL). */
interface Saved {
  filters: TimelineFilters;
  groupByRun: boolean;
  showAll: boolean;
  /** Routine automatic allows of agents' tool uses (off: blocks and asks only). */
  showAutoAllowed: boolean;
}

const STORAGE_KEY = 'acc.timeline';

function readSaved(): Partial<Saved> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Partial<Saved>;
    const f = v.filters;
    return {
      ...(typeof v.groupByRun === 'boolean' ? { groupByRun: v.groupByRun } : {}),
      ...(typeof v.showAll === 'boolean' ? { showAll: v.showAll } : {}),
      ...(typeof v.showAutoAllowed === 'boolean' ? { showAutoAllowed: v.showAutoAllowed } : {}),
      ...(f
        ? {
            filters: {
              ...EMPTY_FILTERS,
              groups: (f.groups ?? []).filter((g) => (EVENT_GROUPS as string[]).includes(g)),
              actors: (f.actors ?? []).filter((a) => ['human', 'agent', 'system'].includes(a)),
              sessionId: typeof f.sessionId === 'string' ? f.sessionId : null,
              runId: typeof f.runId === 'string' ? f.runId : null,
              text: typeof f.text === 'string' ? f.text : '',
            },
          }
        : {}),
    };
  } catch {
    return {};
  }
}

function writeSaved(s: Saved): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: the URL still carries the filters */
  }
}

/** URL first (a shared link wins), else what was used last time. */
export function initialTimelineState(search: string): Saved {
  const saved = readSaved();
  const fromUrl = filtersFromSearch(search);
  const urlHasFilters = /(^|[?&])tl\./.test(search);
  return {
    filters: urlHasFilters ? fromUrl : (saved.filters ?? EMPTY_FILTERS),
    groupByRun: saved.groupByRun ?? true,
    showAll: saved.showAll ?? false,
    showAutoAllowed: saved.showAutoAllowed ?? false,
  };
}

interface TimelineState extends Saved {
  toggled: Record<string, boolean>;
  setFilters: (patch: Partial<TimelineFilters>) => void;
  clearFilters: () => void;
  toggleRun: (runId: string, currentlyCollapsed: boolean) => void;
  setGroupByRun: (v: boolean) => void;
  setShowAll: (v: boolean) => void;
  setShowAutoAllowed: (v: boolean) => void;
}

function writeUrl(f: TimelineFilters) {
  if (typeof window === 'undefined') return;
  const next = filtersToSearch(window.location.search, f);
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${next}${window.location.hash}`);
}

export const useTimeline = create<TimelineState>((set, get) => {
  const persist = () => {
    const { filters, groupByRun, showAll, showAutoAllowed } = get();
    writeSaved({ filters, groupByRun, showAll, showAutoAllowed });
  };
  return {
    ...initialTimelineState(typeof window === 'undefined' ? '' : window.location.search),
    toggled: {},
    setFilters(patch) {
      const filters = { ...get().filters, ...patch };
      set({ filters });
      writeUrl(filters);
      persist();
    },
    clearFilters() {
      set({ filters: EMPTY_FILTERS });
      writeUrl(EMPTY_FILTERS);
      persist();
    },
    toggleRun(runId, currentlyCollapsed) {
      set((s) => ({ toggled: { ...s.toggled, [runId]: !currentlyCollapsed } }));
    },
    setGroupByRun(groupByRun) {
      set({ groupByRun });
      persist();
    },
    setShowAll(showAll) {
      set({ showAll });
      persist();
    },
    setShowAutoAllowed(showAutoAllowed) {
      set({ showAutoAllowed });
      persist();
    },
  };
});
