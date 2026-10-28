import { CheckCircle2, ChevronRight, Diamond, MessageSquare, Network, Play, Sparkles, Wrench } from 'lucide-react';
import { LayoutGroup, motion } from 'motion/react';
import { type ReactNode, useState } from 'react';
import { approve, newChat, retry, switchMode } from '../../app/commands';
import { archiveSession, createSession, sendMessage } from '../../daemon/actions';
import { useTasks } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { useDeferredReorder } from '../../hooks/useDeferredReorder';
import { useNow } from '../../hooks/useNow';
import { dayBucket } from '../../lib/format';
import { useWindowKeydown } from '../../hooks/useWindowKeydown';
import { cn } from '../../lib/cn';
import { overlayOpen } from '../../lib/overlay';
import { sumUsage } from '../../lib/format';
import { isTypingTarget, matchShortcut } from '../../lib/shortcuts';
import { describeApproval } from '../../model/approval';
import { type BoardItem, ZONE_LABEL, type Zone, attentionCounts } from '../../model/board';
import { useBoard } from '../../model/useBoard';
import { useIsDemo } from '../../model/useDemo';
import { Kbd } from '../ui/Kbd';
import { useUi } from '../../store/ui';
import { Cost, Skeleton } from '../ui/Meta';
import { AgentRow, AttentionCard } from './BoardRows';

const DEMO_PROMPT =
  'README を改善したい。構成の見直しとセットアップ手順の追記を、2 人の Worker に分担して並列に進め、最後に統合して私の承認を待ってください。';

const SECTION_ORDER: Zone[] = ['attention', 'running', 'queued', 'done', 'idle'];
const DEFAULT_COLLAPSED: Record<Zone, boolean> = {
  attention: false,
  running: false,
  queued: true,
  done: true,
  idle: true,
};

function ViewHeader({ items }: { items: BoardItem[] }) {
  const counts = attentionCounts(items);
  const running = items.filter((i) => i.state === 'running' || (i.zone === 'attention' && i.state === 'awaiting_approval')).length;
  const total = sumUsage(items.flatMap((i) => i.runs.map((r) => r.usage)));
  return (
    <div className="sticky top-0 z-20 mx-auto flex h-11 w-full max-w-[1200px] shrink-0 items-center gap-3 bg-canvas px-6">
      <h1 className="text-title text-fg">司令室</h1>
      <span className="flex-1" />
      <span className="flex items-center gap-1.5 text-meta text-fg-3 tabular">
        <span>
          実行中 <span className="text-fg-2">{running}</span>
        </span>
        <span className="text-fg-4">·</span>
        <span>
          要対応{' '}
          <span className={counts.total > 0 ? 'text-st-awaiting_approval' : 'text-fg-2'}>{counts.total}</span>
        </span>
        <span className="text-fg-4">·</span>
        <span className="flex items-center gap-1">
          合計 <Cost usd={total.costUsd} source={total.costSource} className="text-fg-2" />
        </span>
      </span>
    </div>
  );
}

/** Only while an orchestration is in progress (§5.1). */
function GoalBar({ items }: { items: BoardItem[] }) {
  const tasks = useTasks().data ?? [];
  const openSession = useUi((s) => s.openSession);
  const orch = items.find(
    (i) => i.run?.kind === 'orchestrator' && (i.state === 'running' || i.state === 'awaiting_approval'),
  );
  if (!orch?.session) return null;
  const mine = tasks.filter(
    (t) => t.createdBy.kind === 'agent' && t.createdBy.sessionId === orch.session!.id,
  );
  const done = mine.filter((t) => t.status === 'done').length;
  return (
    <button
      type="button"
      onClick={() => openSession(orch.session!.id)}
      className="mx-6 mb-2 flex h-9 items-center gap-3 rounded-md border border-line-subtle bg-surface px-3 text-left text-ui hover:border-line"
    >
      <Diamond size={13} strokeWidth={1.75} className="text-accent" fill="currentColor" />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-fg-3">目標: </span>
        <span className="text-fg">{orch.task?.title ?? orch.title}</span>
        <span className="text-fg-3">（Orchestrator: {orch.title}）</span>
      </span>
      {mine.length > 0 && (
        <span className="flex items-center gap-2 text-meta text-fg-3 tabular">
          Task {done}/{mine.length}
          <span className="flex gap-0.5" aria-hidden="true">
            {mine.map((t) => (
              <span
                key={t.id}
                className="h-2.5 w-1.5 rounded-[1px]"
                style={{ background: t.status === 'done' ? 'var(--accent)' : 'var(--bg-selected)' }}
              />
            ))}
          </span>
        </span>
      )}
      <Cost usd={orch.costUsd} source={orch.costSource} />
    </button>
  );
}

