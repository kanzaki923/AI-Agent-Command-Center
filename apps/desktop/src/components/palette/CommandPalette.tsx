import type { SessionSearchHit } from '@acc/protocol';
import { useQuery } from '@tanstack/react-query';
import { Command, defaultFilter, useCommandState } from 'cmdk';
import {
  Archive,
  Bell,
  BellOff,
  Check,
  ChevronRight,
  Cpu,
  CornerDownLeft,
  Diamond,
  FolderPlus,
  Hand,
  History,
  House,
  Keyboard,
  LoaderCircle,
  MessageSquarePlus,
  MessageSquareText,
  Moon,
  PanelLeft,
  PanelRight,
  Pin,
  Play,
  Rows3,
  Settings,
  Sparkles,
  Square,
  Sun,
  Wand2,
} from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { askAi, goToAttention, newChat } from '../../app/commands';
import { startDemo } from '../../app/demo';
import {
  archiveSession,
  delegateSession,
  resumeTree,
  setPinned,
  setSessionModel,
  stopTree,
  undelegateSession,
} from '../../daemon/actions';
import { useHomeSelect } from '../../daemon/home';
import { useMethods, useModels, useSessions } from '../../daemon/queries';
import { useRuntime } from '../../daemon/runtime';
import { treeRelations, useSessionTree } from '../../daemon/tree';
import { cn } from '../../lib/cn';
import { highlightTerms } from '../../lib/highlight';
import { relativeCost } from '../../lib/models';
import type { ShortcutId } from '../../lib/shortcuts';
import { sessionTitle } from '../../lib/states';
import { useTimeline } from '../../store/timeline';
import { useUi } from '../../store/ui';
import { Kbd } from '../ui/Kbd';
import { TimeStamp } from '../ui/Meta';
import { StateIcon } from '../ui/StateIcon';

const NONE: never[] = [];

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  keywords: string[];
  shortcut?: ShortcutId;
  /** Keep the palette open (navigates into a nested page). */
  nested?: boolean;
  run: () => void;
}

const I = (C: typeof House) => <C size={15} strokeWidth={1.5} />;

function Row({ item, onRun }: { item: PaletteItem; onRun: (i: PaletteItem) => void }) {
  return (
    <Command.Item
      value={`${item.id} ${item.label}`}
      keywords={item.keywords}
      onSelect={() => onRun(item)}
      className="group flex h-9 items-center gap-3 rounded-sm px-3 text-ui text-fg data-[selected=true]:bg-selected"
    >
      <span className="flex w-4 shrink-0 justify-center text-fg-3 group-data-[selected=true]:text-fg-2">{item.icon}</span>
      <span className="min-w-0 truncate">{item.label}</span>
      {item.hint && <span className="min-w-0 truncate text-fg-3">{item.hint}</span>}
      <span className="flex-1" />
      {item.nested && <ChevronRight size={14} strokeWidth={1.5} className="text-fg-4" />}
      {item.shortcut && <Kbd id={item.shortcut} />}
    </Command.Item>
  );
}

function Group({ heading, items, onRun }: { heading: string; items: PaletteItem[]; onRun: (i: PaletteItem) => void }) {
  if (items.length === 0) return null;
  return (
    <Command.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:h-7 [&_[cmdk-group-heading]]:items-end [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-micro [&_[cmdk-group-heading]]:text-fg-3"
    >
      {items.map((i) => (
        <Row key={i.id} item={i} onRun={onRun} />
      ))}
    </Command.Group>
  );
}

/** The part of the palette query that searches messages (`#` prefix included; not `>` / `?`). */
export function messageQuery(q: string): string {
  if (q.startsWith('>') || q.startsWith('?')) return '';
  return (q.startsWith('#') ? q.slice(1) : q).trim();
}

/** Snippet with the searched words marked. */
function Highlighted({ text, terms }: { text: string; terms: string }) {
  return (
    <>
      {highlightTerms(text, terms).map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : (
          <mark key={i} className="rounded-[2px] bg-[color-mix(in_oklch,var(--accent)_28%,transparent)] px-px text-fg">
            {p.mark}
          </mark>
        ),
      )}
    </>
  );
}

