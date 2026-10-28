import type { Event, Run, Session } from '@acc/protocol';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDown,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  CircleX,
  Coins,
  CornerDownLeft,
  Diamond,
  FileBox,
  Folder,
  GitBranch,
  GitMerge,
  KeyRound,
  ListTodo,
  MessageSquare,
  Play,
  Search,
  Settings2,
  ShieldBan,
  ShieldQuestion,
  User,
  Wrench,
} from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { type ReactNode, useMemo, useRef } from 'react';
import {
  useEventHistory,
  useEventLogVersion,
  useRuns,
  useSessions,
  useTasks,
} from '../../daemon/queries';
import { useRuntime } from '../../daemon/runtime';
import { useStickToBottom } from '../../hooks/useStickToBottom';
import { useWindowKeydown } from '../../hooks/useWindowKeydown';
import { cn } from '../../lib/cn';
import { overlayOpen } from '../../lib/overlay';
import { formatAbsolute, formatClockSeconds } from '../../lib/format';
import { isTypingTarget, matchShortcut } from '../../lib/shortcuts';
import { runStatusToState } from '../../lib/status';
import { untitled } from '../../model/board';
import {
  ACTOR_LABEL,
  type ActorKind,
  EVENT_GROUPS,
  EVENT_GROUP_LABEL,
  type EventIcon,
  type TimelineNames,
  type TimelineRow,
  actorName,
  buildTimelineRows,
  eventContext,
  filtersActive,
  formatGap,
  runIdOfKey,
} from '../../model/timeline';
import { useTimeline } from '../../store/timeline';
import { useUi } from '../../store/ui';
import { Kbd } from '../ui/Kbd';
import { Cost, ElapsedTime } from '../ui/Meta';
import { StatusIcon, StatusLabel } from '../ui/StatusIcon';
import { Tooltip } from '../ui/Tooltip';

const NONE: never[] = [];

const ICONS: Record<EventIcon, ReactNode> = {
  run: <CircleDot size={13} strokeWidth={1.75} />,
  start: <Play size={13} strokeWidth={1.75} />,
  done: <CheckCircle2 size={13} strokeWidth={1.75} />,
  fail: <CircleX size={13} strokeWidth={1.75} />,
  tool: <Wrench size={13} strokeWidth={1.75} />,
  approval: <ShieldQuestion size={13} strokeWidth={1.75} />,
  human: <User size={13} strokeWidth={1.75} />,
  task: <ListTodo size={13} strokeWidth={1.75} />,
  decision: <Diamond size={12} strokeWidth={1.75} fill="currentColor" />,
  integration: <GitMerge size={13} strokeWidth={1.75} />,
  budget: <Coins size={13} strokeWidth={1.75} />,
  grant: <KeyRound size={13} strokeWidth={1.75} />,
  denied: <ShieldBan size={13} strokeWidth={1.75} />,
  message: <MessageSquare size={13} strokeWidth={1.75} />,
  workspace: <GitBranch size={13} strokeWidth={1.75} />,
  artifact: <FileBox size={13} strokeWidth={1.75} />,
  settings: <Settings2 size={13} strokeWidth={1.75} />,
  project: <Folder size={13} strokeWidth={1.75} />,
  session: <MessageSquare size={13} strokeWidth={1.75} />,
};

/**
 * Who acted, as a badge (principle 6): `あなた` / `AI` + its role / `システム`. The badge is
 * the same shape for all three so a column of them scans as "who", not as decoration.
 */