function EmptyBoard() {
  const rt = useRuntime();
  const projectId = useUi((s) => s.projectId);
  const openSession = useUi((s) => s.openSession);
  const [text, setText] = useState('');
  const connected = useConnectionState() === 'open';
  const demo = useIsDemo();
  const start = async (kind: 'chat' | 'agent', prompt?: string) => {
    const s = await createSession(rt, { projectId, kind });
    if (!s) return;
    openSession(s.id);
    if (prompt) await sendMessage(rt, s.id, prompt);
  };
  const chips: { label: string; icon: ReactNode; run: () => void }[] = [
    { label: 'チャットで相談する', icon: <MessageSquare size={14} strokeWidth={1.5} />, run: () => void newChat(rt) },
    { label: 'エージェントに作業を任せる', icon: <Wrench size={14} strokeWidth={1.5} />, run: () => void start('agent') },
    {
      label: 'Orchestrator に分担させる',
      icon: <Network size={14} strokeWidth={1.5} />,
      run: () => void start('chat', text.trim() || undefined),
    },
  ];
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="mx-auto flex w-full max-w-[600px] flex-col items-center px-6 pt-[18vh]"
    >
      <Sparkles size={20} strokeWidth={1.5} className="text-fg-3" />
      <h2 className="mt-3 text-heading text-fg">何を進めますか？</h2>
      <p className="mt-1 text-ui text-fg-3">指示を書くと、チャットが始まります。あとからエージェントに任せることもできます。</p>
      {demo && (
        <button
          type="button"
          autoFocus
          onClick={() => void start('chat', DEMO_PROMPT)}
          className="group mt-6 flex w-full items-center gap-3 rounded-md border border-line bg-surface px-4 py-3 text-left hover:border-line-strong"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-fg">
            <Play size={15} strokeWidth={1.75} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-ui font-medium text-fg">デモ：2 人のエージェントで README を改善する</span>
            <span className="block text-meta text-fg-3">
              Orchestrator が Task を分け、Worker 2 人が並列に作業し、統合して承認を待つまでを体験できます。
            </span>
          </span>
          <Kbd keys="Enter" />
        </button>
      )}
      <form
        className="mt-6 w-full"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void start('chat', text.trim());
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) e.stopPropagation();
          }}
          disabled={!connected}
          placeholder="例: README の構成を見直して、足りない節を提案して"
          className="h-11 w-full rounded-md border border-line bg-surface px-4 text-chat text-fg placeholder:text-fg-4 focus:border-[var(--focus-ring)]"
        />
      </form>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {chips.map((c) => (
          <button
            key={c.label}
            type="button"
            onClick={c.run}
            className="flex h-7 items-center gap-1.5 rounded-full border border-line px-3 text-ui text-fg-2 hover:border-line-strong hover:text-fg"
          >
            <span className="text-fg-3">{c.icon}</span>
            {c.label}
          </button>
        ))}
      </div>
    </motion.div>
  );
}

