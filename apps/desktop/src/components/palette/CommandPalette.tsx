import type { Session } from '@acc/protocol';
import { Command } from 'cmdk';
import {
  ArrowRight,
  Check,
  ChevronRight,
  Cpu,
  CornerDownLeft,
  Folder,
  History,
  Keyboard,
  LayoutGrid,
  MessageSquarePlus,
  Moon,
  Network,
  PanelLeft,
  PanelRight,
  RotateCcw,
  Settings,
  Sparkles,
  Square,
  SquareActivity,
  Target,
  ThumbsDown,
  ThumbsUp,
  Wand2,
  Wrench,
} from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import {
  approve,
  askAi,
  goToAttention,
  newChat,
  reject,
  retry,
  stop,
  switchMode,
} from '../../app/commands';
import { qk } from '../../daemon/keys';
import { useModels, useProjects, useSessions } from '../../daemon/queries';
import { type AppRuntime, useRuntime } from '../../daemon/runtime';
import { patchIn } from '../../daemon/sync';
import { cn } from '../../lib/cn';
import { relativeCost } from '../../lib/models';
import type { ShortcutId } from '../../lib/shortcuts';
import { STATE_LABEL } from '../../lib/status';
import { attentionCounts, untitled } from '../../model/board';
import { useBoard } from '../../model/useBoard';
import { toastError } from '../../store/toast';
import { useUi } from '../../store/ui';
import { Kbd } from '../ui/Kbd';
import { StatusIcon } from '../ui/StatusIcon';

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

const I = (C: typeof Target) => <C size={15} strokeWidth={1.5} />;

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

function setSessionModel(rt: AppRuntime, session: Session, model: string) {
  patchIn<Session>(rt.queryClient, qk.sessions, session.id, (s) => ({ ...s, model }));
  rt.client.call('session.update', { sessionId: session.id, model }).catch((err: unknown) => toastError(err));
}

/**
 * Command palette (Ctrl+K, §7.1). Always mounted so it opens within 50ms; only its
 * visibility toggles. Fuzzy matching runs over Japanese labels, English names and romaji.
 */
