import type { SessionRole } from '@acc/protocol';
import { ListTree, Search, X } from 'lucide-react';
import { useMemo, useRef } from 'react';
import { findCard, useHome } from '../../daemon/home';
import { useEventHistory, useEventLogVersion, useRuns, useSessions } from '../../daemon/queries';
import { useRuntime } from '../../daemon/runtime';
import { useDeferredReorder } from '../../hooks/useDeferredReorder';
import { useSlowNow } from '../../hooks/useNow';
import { useWindowKeydown } from '../../hooks/useWindowKeydown';
import { cn } from '../../lib/cn';
import { overlayOpen } from '../../lib/overlay';
import { isTypingTarget, matchShortcut } from '../../lib/shortcuts';
import { sessionTitle } from '../../lib/states';
import {
  type TimelineGroup,
  type TimelineTarget,
  buildTimeline,
  filtersActive,
  formatWhen,
  knownSessions,
  visibleItems,
} from '../../model/timeline';
import { useTimeline } from '../../store/timeline';
import { useUi } from '../../store/ui';
import { Kbd } from '../ui/Kbd';
import { Tooltip } from '../ui/Tooltip';
import { GroupHeading, MomentRow, NoteRow, RunRow, StepRow } from './TimelineRows';

const NONE: never[] = [];

/** Go to where a row happened: the message (scrolled to and flashed), or the conversation. */
export function jumpTo(t: TimelineTarget): void {
  const ui = useUi.getState();
  if (t.messageId) ui.openMessage(t.sessionId, t.messageId);
  else ui.openSession(t.sessionId);
}

/** A row in display order, for the keyboard (J / K / Enter). */
interface Flat {
  key: string;
  activate: () => void;
}

/**
 * The timeline (ui-redesign spec §8): per conversation tree, newest tree first, the moments
 * a human cares about. "詳細" adds each run as one unit (open it for its steps), the inbox
 * and the budget. A row jumps to its message; a tree shows its newest rows until unfolded.
 */