/** session.search hits: snippet (terms marked) · conversation · when. Enter jumps there. */
function MessageHits({
  hits,
  terms,
  onOpen,
}: {
  hits: readonly SessionSearchHit[];
  terms: string;
  onOpen: (h: SessionSearchHit) => void;
}) {
  if (hits.length === 0) return null;
  return (
    <Command.Group
      forceMount
      heading="メッセージ"
      className="[&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:h-7 [&_[cmdk-group-heading]]:items-end [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-micro [&_[cmdk-group-heading]]:text-fg-3"
    >
      {hits.map((h) => (
        <Command.Item
          key={h.messageId}
          forceMount
          value={`message:${h.messageId}`}
          onSelect={() => onOpen(h)}
          data-testid="message-hit"
          className="group flex min-h-11 flex-col justify-center gap-0.5 rounded-sm px-3 py-1 text-ui data-[selected=true]:bg-selected"
        >
          <span className="flex w-full min-w-0 items-center gap-3">
            <MessageSquareText size={15} strokeWidth={1.5} className="shrink-0 text-fg-3" />
            <span className="min-w-0 truncate text-fg-2">
              <Highlighted text={h.snippet} terms={terms} />
            </span>
          </span>
          <span className="flex w-full items-center gap-1.5 pl-7 text-meta text-fg-3">
            <span className="truncate">{h.sessionTitle || '新しい会話'}</span>
            <span className="text-fg-4">·</span>
            <TimeStamp iso={h.createdAt} className="text-meta text-fg-3" />
          </span>
        </Command.Item>
      ))}
    </Command.Group>
  );
}

/** §8.2: 「◯◯」に一致するものはありません, right above "AI に頼む" (cmdk counts the matches). */
function NoMatches({ text, pending, hits }: { text: string; pending: boolean; hits: number }) {
  const count = useCommandState((s) => s.filtered.count);
  // Forced rows (message hits, AI に頼む) are counted too; only the AI row means nothing matched.
  if (pending || hits > 0 || count > 1) return null;
  return (
    <div className="px-3 pt-3 pb-1 text-ui text-fg-3" data-testid="palette-no-match">
      「{text}」に一致するものはありません
    </div>
  );
}

/**
 * Command palette (Ctrl+K, §7.1). Fuzzy matching runs over Japanese labels, English names
 * and romaji. Its contents exist only while it is open (and through the close fade):
 * hidden but mounted, it re-rendered its whole list on every daemon event, which was about
 * half of the render work when ten runs started at once (e2e/perf.js). Mounting ~50 rows
 * on open stays well inside the 50ms budget.
 */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const [shownFor, setShownFor] = useState(open);
  const [closing, setClosing] = useState(false);
  // Derived during render: a close keeps the contents mounted until the fade ends.
  if (open !== shownFor) {
    setShownFor(open);
    setClosing(!open);
  }
  if (!open && !closing) return null;
  return <PaletteContents open={open} onClosed={() => setClosing(false)} />;
}

