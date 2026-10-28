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

interface TimelineState {
  filters: TimelineFilters;
  groupByRun: boolean;
  toggled: Record<string, boolean>;
  setFilters: (patch: Partial<TimelineFilters>) => void;
  clearFilters: () => void;
  toggleRun: (runId: string, currentlyCollapsed: boolean) => void;
  setGroupByRun: (v: boolean) => void;
}

function writeUrl(f: TimelineFilters) {
  if (typeof window === 'undefined') return;
  const next = filtersToSearch(window.location.search, f);
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${next}${window.location.hash}`);
}

export const useTimeline = create<TimelineState>((set, get) => ({
  filters: typeof window === 'undefined' ? EMPTY_FILTERS : filtersFromSearch(window.location.search),
  groupByRun: true,
  toggled: {},
  setFilters(patch) {
    const filters = { ...get().filters, ...patch };
    set({ filters });
    writeUrl(filters);
  },
  clearFilters() {
    set({ filters: EMPTY_FILTERS });
    writeUrl(EMPTY_FILTERS);
  },
  toggleRun(runId, currentlyCollapsed) {
    set((s) => ({ toggled: { ...s.toggled, [runId]: !currentlyCollapsed } }));
  },
  setGroupByRun(groupByRun) {
    set({ groupByRun });
  },
}));
