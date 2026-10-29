import { create } from 'zustand';
import { EMPTY_FILTERS, type TimelineFilters } from '../model/timeline';

/** Filters live in the URL so a view can be shared / restored. */
export function filtersFromSearch(search: string): TimelineFilters {
  const p = new URLSearchParams(search);
  return { sessionId: p.get('tl.session'), runId: p.get('tl.run'), text: p.get('tl.q') ?? '' };
}

export function filtersToSearch(base: string, f: TimelineFilters): string {
  const p = new URLSearchParams(base);
  const put = (k: string, v: string | null) => (v ? p.set(k, v) : p.delete(k));
  // Keys of the old event-type filters go away with them.
  p.delete('tl.types');
  p.delete('tl.actors');
  put('tl.session', f.sessionId);
  put('tl.run', f.runId);
  put('tl.q', f.text.trim() || null);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** What survives a restart (the desktop window has no address bar to keep the URL). */
interface Saved {
  filters: TimelineFilters;
  /** "詳細": runs, inbox and budget beside the human moments. */
  showAll: boolean;
}

const STORAGE_KEY = 'acc.timeline';

function readSaved(): Partial<Saved> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Partial<Saved>;
    const f = v.filters;
    return {
      ...(typeof v.showAll === 'boolean' ? { showAll: v.showAll } : {}),
      ...(f
        ? {
            filters: {
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
  const urlHasFilters = /(^|[?&])tl\.(session|run|q)=/.test(search);
  return {
    filters: urlHasFilters ? filtersFromSearch(search) : (saved.filters ?? EMPTY_FILTERS),
    showAll: saved.showAll ?? false,
  };
}

/**
 * A filter change. `groups` / `actors` are the old event-type filters, still passed by
 * callers written for them; the timeline no longer has types, so they are ignored.
 */
export type TimelineFilterPatch = Partial<TimelineFilters> & {
  groups?: readonly string[];
  actors?: readonly string[];
};

interface TimelineState extends Saved {
  /** Runs opened (true) or closed (false) by hand; a run starts closed. */
  openRuns: Record<string, boolean>;
  /** Trees unfolded to show their older rows. */
  unfolded: Record<string, boolean>;
  setFilters: (patch: TimelineFilterPatch) => void;
  clearFilters: () => void;
  toggleRun: (runId: string, currentlyOpen: boolean) => void;
  unfold: (rootId: string, v?: boolean) => void;
  setShowAll: (v: boolean) => void;
}

function writeUrl(f: TimelineFilters) {
  if (typeof window === 'undefined') return;
  const next = filtersToSearch(window.location.search, f);
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${next}${window.location.hash}`);
}

export const useTimeline = create<TimelineState>((set, get) => {
  const persist = () => {
    const { filters, showAll } = get();
    writeSaved({ filters, showAll });
  };
  return {
    ...initialTimelineState(typeof window === 'undefined' ? '' : window.location.search),
    openRuns: {},
    unfolded: {},
    setFilters(patch) {
      const cur = get().filters;
      const filters: TimelineFilters = {
        sessionId: patch.sessionId !== undefined ? patch.sessionId : cur.sessionId,
        runId: patch.runId !== undefined ? patch.runId : cur.runId,
        text: patch.text !== undefined ? patch.text : cur.text,
      };
      set({ filters });
      writeUrl(filters);
      persist();
    },
    clearFilters() {
      set({ filters: EMPTY_FILTERS });
      writeUrl(EMPTY_FILTERS);
      persist();
    },
    toggleRun(runId, currentlyOpen) {
      set((s) => ({ openRuns: { ...s.openRuns, [runId]: !currentlyOpen } }));
    },
    unfold(rootId, v = true) {
      set((s) => ({ unfolded: { ...s.unfolded, [rootId]: v } }));
    },
    setShowAll(showAll) {
      set({ showAll });
      persist();
    },
  };
});