function PaletteContents({ open, onClosed }: { open: boolean; onClosed: () => void }) {
  const rt = useRuntime();
  const query = useUi((s) => s.paletteQuery);
  const pages = useUi((s) => s.palettePages);
  const focusSessionId = useUi((s) => s.focusSessionId);
  const mode = useUi((s) => s.mode);
  const canGoBack = useUi((s) => s.back.length > 0);
  const recentCommands = useUi((s) => s.recentCommands);
  const theme = useUi((s) => s.theme);
  const reduceMotion = useUi((s) => s.reduceMotion);
  const notifyOs = useUi((s) => s.notifyOs);
  const showAllEvents = useTimeline((s) => s.showAll);
  // Actions only: read at call time so typing elsewhere never re-renders the palette.
  const ui = useUi.getState();
  const sessions = useSessions().data ?? NONE;
  const models = useModels().data?.models ?? [];
  const methods = useMethods();
  const needsYou = useHomeSelect((s) => s.totals.needsYou) ?? 0;
  const tree = useSessionTree(mode === 'session' ? focusSessionId : null).data;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const page = pages[pages.length - 1] ?? null;
  const resolvedTheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

  // Message search (session.search), debounced off the typing: the palette never waits on it.
  const [searchTerm, setSearchTerm] = useState(() => messageQuery(query));
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onQuery = (v: string) => {
    ui.setPaletteQuery(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearchTerm(messageQuery(v)), 180);
  };
  const hits = useQuery({
    queryKey: ['session.search', searchTerm],
    queryFn: () => rt.callOr('session.search', { query: searchTerm, limit: 8 }, { items: [] }).then((r) => r.items),
    enabled: searchTerm.length >= 2 && !page,
    staleTime: 15_000,
  });
  const messageHits = searchTerm.length >= 2 && !page ? (hits.data ?? NONE) : NONE;

  const close = () => ui.closePalette();
  const runItem = (item: PaletteItem) => {
    if (!item.nested) {
      ui.rememberCommand(item.id);
      close();
    }
    item.run();
  };

  const focused = mode === 'session' ? (sessions.find((s) => s.id === focusSessionId) ?? null) : null;
  const self = treeRelations(tree, focused?.id).self;
  const prefix = query.startsWith('>') ? '>' : query.startsWith('#') ? '#' : query.startsWith('?') ? '?' : '';
  const search = prefix ? query.slice(1).trimStart() : query;

  const suggest: PaletteItem[] = [];
  if (needsYou > 0) {
    suggest.push({
      id: 'attention.next',
      label: '次の出番へ',
      hint: `${needsYou}`,
      icon: I(Hand),
      keywords: ['next attention tsugi deban'],
      shortcut: 'nextAttention',
      run: () => goToAttention(rt),
    });
  }
  if (focused && self) {
    const s = focused;
    const moving = self.state === 'working' || self.state === 'supervising' || self.state === 'queued' || self.state === 'needs_you';
    if (self.state === 'stopped') {
      suggest.push({ id: 'session.resume', label: '再開', hint: sessionTitle(s), icon: I(Play), keywords: ['resume saikai'], run: () => void resumeTree(rt, s.id) });
    } else if (moving) {
      suggest.push({ id: 'session.stop', label: '止める', hint: sessionTitle(s), icon: I(Square), keywords: ['stop tomeru teishi'], shortcut: 'stopRun', run: () => void stopTree(rt, s.id) });
    }
    suggest.push(
      self.role === 'supervisor'
        ? { id: 'session.undelegate', label: '任せるのをやめる', hint: sessionTitle(s), icon: I(Diamond), keywords: ['undelegate makaseru yameru'], run: () => void undelegateSession(rt, s.id) }
        : { id: 'session.delegate', label: '任せる', hint: sessionTitle(s), icon: I(Diamond), keywords: ['delegate makaseru orchestrate'], run: () => void delegateSession(rt, s.id) },
    );
  }
  if (canGoBack) {
    suggest.push({ id: 'nav.back', label: '戻る', icon: I(History), keywords: ['back modoru'], shortcut: 'back', run: () => ui.goBack() });
  }

  const navigate: PaletteItem[] = [
    { id: 'mode.home', label: 'ホーム', icon: I(House), keywords: ['home hoomu'], shortcut: 'modeHome', run: () => ui.goHome() },
    { id: 'mode.timeline', label: 'タイムライン', icon: I(Rows3), keywords: ['timeline taimurain events log'], shortcut: 'modeTimeline', run: () => ui.openTimeline() },
  ];

  const create: PaletteItem[] = [
    { id: 'create.chat', label: '新しい会話', icon: I(MessageSquarePlus), keywords: ['new chat atarashii kaiwa'], shortcut: 'newChat', run: () => newChat(rt) },
    { id: 'project.add', label: 'プロジェクトを追加…', icon: I(FolderPlus), keywords: ['project add purojekuto tsuika folder git'], run: () => ui.setProjectDialog({ kind: 'new' }) },
    { id: 'demo.start', label: 'デモを始める', icon: I(Play), keywords: ['demo hajimeru try mock'], run: () => void startDemo(rt, methods) },
  ];

  const view: PaletteItem[] = [
    { id: 'view.sidebar', label: 'サイドバーを切替', icon: I(PanelLeft), keywords: ['sidebar saidobaa toggle'], shortcut: 'toggleSidebar', run: () => ui.toggleSidebar() },
    { id: 'view.panel', label: '成果物を切替', icon: I(PanelRight), keywords: ['outputs seikabutsu panel'], shortcut: 'togglePanel', run: () => ui.togglePanel() },
    {
      id: 'view.themeToggle',
      label: resolvedTheme === 'dark' ? 'ライトテーマ' : 'ダークテーマ',
      icon: resolvedTheme === 'dark' ? I(Sun) : I(Moon),
      keywords: ['theme teema toggle dark light raito daaku kirikae'],
      run: () => ui.setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
    },
    { id: 'view.theme', label: 'テーマを選択', icon: I(Moon), keywords: ['theme teema dark light system'], nested: true, run: () => ui.pushPalettePage('theme') },
    {
      id: 'view.motion',
      label: reduceMotion === 'on' ? '動きを減らす: オン' : '動きを減らす',
      icon: I(Wand2),
      keywords: ['reduce motion ugoki animation'],
      run: () => ui.setReduceMotion(reduceMotion === 'on' ? 'system' : 'on'),
    },
    { id: 'view.settings', label: '設定', icon: I(Settings), keywords: ['settings settei preferences litellm model'], shortcut: 'settings', run: () => ui.setSettingsOpen(true) },
    {
      id: 'view.notify',
      label: notifyOs ? 'OS の通知をオフ' : 'OS の通知をオン',
      icon: notifyOs ? I(BellOff) : I(Bell),
      keywords: ['notification tsuuchi notify os'],
      run: () => ui.setNotify({ os: !notifyOs }),
    },
    {
      id: 'view.timelineDetail',
      label: showAllEvents ? 'タイムライン: 詳細を隠す' : 'タイムライン: 詳細も表示',
      icon: I(Rows3),
      keywords: ['timeline taimurain detail shousai events all'],
      run: () => {
        useTimeline.getState().setShowAll(!showAllEvents);
        ui.openTimeline();
      },
    },
    { id: 'view.shortcuts', label: 'ショートカット一覧', icon: I(Keyboard), keywords: ['shortcuts keyboard help shootokatto'], shortcut: 'help', run: () => ui.setShortcutsOpen(true) },
  ];
  if (focused) {
    const s = focused;
    view.push(
      { id: 'session.model', label: 'モデルを変更', hint: sessionTitle(s), icon: I(Cpu), keywords: ['model moderu change'], shortcut: 'modelPicker', nested: true, run: () => ui.pushPalettePage('model') },
      { id: 'session.pin', label: s.pinned ? 'ピン留めを外す' : 'ピン留め', hint: sessionTitle(s), icon: I(Pin), keywords: ['pin pindome'], run: () => void setPinned(rt, s, !s.pinned) },
      { id: 'session.archive', label: 'アーカイブ', hint: sessionTitle(s), icon: I(Archive), keywords: ['archive aakaibu hide'], shortcut: 'archive', run: () => void archiveSession(rt, s) },
    );
  }

  // Conversations; a child is named with its parent (the tree says where it is).
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const sessionItems: PaletteItem[] = sessions
    .filter((s) => !s.archivedAt)
    .slice(0, 80)
    .map((s) => {
      const parent = s.parentSessionId ? byId.get(s.parentSessionId) : undefined;
      return {
        id: `session:${s.id}`,
        label: sessionTitle(s),
        hint: parent ? sessionTitle(parent) : undefined,
        icon: <StateIcon state={s.state} size={13} />,
        keywords: [parent ? sessionTitle(parent) : '', s.model ?? ''],
        run: () => ui.openSession(s.id),
      };
    });

  const allCommands = [...suggest, ...navigate, ...create, ...view];
  const recent = recentCommands
    .map((id) => allCommands.find((c) => c.id === id))
    .filter((c): c is PaletteItem => !!c && !suggest.includes(c))
    .slice(0, 3);

  let body: ReactNode;
  if (page === 'theme') {
    const items: PaletteItem[] = (
      [
        ['dark', 'ダーク'],
        ['light', 'ライト'],
        ['system', 'システムに合わせる'],
      ] as const
    ).map(([v, label]) => ({
      id: `theme:${v}`,
      label,
      icon: theme === v ? <Check size={15} className="text-accent" /> : I(Moon),
      keywords: [v],
      run: () => ui.setTheme(v),
    }));
    body = <Group heading="テーマ" items={items} onRun={runItem} />;
  } else if (page === 'model' && focused) {
    const items: PaletteItem[] = models.map((m) => ({
      id: `model:${m.id}`,
      label: m.label ?? m.id,
      hint: [m.provider, relativeCost(m.id)].filter(Boolean).join(' · '),
      icon: m.id === focused.model ? <Check size={15} className="text-accent" /> : I(Cpu),
      keywords: [m.id, m.provider ?? ''],
      run: () => void setSessionModel(rt, focused, m.id),
    }));
    body = items.length ? <Group heading="モデル" items={items} onRun={runItem} /> : null;
  } else if (prefix === '?') {
    body = <Group heading="ヘルプ" items={view.filter((v) => v.id === 'view.shortcuts' || v.id === 'view.settings')} onRun={runItem} />;
  } else if (prefix === '#') {
    body = (
      <>
        <Group heading="会話" items={sessionItems} onRun={runItem} />
        <MessageHits hits={messageHits} terms={searchTerm} onOpen={(h) => { close(); ui.openMessage(h.sessionId, h.messageId); }} />
      </>
    );
  } else if (!search) {
    body = (
      <>
        <Group heading="提案" items={suggest} onRun={runItem} />
        <Group heading="最近" items={recent} onRun={runItem} />
        <Group heading="移動" items={[...navigate, ...(prefix === '>' ? [] : sessionItems.slice(0, 5))]} onRun={runItem} />
        <Group heading="作成" items={create} onRun={runItem} />
        <Group heading="表示・設定" items={view} onRun={runItem} />
      </>
    );
  } else {
    body = (
      <>
        <Group heading="コマンド" items={[...suggest, ...navigate, ...create, ...view]} onRun={runItem} />
        {prefix !== '>' && <Group heading="会話" items={sessionItems} onRun={runItem} />}
        {prefix !== '>' && (
          <MessageHits hits={messageHits} terms={searchTerm} onOpen={(h) => { close(); ui.openMessage(h.sessionId, h.messageId); }} />
        )}
      </>
    );
  }

  const askText = search.trim();

  return (
    <div
      className="fixed inset-0 z-[70]"
      style={{ pointerEvents: open ? 'auto' : 'none' }}
      aria-hidden={!open}
      inert={!open}
    >
      <div
        className="absolute inset-0 bg-overlay transition-opacity duration-[100ms] data-[state=open]:animate-[acc-fade-in_140ms_var(--ease-out)]"
        data-state={open ? 'open' : 'closed'}
        style={{ opacity: open ? 1 : 0 }}
        onClick={close}
      />
      <div
        role={open ? 'dialog' : undefined}
        aria-modal={open ? true : undefined}
        aria-label="コマンドパレット"
        data-state={open ? 'open' : 'closed'}
        data-palette
        // Mounted open: the entrance is a keyframe; the exit is the data-state transition,
        // and its end unmounts the contents (instantly if motion is reduced).
        onTransitionEnd={(e) => {
          if (!open && e.target === e.currentTarget) onClosed();
        }}
        ref={(el) => {
          if (el && !open && getComputedStyle(el).transitionDuration.split(',').every((d) => parseFloat(d) === 0)) onClosed();
        }}
        className="acc-modal absolute top-[18vh] left-1/2 w-[640px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-lg border border-line-strong bg-raised shadow-modal data-[state=open]:animate-[acc-dialog-in_140ms_var(--ease-out)]"
      >
        <Command
          loop
          // The prefix (`#` conversations, `>` commands, `?` help) chooses what to search; it
          // is not part of what is matched.
          filter={(value, search, keywords) => defaultFilter(value, search.replace(/^[#>?]\s*/, ''), keywords)}
          label="コマンドパレット"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              if (pages.length > 0) ui.popPalettePage();
              else close();
            } else if (e.key === 'Backspace' && query === '' && pages.length > 0) {
              e.preventDefault();
              ui.popPalettePage();
            } else if (e.key === 'Tab') {
              // aria-modal: focus stays here (↑↓ move between items). Tab would otherwise walk
              // into the app behind the overlay, where Enter / Space act unseen.
              e.preventDefault();
              inputRef.current?.focus();
            }
          }}
        >
          <div className="flex h-12 items-center gap-2 border-b border-line-subtle px-4">
            {page && (
              <span className="rounded-xs bg-selected px-1.5 text-micro text-fg-2">
                {page === 'theme' ? 'テーマ' : 'モデル'}
              </span>
            )}
            <Command.Input
              ref={inputRef}
              value={query}
              onValueChange={onQuery}
              placeholder={page ? '絞り込み' : '会話・メッセージ・コマンドを検索'}
              className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-fg placeholder:text-fg-4"
            />
            {hits.isFetching && searchTerm.length >= 2 && (
              <LoaderCircle size={14} strokeWidth={1.75} className="acc-spin shrink-0 text-fg-3" aria-label="検索中" />
            )}
          </div>
          <Command.List className="max-h-[336px] overflow-y-auto scroll-py-1 p-1">
            <Command.Empty className="p-0" />
            {body}
            {askText && !page && prefix !== '?' && (
              <NoMatches text={askText} pending={hits.isFetching || searchTerm !== messageQuery(query)} hits={messageHits.length} />
            )}
            {askText && !page && prefix !== '?' && (
              <Command.Group forceMount heading="">
                <Command.Item
                  forceMount
                  value={`__ask__ ${askText}`}
                  onSelect={() => {
                    close();
                    void askAi(rt, askText);
                  }}
                  className={cn(
                    'group flex h-9 items-center gap-3 rounded-sm px-3 text-ui text-fg data-[selected=true]:bg-selected',
                  )}
                >
                  <Sparkles size={15} strokeWidth={1.5} className="text-accent" />
                  <span className="min-w-0 truncate">
                    AI に頼む：<span className="text-fg-2">「{askText}」</span>
                  </span>
                  <span className="flex-1" />
                  <CornerDownLeft size={13} strokeWidth={1.5} className="text-fg-4" />
                </Command.Item>
              </Command.Group>
            )}
          </Command.List>
          <div className="flex h-8 items-center gap-3 border-t border-line-subtle px-3 text-micro text-fg-3">
            <span className="flex items-center gap-1">
              <Kbd keys="ArrowUp" />
              <Kbd keys="ArrowDown" /> 移動
            </span>
            <span className="flex items-center gap-1">
              <Kbd keys="Enter" /> 実行
            </span>
            {pages.length > 0 && (
              <span className="flex items-center gap-1">
                <Kbd keys="Backspace" /> 戻る
              </span>
            )}
            <span className="flex items-center gap-1">
              <Kbd keys="Esc" /> 閉じる
            </span>
            <span className="flex-1" />
            {needsYou > 0 && (
              <span className="flex items-center gap-1 text-st-needs_you">
                <Hand size={12} strokeWidth={2} aria-hidden />
                {needsYou}
              </span>
            )}
          </div>
        </Command>
      </div>
    </div>
  );
}

// Focus the input when the palette opens and give focus back when it closes. A store
// subscription (not an effect): the palette is opened from many places outside React.
let restoreFocus: HTMLElement | null = null;
useUi.subscribe((s, prev) => {
  if (s.paletteOpen && !prev.paletteOpen) {
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-palette] input')?.focus());
  } else if (!s.paletteOpen && prev.paletteOpen) {
    const el = restoreFocus;
    restoreFocus = null;
    if (el?.isConnected) el.focus({ preventScroll: true });
  }
});