export function CommandPalette() {
  const rt = useRuntime();
  const open = useUi((s) => s.paletteOpen);
  const query = useUi((s) => s.paletteQuery);
  const pages = useUi((s) => s.palettePages);
  const selectedId = useUi((s) => s.selectedId);
  const focusSessionId = useUi((s) => s.focusSessionId);
  const canGoBack = useUi((s) => s.back.length > 0);
  const recentCommands = useUi((s) => s.recentCommands);
  const projectId = useUi((s) => s.projectId);
  const theme = useUi((s) => s.theme);
  const reduceMotion = useUi((s) => s.reduceMotion);
  // Actions only: read at call time so typing elsewhere never re-renders the palette.
  const ui = useUi.getState();
  const sessions = useSessions().data ?? [];
  const projects = useProjects().data ?? [];
  const models = useModels().data?.models ?? [];
  const { items: board } = useBoard();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const page = pages[pages.length - 1] ?? null;

  const close = () => ui.closePalette();
  const runItem = (item: PaletteItem) => {
    if (!item.nested) {
      ui.rememberCommand(item.id);
      close();
    }
    item.run();
  };

  const selected = board.find((b) => b.id === selectedId) ?? null;
  const focused = sessions.find((s) => s.id === focusSessionId) ?? null;
  const counts = attentionCounts(board);
  const prefix = query.startsWith('>') ? '>' : query.startsWith('#') ? '#' : query.startsWith('?') ? '?' : '';
  const search = prefix ? query.slice(1).trimStart() : query;

  const suggest: PaletteItem[] = [];
  if (counts.total > 0) {
    suggest.push({
      id: 'attention.next',
      label: '次の要対応へ',
      hint: `${counts.total} 件`,
      icon: I(ArrowRight),
      keywords: ['next attention tsugi youtaiou'],
      shortcut: 'nextAttention',
      run: () => goToAttention(rt),
    });
  }
  if (selected?.approval) {
    const a = selected.approval;
    suggest.push(
      {
        id: 'approval.approve',
        label: '承認',
        hint: selected.title,
        icon: I(ThumbsUp),
        keywords: ['approve shounin yes'],
        shortcut: 'approve',
        run: () => void approve(rt, a),
      },
      {
        id: 'approval.reject',
        label: '拒否',
        hint: selected.title,
        icon: I(ThumbsDown),
        keywords: ['reject kyohi no deny'],
        shortcut: 'reject',
        run: () => void reject(rt, a),
      },
    );
  }
  if (selected?.run && (selected.state === 'failed' || selected.state === 'interrupted')) {
    const r = selected.run;
    suggest.push({ id: 'run.retry', label: '再試行', hint: selected.title, icon: I(RotateCcw), keywords: ['retry saishikou'], shortcut: 'retry', run: () => void retry(rt, r) });
  }
  const liveRun = selected?.run && (selected.state === 'running' || selected.state === 'queued') ? selected.run : null;
  if (liveRun) {
    suggest.push({ id: 'run.stop', label: '停止', hint: selected?.title, icon: I(Square), keywords: ['stop teishi cancel'], shortcut: 'stopRun', run: () => void stop(rt, liveRun) });
  }
  if (canGoBack) {
    suggest.push({ id: 'nav.back', label: '直前の画面に戻る', icon: I(History), keywords: ['back modoru'], shortcut: 'back', run: () => ui.goBack() });
  }

  const navigate: PaletteItem[] = [
    { id: 'mode.command', label: '司令室', hint: 'モード', icon: I(LayoutGrid), keywords: ['command shireishitsu mode board'], shortcut: 'modeCommand', run: () => switchMode(rt, 'command') },
    { id: 'mode.focus', label: 'フォーカス', hint: 'モード', icon: I(Target), keywords: ['focus fookasu mode chat'], shortcut: 'modeFocus', run: () => switchMode(rt, 'focus') },
    { id: 'mode.timeline', label: 'タイムライン', hint: 'モード', icon: I(SquareActivity), keywords: ['timeline taimurain events log'], shortcut: 'modeTimeline', run: () => switchMode(rt, 'timeline') },
    { id: 'project.switch', label: 'プロジェクトを切替', icon: I(Folder), keywords: ['project purojekuto switch'], nested: true, run: () => ui.pushPalettePage('project') },
  ];

  const create: PaletteItem[] = [
    { id: 'create.chat', label: '新しいチャット', icon: I(MessageSquarePlus), keywords: ['new chat atarashii chatto'], shortcut: 'newChat', run: () => void newChat(rt) },
    { id: 'create.agent', label: '新しいエージェントタスク', icon: I(Wrench), keywords: ['new agent task eejento worker'], shortcut: 'newAgentTask', run: () => void newChat(rt, { kind: 'agent' }) },
    {
      id: 'create.orchestrate',
      label: 'Orchestrator に依頼…',
      icon: I(Network),
      keywords: ['orchestrator orchestrate irai bunntan'],
      run: () => {
        void newChat(rt).then((s) => {
          if (s) useUi.getState().setDraft(s.id, 'Orchestrator として、次の目標を Task に分けて Worker に任せてください：\n');
        });
      },
    },
  ];

  const view: PaletteItem[] = [
    { id: 'view.sidebar', label: 'サイドバーを切替', icon: I(PanelLeft), keywords: ['sidebar saidobaa toggle'], shortcut: 'toggleSidebar', run: () => ui.toggleSidebar() },
    { id: 'view.panel', label: '詳細パネルを切替', icon: I(PanelRight), keywords: ['panel detail shousai'], shortcut: 'togglePanel', run: () => ui.togglePanel() },
    { id: 'view.theme', label: 'テーマを切替', icon: I(Moon), keywords: ['theme teema dark light'], nested: true, run: () => ui.pushPalettePage('theme') },
    {
      id: 'view.motion',
      label: reduceMotion === 'on' ? '動きを減らす: オン' : '動きを減らす',
      icon: I(Wand2),
      keywords: ['reduce motion ugoki animation'],
      run: () => ui.setReduceMotion(reduceMotion === 'on' ? 'system' : 'on'),
    },
    { id: 'view.settings', label: '設定を開く', icon: I(Settings), keywords: ['settings settei preferences'], shortcut: 'settings', run: () => ui.setSettingsOpen(true) },
    { id: 'view.shortcuts', label: 'ショートカット一覧', icon: I(Keyboard), keywords: ['shortcuts keyboard help shootokatto'], shortcut: 'help', run: () => ui.setShortcutsOpen(true) },
  ];
  if (focused) {
    view.push({ id: 'session.model', label: 'モデルを変更', hint: untitled(focused), icon: I(Cpu), keywords: ['model moderu change'], shortcut: 'modelPicker', nested: true, run: () => ui.pushPalettePage('model') });
  }

  const boardById = new Map(board.map((b) => [b.id, b]));
  const sessionItems: PaletteItem[] = sessions.slice(0, 60).map((s) => {
    const b = boardById.get(s.id);
    return {
      id: `session:${s.id}`,
      label: untitled(s),
      hint: b ? STATE_LABEL[b.state] : undefined,
      icon: b ? <StatusIcon state={b.state} size={13} /> : I(Target),
      keywords: [s.kind, s.model ?? ''],
      run: () => ui.openSession(s.id),
    };
  });

  const allCommands = [...suggest, ...navigate, ...create, ...view];
  const recent = recentCommands
    .map((id) => allCommands.find((c) => c.id === id))
    .filter((c): c is PaletteItem => !!c && !suggest.includes(c))
    .slice(0, 3);

  let body: ReactNode;
  if (page === 'project') {
    const items: PaletteItem[] = [
      { id: 'project:all', label: 'すべてのプロジェクト', icon: projectId ? I(Folder) : <Check size={15} className="text-accent" />, keywords: ['all subete'], run: () => ui.setProject(null) },
      ...projects.map((p) => ({
        id: `project:${p.id}`,
        label: p.name,
        hint: p.repoPath ?? undefined,
        icon: p.id === projectId ? <Check size={15} className="text-accent" /> : I(Folder),
        keywords: [p.name],
        run: () => ui.setProject(p.id),
      })),
    ];
    body = <Group heading="プロジェクトを切替" items={items} onRun={runItem} />;
  } else if (page === 'theme') {
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
      run: () => setSessionModel(rt, focused, m.id),
    }));
    body = items.length ? <Group heading="モデル" items={items} onRun={runItem} /> : null;
  } else if (prefix === '?') {
    body = <Group heading="ヘルプ" items={view.filter((v) => v.id === 'view.shortcuts' || v.id === 'view.settings')} onRun={runItem} />;
  } else if (prefix === '#') {
    body = <Group heading="セッション" items={sessionItems} onRun={runItem} />;
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
        {prefix !== '>' && <Group heading="セッション" items={sessionItems} onRun={runItem} />}
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
        className="absolute inset-0 bg-overlay transition-opacity duration-[100ms]"
        style={{ opacity: open ? 1 : 0 }}
        onClick={close}
      />
      <div
        role={open ? 'dialog' : undefined}
        aria-modal={open ? true : undefined}
        aria-label="コマンドパレット"
        data-state={open ? 'open' : 'closed'}
        data-palette
        className="acc-modal absolute top-[18vh] left-1/2 w-[640px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-lg border border-line-strong bg-raised shadow-modal"
      >
        <Command
          loop
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
            }
          }}
        >
          <div className="flex h-12 items-center gap-2 border-b border-line-subtle px-4">
            {page && (
              <span className="rounded-xs bg-selected px-1.5 text-micro text-fg-2">
                {page === 'project' ? 'プロジェクト' : page === 'theme' ? 'テーマ' : 'モデル'}
              </span>
            )}
            <Command.Input
              ref={inputRef}
              value={query}
              onValueChange={ui.setPaletteQuery}
              placeholder={page ? '絞り込み…' : 'コマンド、セッションを検索…  （> コマンド  # セッション  ? ヘルプ）'}
              className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-fg placeholder:text-fg-4"
            />
          </div>
          <Command.List className="max-h-[336px] overflow-y-auto scroll-py-1 p-1">
            <Command.Empty className="p-0" />
            {body}
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
          <div className="flex h-8 items-center gap-3 border-t border-line-subtle px-3 text-micro text-fg-4">
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
            {counts.total > 0 && <span>要対応 {counts.total}</span>}
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