function ActorBadge({ kind, name, orchestrator }: { kind: ActorKind; name: string; orchestrator: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span
        className={cn(
          'flex h-4 shrink-0 items-center gap-1 rounded-xs px-1 text-micro',
          kind === 'human'
            ? 'bg-[color-mix(in_oklch,var(--accent)_14%,transparent)] text-fg'
            : kind === 'agent'
              ? 'bg-selected text-fg-2'
              : 'border border-line-subtle text-fg-3',
        )}
      >
        {kind === 'agent' && orchestrator ? (
          <Diamond size={9} strokeWidth={1.75} className="text-accent" fill="currentColor" />
        ) : kind === 'agent' ? (
          <Bot size={10} strokeWidth={1.75} />
        ) : kind === 'human' ? (
          <User size={10} strokeWidth={1.75} />
        ) : (
          <Settings2 size={10} strokeWidth={1.75} />
        )}
        {ACTOR_LABEL[kind]}
      </span>
      {kind === 'agent' && <span className="truncate text-fg-2">{name}</span>}
    </span>
  );
}

/** Session and task titles from the caches, so events read "「設計チャット」が作業を開始". */
export function useTimelineNames(): TimelineNames {
  const sessions = useSessions().data;
  const tasks = useTasks().data;
  return useMemo(() => {
    const s = new Map((sessions ?? NONE).map((x) => [x.id, untitled(x)]));
    const t = new Map((tasks ?? NONE).map((x) => [x.id, x.title]));
    return { sessionTitle: (id) => s.get(id), taskTitle: (id) => t.get(id) };
  }, [sessions, tasks]);
}

/** Jump from an event to where it happened (the chat message, the task, the integration). */
export function openEventContext(e: Event): boolean {
  const ctx = eventContext(e);
  if (!ctx) return false;
  const ui = useUi.getState();
  if (ctx.kind === 'message') ui.openMessage(ctx.sessionId, ctx.messageId, { from: 'timeline' });
  else if (ctx.kind === 'session') ui.openSession(ctx.sessionId, { from: 'timeline' });
  else if (ctx.kind === 'task') ui.openTask(ctx.taskId);
  else ui.openIntegration(ctx.integrationId);
  return true;
}