export function TimelineView() {
  const rt = useRuntime();
  const history = useEventHistory();
  const version = useEventLogVersion();
  const sessionsQ = useSessions();
  const runsQ = useRuns();
  const home = useHome().data;
  const now = useSlowNow();
  const filters = useTimeline((s) => s.filters);
  const setFilters = useTimeline((s) => s.setFilters);
  const clearFilters = useTimeline((s) => s.clearFilters);
  const details = useTimeline((s) => s.showAll);
  const setDetails = useTimeline((s) => s.setShowAll);
  const openRuns = useTimeline((s) => s.openRuns);
  const toggleRun = useTimeline((s) => s.toggleRun);
  const unfolded = useTimeline((s) => s.unfolded);
  const unfold = useTimeline((s) => s.unfold);
  const selectedKey = useUi((s) => s.timelineSelected);
  const setSelected = useUi((s) => s.setTimelineSelected);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const events = rt.streams.events.events;
  const sessionList = sessionsQ.data ?? NONE;
  const runList = runsQ.data ?? NONE;
  const sessions = useMemo(() => new Map(sessionList.map((s) => [s.id, s])), [sessionList]);
  const runs = useMemo(() => new Map(runList.map((r) => [r.id, r])), [runList]);
  const known = useMemo(
    () => knownSessions(events, sessions),
    // `version` changes whenever the (mutable) event log changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, events, sessions],
  );
  const groups = useMemo(
    () => buildTimeline({ events, sessions, runs, details, filters }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, events, sessions, runs, details, filters],
  );
  // A tree that gets a new row moves to the top, but not from under the pointer or the keys.
  const ordered = useDeferredReorder(groups, (g) => g.rootId, () => 'all');

  const titleOf = (id: string) => {
    const s = known.get(id);
    return s ? sessionTitle(s) : '';
  };
  const roleOf = (id: string): SessionRole => {
    const c = findCard(home, id);
    if (c) return c.role;
    return known.get(id)?.kind === 'agent' ? 'agent' : 'chat';
  };
  const searching = !!filters.text.trim();
  const runOpen = (runId: string) => openRuns[runId] ?? filters.runId === runId;

  // Display order for the keyboard.
  const flat: Flat[] = [];
  const shown = ordered.items.map((g: TimelineGroup) => {
    const vis = visibleItems(g, searching || !!unfolded[g.rootId]);
    if (vis.hidden > 0) flat.push({ key: `f${g.rootId}`, activate: () => unfold(g.rootId) });
    for (const it of vis.items) {
      if (it.kind === 'run') {
        const open = runOpen(it.runId);
        flat.push({ key: it.key, activate: () => (it.steps.length ? toggleRun(it.runId, open) : jumpTo(it.target)) });
        if (open) for (const s of it.steps) flat.push({ key: s.key, activate: () => jumpTo(s.target) });
      } else flat.push({ key: it.key, activate: () => jumpTo(it.target) });
    }
    return { g, vis };
  });

  useWindowKeydown((e) => {
    if (matchShortcut(e, 'filter')) {
      e.preventDefault();
      searchRef.current?.focus();
      return;
    }
    if (e.defaultPrevented || isTypingTarget(e.target) || overlayOpen()) return;
    const idx = flat.findIndex((r) => r.key === selectedKey);
    const go = (i: number) => {
      const r = flat[Math.max(0, Math.min(flat.length - 1, i))];
      if (!r) return;
      ordered.noteKeyboard();
      setSelected(r.key);
      document.querySelector(`[data-tl-row="${CSS.escape(r.key)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    if (matchShortcut(e, 'down') || e.key === 'ArrowDown') {
      e.preventDefault();
      go(idx + 1);
    } else if (matchShortcut(e, 'up') || e.key === 'ArrowUp') {
      e.preventDefault();
      go(idx === -1 ? 0 : idx - 1);
    } else if (matchShortcut(e, 'first')) {
      e.preventDefault();
      go(0);
    } else if (matchShortcut(e, 'last')) {
      e.preventDefault();
      go(flat.length - 1);
    } else if (matchShortcut(e, 'open') && idx !== -1) {
      e.preventDefault();
      flat[idx]!.activate();
    }
  });

  const narrowedTo = filters.runId
    ? (() => {
        const sid = runs.get(filters.runId)?.sessionId;
        return sid ? titleOf(sid) || '実行' : '実行';
      })()
    : filters.sessionId
      ? titleOf(filters.sessionId) || '会話'
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 px-6">
        <h1 className="mr-2 shrink-0 text-title whitespace-nowrap text-fg">タイムライン</h1>
        <label className="flex h-7 w-56 min-w-28 shrink items-center gap-1.5 rounded-sm border border-line-subtle px-2 text-fg-3 focus-within:border-line-strong">
          <Search size={13} strokeWidth={1.75} aria-hidden />
          <input
            ref={searchRef}
            aria-label="絞り込み"
            value={filters.text}
            onChange={(e) => setFilters({ text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                if (filters.text) setFilters({ text: '' });
                else e.currentTarget.blur();
              }
            }}
            placeholder="絞り込み"
            className="min-w-0 flex-1 bg-transparent text-ui text-fg placeholder:text-fg-4"
          />
          <Kbd id="filter" />
        </label>
        {narrowedTo && (
          <button
            type="button"
            onClick={() => setFilters({ sessionId: null, runId: null })}
            className="flex h-7 max-w-56 shrink-0 items-center gap-1 rounded-sm border border-line-strong bg-selected px-2 text-ui whitespace-nowrap text-fg"
            aria-label={`「${narrowedTo}」の絞り込みを外す`}
          >
            <span className="truncate">{narrowedTo}</span>
            <X size={12} strokeWidth={1.75} className="shrink-0 text-fg-3" aria-hidden />
          </button>
        )}
        <span className="flex-1" />
        <Tooltip content="実行の中身・受信・予算も出す">
          <button
            type="button"
            aria-pressed={details}
            data-testid="timeline-details"
            onClick={(e) => {
              setDetails(!details);
              // A mouse press should not leave the focus here: J / K / Enter belong to the list.
              if (e.detail > 0) e.currentTarget.blur();
            }}
            className={cn(
              'flex h-7 shrink-0 items-center gap-1.5 rounded-sm border px-2 text-ui whitespace-nowrap',
              details ? 'border-line-strong bg-selected text-fg' : 'border-line-subtle text-fg-2 hover:border-line hover:text-fg',
            )}
          >
            <ListTree size={14} strokeWidth={1.75} aria-hidden />
            詳細
          </button>
        </Tooltip>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto border-t border-line-subtle"
        role="listbox"
        aria-label="出来事"
        data-region="main"
        {...ordered.bind}
      >
        {shown.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            {history.isPending ? null : filtersActive(filters) ? (
              <>
                <div className="text-ui text-fg-2">条件に合う出来事はありません</div>
                <button type="button" onClick={clearFilters} className="text-ui text-accent hover:underline">
                  絞り込みを外す
                </button>
              </>
            ) : (
              <div className="text-ui text-fg-3">まだ出来事はありません</div>
            )}
          </div>
        ) : (
          <div className="flex max-w-[1080px] flex-col gap-3 px-4 py-3">
            {shown.map(({ g, vis }) => {
              const rootTitle = titleOf(g.rootId) || '会話';
              return (
                <section key={g.rootId} aria-label={rootTitle} data-tl-group={g.rootId}>
                  <GroupHeading
                    rootId={g.rootId}
                    title={rootTitle}
                    role={roleOf(g.rootId)}
                    state={known.get(g.rootId)?.state ?? null}
                  />
                  {vis.hidden > 0 && (
                    <button
                      type="button"
                      tabIndex={-1}
                      data-tl-row={`f${g.rootId}`}
                      onClick={() => {
                        setSelected(`f${g.rootId}`);
                        unfold(g.rootId);
                      }}
                      className={cn(
                        'flex h-6 w-full items-center rounded-sm pl-[88px] text-left text-meta text-fg-3 hover:bg-hover hover:text-fg-2',
                        selectedKey === `f${g.rootId}` && 'bg-selected',
                      )}
                    >
                      前の {vis.hidden} 件
                    </button>
                  )}
                  {vis.items.map((it, i) => {
                    const isRoot = it.sessionId === g.rootId;
                    const prev = vis.items[i - 1];
                    const showTime = !prev || formatWhen(prev.ts, now) !== formatWhen(it.ts, now);
                    const title = titleOf(it.sessionId);
                    const select = () => setSelected(it.key);
                    if (it.kind === 'moment')
                      return (
                        <MomentRow
                          key={it.key}
                          m={it}
                          title={title}
                          isRoot={isRoot}
                          now={now}
                          showTime={showTime}
                          selected={selectedKey === it.key}
                          onSelect={select}
                          onJump={() => jumpTo(it.target)}
                        />
                      );
                    if (it.kind === 'note')
                      return (
                        <NoteRow
                          key={it.key}
                          n={it}
                          title={title}
                          isRoot={isRoot}
                          now={now}
                          showTime={showTime}
                          selected={selectedKey === it.key}
                          onSelect={select}
                          onJump={() => jumpTo(it.target)}
                        />
                      );
                    const open = runOpen(it.runId);
                    return (
                      <div key={it.key} role="group" aria-label={title}>
                        <RunRow
                          r={it}
                          title={title}
                          isRoot={isRoot}
                          open={open}
                          now={now}
                          showTime={showTime}
                          selected={selectedKey === it.key}
                          onSelect={select}
                          onToggle={() => toggleRun(it.runId, open)}
                          onJump={() => jumpTo(it.target)}
                          titleOf={titleOf}
                        />
                        {open &&
                          it.steps.map((s) => (
                            <StepRow
                              key={s.key}
                              s={s}
                              now={now}
                              selected={selectedKey === s.key}
                              onSelect={() => setSelected(s.key)}
                              onJump={() => jumpTo(s.target)}
                            />
                          ))}
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