/** `· 今日 N` on the done group (ticks with the shared clock only here). */
function DoneToday({ items }: { items: BoardItem[] }) {
  const now = useNow();
  const n = items.filter((i) => i.run?.endedAt && dayBucket(i.run.endedAt, now) === 'today').length;
  return n > 0 ? <span className="text-fg-4">· 今日 {n}</span> : null;
}

function SectionTitle({
  zone,
  count,
  collapsed,
  onToggle,
  pending,
  extra,
}: {
  zone: Zone;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  pending: number;
  extra?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="group flex h-8 w-full items-center gap-2 px-3 text-left text-micro text-fg-3 hover:text-fg-2"
    >
      <span className={zone === 'attention' && count > 0 ? 'text-fg' : undefined}>{ZONE_LABEL[zone]}</span>
      <span className="tabular">{count}</span>
      {extra}
      {pending > 0 && <span className="text-accent">· 更新 {pending}件</span>}
      <ChevronRight
        size={12}
        strokeWidth={1.75}
        className={cn('text-fg-4 transition-transform duration-[120ms]', !collapsed && 'rotate-90')}
      />
    </button>
  );
}

export function CommandView() {
  const rt = useRuntime();
  const { items, loading } = useBoard();
  const selectedId = useUi((s) => s.selectedId);
  const select = useUi((s) => s.select);
  const openSession = useUi((s) => s.openSession);
  const collapsed = useUi((s) => s.collapsed);
  const toggleCollapsed = useUi((s) => s.toggleCollapsed);
  const togglePanel = useUi((s) => s.togglePanel);
  const setPanelOpen = useUi((s) => s.setPanelOpen);
  const deferred = useDeferredReorder(
    items,
    (i) => i.id,
    (i) => i.zone,
  );

  const isCollapsed = (z: Zone) => collapsed[`cmd.${z}`] ?? DEFAULT_COLLAPSED[z];
  const groups = SECTION_ORDER.map((zone) => ({
    zone,
    items: deferred.items.filter((i) => deferred.groupOf(i) === zone),
  }));
  const visible = groups.flatMap((g) => (isCollapsed(g.zone) ? [] : g.items));
  const selected = items.find((i) => i.id === selectedId) ?? null;

  const open = (item: BoardItem) => {
    if (item.session) openSession(item.session.id, { from: 'command' });
    else {
      select(item.id);
      setPanelOpen('command', true);
    }
  };
  const choose = (item: BoardItem) => {
    select(item.id);
    setPanelOpen('command', true);
  };

  const move = (to: number) => {
    const target = visible[Math.max(0, Math.min(visible.length - 1, to))];
    if (!target) return;
    deferred.noteKeyboard();
    select(target.id, true);
    document
      .querySelector(`[data-board-item="${CSS.escape(target.id)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  };

  useWindowKeydown((e) => {
    if (e.defaultPrevented || isTypingTarget(e.target)) return;
    if (overlayOpen()) return;
    const idx = selected ? visible.findIndex((i) => i.id === selected.id) : -1;
    if (matchShortcut(e, 'down') || (e.key === 'ArrowDown' && !e.ctrlKey && !e.altKey && !e.metaKey)) {
      e.preventDefault();
      move(idx + 1);
    } else if (matchShortcut(e, 'up') || (e.key === 'ArrowUp' && !e.ctrlKey && !e.altKey && !e.metaKey)) {
      e.preventDefault();
      move(idx === -1 ? 0 : idx - 1);
    } else if (matchShortcut(e, 'first')) {
      e.preventDefault();
      move(0);
    } else if (matchShortcut(e, 'last')) {
      e.preventDefault();
      move(visible.length - 1);
    } else if (!selected) {
      return;
    } else if (matchShortcut(e, 'open')) {
      // The focused element handles Enter itself (buttons inside a card).
      if (e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      open(selected);
    } else if (matchShortcut(e, 'peek')) {
      if (e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      togglePanel('command');
    } else if (selected.approval && (e.target === document.body || !(e.target instanceof HTMLElement) || !e.target.closest('[data-board-item]'))) {
      const view = describeApproval(selected.approval);
      if (view.risk === 'high' ? matchShortcut(e, 'approveDanger') : matchShortcut(e, 'approve')) {
        e.preventDefault();
        void approve(rt, selected.approval);
      } else if (matchShortcut(e, 'reject')) {
        e.preventDefault();
        // Move focus onto the card, whose own handler opens the reason input.
        const el = document.querySelector<HTMLElement>(`[data-board-item="${CSS.escape(selected.id)}"]`);
        el?.focus();
        el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
      }
    } else if (matchShortcut(e, 'retry') && selected.run && (selected.state === 'failed' || selected.state === 'interrupted')) {
      e.preventDefault();
      void retry(rt, selected.run);
    } else if (matchShortcut(e, 'archive') && selected.session) {
      e.preventDefault();
      void archiveSession(rt, selected.session);
    }
  });

  const attention = groups[0]!.items;
  const runningCount = groups[1]!.items.length + groups[2]!.items.length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader items={items} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-10" data-region="main" tabIndex={-1}>
        {/* Cap the line length: status, title and the right-hand columns stay in one glance. */}
        <div className="mx-auto w-full max-w-[1200px]">
        {loading ? (
          <div className="flex flex-col gap-2 px-6 pt-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[52px] w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyBoard />
        ) : (
          <>
            <GoalBar items={items} />
            <LayoutGroup>
              <div role="listbox" aria-label="エージェント" className="flex flex-col gap-4 px-3" {...deferred.bind}>
                {groups.map(({ zone, items: list }) => {
                  if (zone === 'attention') {
                    return (
                      <section key={zone} aria-label="要対応">
                        <SectionTitle
                          zone={zone}
                          count={list.length}
                          collapsed={isCollapsed(zone)}
                          onToggle={() => toggleCollapsed(`cmd.${zone}`, DEFAULT_COLLAPSED[zone])}
                          pending={deferred.pending}
                        />
                        {!isCollapsed(zone) &&
                          (list.length === 0 ? (
                            runningCount > 0 && (
                              <div className="flex h-9 items-center gap-2 px-3 text-ui text-fg-3">
                                <CheckCircle2 size={14} strokeWidth={1.5} />
                                すべて順調です。あなたの出番はまだありません。
                              </div>
                            )
                          ) : (
                            <div className="flex flex-col gap-2 px-3">
                              {list.map((it) => (
                                <AttentionCard
                                  key={it.id}
                                  item={it}
                                  selected={it.id === selectedId}
                                  onSelect={() => choose(it)}
                                  onOpen={() => open(it)}
                                />
                              ))}
                            </div>
                          ))}
                      </section>
                    );
                  }
                  if (list.length === 0) return null;
                  return (
                    <section key={zone} aria-label={ZONE_LABEL[zone]}>
                      <SectionTitle
                        zone={zone}
                        count={list.length}
                        collapsed={isCollapsed(zone)}
                        onToggle={() => toggleCollapsed(`cmd.${zone}`, DEFAULT_COLLAPSED[zone])}
                        pending={0}
                        extra={zone === 'done' ? <DoneToday items={list} /> : undefined}
                      />
                      {!isCollapsed(zone) && (
                        <div className="flex flex-col px-3">
                          {list.map((it) => (
                            <AgentRow
                              key={it.id}
                              item={it}
                              selected={it.id === selectedId}
                              onSelect={() => choose(it)}
                              onOpen={() => open(it)}
                            />
                          ))}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            </LayoutGroup>
            {attention.length === 0 && runningCount === 0 && (
              <div className="px-6 pt-6 text-ui text-fg-3">
                動いているエージェントはありません。
                <button type="button" className="ml-1 text-accent hover:underline" onClick={() => switchMode(rt, 'focus')}>
                  最近のセッションを開く
                </button>
              </div>
            )}
          </>
        )}
        </div>
      </div>
    </div>
  );
}