function FilterMenu<T extends string>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  selected: T[];
  onChange: (next: T[]) => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-7 items-center gap-1 rounded-sm border px-2 text-ui',
            selected.length > 0 ? 'border-line-strong bg-selected text-fg' : 'border-line-subtle text-fg-2 hover:border-line hover:text-fg',
          )}
        >
          {label}
          {selected.length > 0 && <span className="tabular text-fg-3">{selected.length}</span>}
          <ChevronDown size={12} strokeWidth={1.75} className="text-fg-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="z-[40] max-h-80 min-w-48 overflow-y-auto rounded-md border border-line bg-raised p-1 shadow-float data-[state=open]:animate-[acc-pop-in_180ms_var(--ease-out)]"
        >
          {options.map((o) => (
            <DropdownMenu.CheckboxItem
              key={o.value}
              checked={selected.includes(o.value)}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(c) =>
                onChange(c ? [...selected, o.value] : selected.filter((x) => x !== o.value))
              }
              className="flex h-7 items-center gap-2 rounded-sm px-2 text-ui text-fg outline-none data-[highlighted]:bg-selected"
            >
              <span className="flex size-3.5 items-center justify-center rounded-[3px] border border-line-strong">
                <DropdownMenu.ItemIndicator>
                  <span className="block size-2 rounded-[1px] bg-accent" />
                </DropdownMenu.ItemIndicator>
              </span>
              {o.label}
            </DropdownMenu.CheckboxItem>
          ))}
          {selected.length > 0 && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-line-subtle" />
              <DropdownMenu.Item
                onSelect={() => onChange([])}
                className="flex h-7 items-center rounded-sm px-2 text-ui text-fg-2 outline-none data-[highlighted]:bg-selected"
              >
                選択を解除
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function RunHeader({
  row,
  sessions,
  selected,
}: {
  row: TimelineRow & { kind: 'run' };
  sessions: Map<string, Session>;
  selected: boolean;
}) {
  const toggleRun = useTimeline((s) => s.toggleRun);
  const run = row.run;
  const session = run ? sessions.get(run.sessionId) : undefined;
  const state = run ? runStatusToState(run.status) : 'idle';
  const live = run && (run.status === 'running' || run.status === 'awaiting_approval' || run.status === 'queued');
  return (
    <button
      type="button"
      onClick={() => toggleRun(row.runId, row.collapsed)}
      className={cn(
        'flex h-7 w-full items-center gap-2 border-b border-line-subtle bg-canvas pr-6 pl-[120px] text-left text-ui',
        selected ? 'bg-selected' : 'hover:bg-hover',
      )}
    >
      {row.collapsed ? (
        <ChevronRight size={13} strokeWidth={1.75} className="text-fg-3" />
      ) : (
        <ChevronDown size={13} strokeWidth={1.75} className="text-fg-3" />
      )}
      <span className="font-mono text-meta text-fg-3">Run #{row.runId.slice(-3)}</span>
      <span className="min-w-0 flex-1 truncate">
        <span className="text-fg-3">{run?.kind === 'orchestrator' ? 'Orchestrator' : session?.kind === 'chat' ? 'チャット' : 'Worker'}</span>
        <span className="px-1 text-fg-4">·</span>
        <span className="text-fg">{session ? untitled(session) : '—'}</span>
        {row.collapsed && <span className="ml-1.5 text-fg-3 tabular">（{row.count} 件）</span>}
      </span>
      {run && (
        <span className="flex items-center gap-2">
          <StatusIcon state={state} size={12} />
          <StatusLabel state={state} />
          <span className="text-fg-4">·</span>
          <ElapsedTime start={run.startedAt ?? run.createdAt} end={live ? null : run.endedAt} />
          <span className="text-fg-4">·</span>
          <Cost usd={run.usage.costUsd} source={run.usage.costSource} />
        </span>
      )}
    </button>
  );
}

function EventRow({
  row,
  sessions,
  runs,
  selected,
  onSelect,
  onOpen,
}: {
  row: TimelineRow & { kind: 'event' };
  sessions: Map<string, Session>;
  runs: Map<string, Run>;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const { event: e, view } = row;
  const orchestrator = e.actor.kind === 'agent' && runs.get(e.actor.runId)?.kind === 'orchestrator';
  const name = actorName(e.actor, sessions, runs);
  const gap = formatGap(row.gapMs);
  const ctx = eventContext(e);
  const denied = e.type === 'policy.denied';
  return (
    <div
      role="option"
      aria-selected={selected}
      data-tl-row={row.key}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cn(
        'group relative flex flex-col justify-center pr-6 text-ui',
        view.detail ? 'h-11' : 'h-7',
        selected ? 'bg-selected' : 'hover:bg-hover',
      )}
    >
      {(view.isDecision || denied || selected) && (
        <span
          className={cn(
            'absolute top-0.5 bottom-0.5 left-0 w-0.5 rounded-full',
            denied && !selected ? 'bg-st-failed' : 'bg-accent',
          )}
        />
      )}
      <div className="flex h-7 items-center">
        <Tooltip content={formatAbsolute(e.ts)}>
          <span className="w-[72px] shrink-0 pl-4 text-meta text-fg-3 tabular">{formatClockSeconds(e.ts)}</span>
        </Tooltip>
        {/* The pause before this step: long waits stand out without a chart. */}
        <span
          className={cn(
            'w-12 shrink-0 pr-2 text-right text-micro tabular',
            row.gapMs != null && row.gapMs >= 60_000 ? 'text-fg-3' : 'text-fg-4',
          )}
          aria-label={gap ? `前のイベントから ${gap.slice(1)}` : undefined}
        >
          {gap}
        </span>
        <span className={cn('flex w-[150px] shrink-0 items-center gap-1.5 truncate', row.inRun && 'pl-3')}>
          <ActorBadge kind={e.actor.kind} name={name} orchestrator={orchestrator} />
          {row.runTag && <span className="shrink-0 font-mono text-micro text-fg-4">#{row.runTag.slice(-3)}</span>}
        </span>
        <span
          className={cn(
            'flex w-[120px] shrink-0 items-center gap-1.5',
            view.isError ? 'text-st-failed' : view.isDecision ? 'text-accent' : 'text-fg-2',
          )}
        >
          {view.isDecision ? (
            <span className="rounded-xs bg-[color-mix(in_oklch,var(--accent)_16%,transparent)] px-1.5 text-micro text-accent">判断</span>
          ) : (
            <>
              <span className={view.isError ? undefined : 'text-fg-3'}>{ICONS[view.icon]}</span>
              <span className="truncate">{view.label}</span>
            </>
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-fg">{view.summary}</span>
        {ctx && (
          <button
            type="button"
            tabIndex={-1}
            onClick={(ev) => {
              ev.stopPropagation();
              onOpen();
            }}
            className={cn(
              'ml-2 flex h-5 shrink-0 items-center gap-1 rounded-xs px-1.5 text-meta text-fg-3 hover:bg-hover hover:text-fg',
              selected ? 'visible' : 'invisible group-hover:visible',
            )}
          >
            {ctx.label}
            <CornerDownLeft size={11} strokeWidth={1.75} />
          </button>
        )}
      </div>
      {view.detail && (
        <div className="-mt-1 truncate pl-[390px] text-meta text-fg-3">
          {view.isDecision ? `「${view.detail}」` : denied ? `理由: ${view.detail}` : view.detail}
        </div>
      )}
    </div>
  );
}

export function TimelineView() {
  const rt = useRuntime();
  const history = useEventHistory();
  const version = useEventLogVersion();
  const sessionsQ = useSessions();
  const runsQ = useRuns();
  const filters = useTimeline((s) => s.filters);
  const setFilters = useTimeline((s) => s.setFilters);
  const clearFilters = useTimeline((s) => s.clearFilters);
  const groupByRun = useTimeline((s) => s.groupByRun);
  const toggled = useTimeline((s) => s.toggled);
  const toggleRun = useTimeline((s) => s.toggleRun);
  const showAll = useTimeline((s) => s.showAll);
  const setShowAll = useTimeline((s) => s.setShowAll);
  const selectedKey = useUi((s) => s.timelineSelected);
  const setSelected = useUi((s) => s.setTimelineSelected);
  const setPanelOpen = useUi((s) => s.setPanelOpen);
  const stick = useStickToBottom();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const names = useTimelineNames();

  const sessions = useMemo(() => new Map((sessionsQ.data ?? NONE).map((s) => [s.id, s])), [sessionsQ.data]);
  const runs = useMemo(() => new Map((runsQ.data ?? NONE).map((r) => [r.id, r])), [runsQ.data]);
  const events = rt.streams.events.events;
  const rows = useMemo(
    () => buildTimelineRows({ events, filters, groupByRun, runs, toggled, showAll, names }),
    // `version` changes whenever the (mutable) event log changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, events, filters, groupByRun, runs, toggled, showAll, names],
  );


  // The React Compiler is not used in this app; TanStack Virtual is fine without memoization.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: stick.getElement,
    estimateSize: (i) => {
      const r = rows[i];
      return r?.kind === 'event' && r.view.detail ? 44 : 28;
    },
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 20,
    rangeExtractor: (range) => {
      // Keep the run header of the first visible row rendered (sticky, §5.3).
      const active = rows[range.startIndex]?.header ?? -1;
      const next = new Set(defaultRangeExtractor(range));
      if (active !== -1) next.add(active);
      return [...next].sort((a, b) => a - b);
    },
  });

  const open = (e: Event) => {
    openEventContext(e);
  };
  const selectRow = (key: string) => {
    setSelected(key);
    setPanelOpen('timeline', true);
  };

  useWindowKeydown((e) => {
    if (matchShortcut(e, 'filter')) {
      e.preventDefault();
      searchRef.current?.focus();
      return;
    }
    if (e.defaultPrevented || isTypingTarget(e.target)) return;
    if (overlayOpen()) return;
    const idx = rows.findIndex((r) => r.key === selectedKey);
    const go = (i: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!r) return;
      setSelected(r.key);
      virt.scrollToIndex(rows.indexOf(r), { align: 'auto' });
    };
    if (matchShortcut(e, 'down') || e.key === 'ArrowDown') {
      e.preventDefault();
      go(idx + 1);
    } else if (matchShortcut(e, 'up') || e.key === 'ArrowUp') {
      e.preventDefault();
      go(idx === -1 ? rows.length - 1 : idx - 1);
    } else if (matchShortcut(e, 'first')) {
      e.preventDefault();
      go(0);
    } else if (matchShortcut(e, 'last')) {
      e.preventDefault();
      go(rows.length - 1);
    } else if (matchShortcut(e, 'open') && idx !== -1) {
      const r = rows[idx]!;
      e.preventDefault();
      if (r.kind === 'run') toggleRun(r.runId, r.collapsed);
      else open(r.event);
    } else if (matchShortcut(e, 'peek') && idx !== -1) {
      e.preventDefault();
      useUi.getState().togglePanel('timeline');
    }
  });

  const newCount = stick.unfollowedAt
    ? events.filter((e) => Date.parse(e.ts) > stick.unfollowedAt!).length
    : 0;
  const sessionOptions = (sessionsQ.data ?? NONE).slice(0, 50).map((s) => ({ value: s.id, label: untitled(s) }));
  const items = virt.getVirtualItems();
  const activeSticky = rows[virt.range?.startIndex ?? 0]?.header ?? -1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 px-6">
        <h1 className="mr-2 text-title text-fg">タイムライン</h1>
        <FilterMenu
          label="種類"
          options={EVENT_GROUPS.map((g) => ({ value: g, label: EVENT_GROUP_LABEL[g] }))}
          selected={filters.groups}
          onChange={(groups) => setFilters({ groups })}
        />
        <FilterMenu
          label="主体"
          options={(Object.keys(ACTOR_LABEL) as ActorKind[]).map((a) => ({ value: a, label: ACTOR_LABEL[a] }))}
          selected={filters.actors}
          onChange={(actors) => setFilters({ actors })}
        />
        <FilterMenu
          label="セッション"
          options={sessionOptions}
          selected={filters.sessionId ? [filters.sessionId] : []}
          onChange={(ids) => setFilters({ sessionId: ids[ids.length - 1] ?? null, runId: null })}
        />
        <label className="flex h-7 w-56 items-center gap-1.5 rounded-sm border border-line-subtle px-2 text-fg-3 focus-within:border-line-strong">
          <Search size={13} strokeWidth={1.75} />
          <input
            ref={searchRef}
            value={filters.text}
            onChange={(e) => setFilters({ text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                e.currentTarget.blur();
              }
            }}
            placeholder="絞り込み…"
            className="min-w-0 flex-1 bg-transparent text-ui text-fg placeholder:text-fg-4"
          />
          <Kbd id="filter" />
        </label>
        {filtersActive(filters) && (
          <button type="button" onClick={clearFilters} className="h-7 px-1.5 text-ui text-fg-3 hover:text-fg">
            クリア
          </button>
        )}
        <span className="flex-1" />
        <Tooltip content="ロックの変更・使用量・ツールの結果など、細かな記録も並べます">
          <button
            type="button"
            role="switch"
            aria-checked={showAll}
            onClick={() => setShowAll(!showAll)}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-sm px-2 text-meta',
              showAll ? 'bg-selected text-fg' : 'text-fg-3 hover:text-fg-2',
            )}
          >
            <span
              className={cn(
                'relative h-3 w-5 rounded-full transition-colors duration-[120ms]',
                showAll ? 'bg-accent' : 'bg-line-strong',
              )}
              aria-hidden="true"
            >
              <span
                className={cn(
                  'absolute top-0.5 size-2 rounded-full bg-white transition-transform duration-[120ms]',
                  showAll ? 'translate-x-2.5' : 'translate-x-0.5',
                )}
              />
            </span>
            詳細なイベントも表示
          </button>
        </Tooltip>
        <button
          type="button"
          onClick={() => stick.scrollToBottom()}
          className={cn('flex items-center gap-1.5 text-meta', stick.following ? 'text-fg-2' : 'text-fg-4 hover:text-fg-2')}
        >
          <span
            className="size-1.5 rounded-full"
            style={{ background: stick.following ? 'var(--st-completed)' : 'var(--text-disabled)' }}
          />
          ライブ追従
        </button>
      </div>

      <div className="relative min-h-0 flex-1 border-t border-line-subtle">
        <div ref={stick.scrollRef} className="h-full overflow-y-auto" role="listbox" aria-label="イベント" data-region="main">
          {rows.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              {history.isPending ? (
                <span className="text-ui text-fg-3">イベントを読み込んでいます…</span>
              ) : filtersActive(filters) ? (
                <>
                  <div className="text-title text-fg-2">条件に合うイベントはありません</div>
                  <button type="button" onClick={clearFilters} className="text-ui text-accent hover:underline">
                    フィルタをクリア
                  </button>
                </>
              ) : (
                <>
                  <div className="text-title text-fg-2">まだイベントはありません</div>
                  <div className="text-ui text-fg-3">エージェントやチャットが動くと、ここに時系列で記録されます。</div>
                </>
              )}
            </div>
          ) : (
            <div ref={stick.contentRef} className="relative w-full" style={{ height: virt.getTotalSize() + 24 }}>
              {items.map((vi) => {
                const r = rows[vi.index]!;
                const isSticky = r.kind === 'run' && activeSticky === vi.index;
                return (
                  <div
                    key={vi.key}
                    data-index={vi.index}
                    ref={virt.measureElement}
                    className={cn('left-0 w-full', isSticky ? 'sticky top-0 z-10' : 'absolute top-0')}
                    style={isSticky ? undefined : { transform: `translateY(${vi.start}px)` }}
                  >
                    {r.kind === 'run' ? (
                      <RunHeader row={r} sessions={sessions} selected={r.key === selectedKey} />
                    ) : (
                      <EventRow
                        row={r}
                        sessions={sessions}
                        runs={runs}
                        selected={r.key === selectedKey}
                        onSelect={() => selectRow(r.key)}
                        onOpen={() => open(r.event)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {!stick.following && rows.length > 0 && (
          <button
            type="button"
            onClick={() => stick.scrollToBottom('smooth')}
            className="absolute right-6 bottom-4 z-20 flex h-7 items-center gap-1.5 rounded-full border border-line bg-raised px-3 text-meta text-fg-2 shadow-float hover:text-fg"
            style={{ animation: 'acc-fade-in 180ms var(--ease-out)' }}
          >
            <ArrowDown size={13} strokeWidth={1.75} />
            最新へ{newCount > 0 && <span className="tabular">{newCount}件</span>}
          </button>
        )}
      </div>
    </div>
  );
}

export function useTimelineSelection(): { event: Event | null; run: Run | null } {
  const rt = useRuntime();
  const key = useUi((s) => s.timelineSelected);
  useEventLogVersion();
  const runs = useRuns().data ?? NONE;
  if (!key) return { event: null, run: null };
  const runId = runIdOfKey(key);
  if (runId) return { event: null, run: runs.find((r) => r.id === runId) ?? null };
  const seq = Number(key.slice(1));
  return { event: rt.streams.events.events.find((e) => e.seq === seq) ?? null, run: null };
}

