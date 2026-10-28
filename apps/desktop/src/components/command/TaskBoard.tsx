import type { Project, Task } from '@acc/protocol';
import { ChevronDown, ChevronRight, CornerUpLeft, ListTodo, Network, Play, X } from 'lucide-react';
import { memo, useMemo, useRef, useState } from 'react';
import { confirmCancelTask, newChat } from '../../app/commands';
import { reworkTask, spawnWorker } from '../../daemon/orchestration';
import { useMethods, useProjects } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { useWindowKeydown } from '../../hooks/useWindowKeydown';
import { cn } from '../../lib/cn';
import { overlayOpen } from '../../lib/overlay';
import { isTypingTarget, matchShortcut } from '../../lib/shortcuts';
import {
  type BoardTask,
  type TaskGroup,
  buildBoardSections,
  canCancel,
  canRework,
  canRun,
  statusReasonText,
  taskDisplay,
  workerLabel,
} from '../../model/tasks';
import { useUi } from '../../store/ui';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '../ui/Menu';
import { DiffStatText } from '../panel/DiffViewer';
import { Button } from '../ui/Button';
import { Kbd } from '../ui/Kbd';
import { TimeStamp } from '../ui/Meta';
import { StatusIcon } from '../ui/StatusIcon';
import { Tooltip } from '../ui/Tooltip';
import { useTaskGroups } from './TaskTree';

const NONE: never[] = [];

function goalLabel(g: TaskGroup): string {
  return g.orchestrator ? g.goal : 'あなたが作成した Task';
}

/** The task board's goal filter: every goal, or one plan. */
function GoalPicker({ groups, goal }: { groups: TaskGroup[]; goal: string | null }) {
  const setGoal = useUi((s) => s.setTaskGoal);
  const current = groups.find((g) => g.id === goal) ?? null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-7 max-w-80 min-w-0 items-center gap-1 rounded-sm border px-2 text-ui',
            current ? 'border-line-strong bg-selected text-fg' : 'border-line-subtle text-fg-2 hover:border-line hover:text-fg',
          )}
        >
          <span className="shrink-0 text-fg-3">目標:</span>
          <span className="truncate">{current ? goalLabel(current) : 'すべて'}</span>
          <ChevronDown size={12} strokeWidth={1.75} className="shrink-0 text-fg-4" />
        </button>
      </MenuTrigger>
      <MenuContent className="max-w-[420px] min-w-64">
        <MenuLabel>目標で絞り込む</MenuLabel>
        <MenuItem checked={!goal} onSelect={() => setGoal(null)}>
          すべての目標
        </MenuItem>
        {groups.length > 0 && <MenuSeparator />}
        {groups.map((g) => (
          <MenuItem key={g.id} checked={g.id === goal} onSelect={() => setGoal(g.id)}>
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{goalLabel(g)}</span>
              <span className="shrink-0 text-meta text-fg-3 tabular">
                {g.counts.done}/{g.counts.total}
              </span>
            </span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

/** Inline "what should the worker fix" box under a task row (Ctrl+Enter sends, Esc closes). */
export function FeedbackBox({ task, onClose }: { task: Task; onClose: () => void }) {
  const rt = useRuntime();
  const methods = useMethods();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const openSession = useUi((s) => s.openSession);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const r = await reworkTask(rt, task, text, methods);
    setBusy(false);
    if (!r) return;
    onClose();
    if (r.sessionId) openSession(r.sessionId, { from: 'command' });
  };
  return (
    <div className="mx-3 mt-1 mb-2 flex flex-col gap-2 rounded-md border border-line bg-surface p-2.5" data-testid="feedback-box">
      <div className="flex items-center gap-1.5 text-meta text-fg-3">
        <CornerUpLeft size={12} strokeWidth={1.75} />
        Worker に差し戻す · 同じ worktree で、この指示を足して作業を続けます
      </div>
      <textarea
        autoFocus
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="差し戻しの指示"
        placeholder="何を直してほしいかを書いてください（例: 境界値のテストが足りません。期限ちょうどのケースを追加して）"
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else if (matchShortcut(e, 'submitFeedback')) {
            e.preventDefault();
            void submit();
          }
        }}
        className="w-full resize-none rounded-sm border border-line bg-canvas px-2.5 py-2 text-ui text-fg placeholder:text-fg-4 focus:border-[var(--focus-ring)]"
      />
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} shortcutKeys="Esc">
          キャンセル
        </Button>
        <Button variant="primary" size="sm" shortcut="submitFeedback" disabled={!text.trim() || busy} onClick={() => void submit()}>
          {busy ? '差し戻しています…' : '差し戻す'}
        </Button>
      </div>
    </div>
  );
}

const TaskRow = memo(function TaskRow({
  node,
  selected,
  showGoal,
  project,
  feedbackOpen,
  onFeedback,
}: {
  node: BoardTask;
  selected: boolean;
  showGoal: boolean;
  project: Project | null;
  feedbackOpen: boolean;
  onFeedback: (taskId: string | null) => void;
}) {
  const rt = useRuntime();
  const connected = useConnectionState() === 'open';
  const select = useUi((s) => s.select);
  const setPanelOpen = useUi((s) => s.setPanelOpen);
  const openSession = useUi((s) => s.openSession);
  const t = node.task;
  const { state, label } = taskDisplay(node);
  const worker = workerLabel(node);
  const reason = statusReasonText(t);
  const run = canRun(t) && !node.workerRun?.status.match(/^(running|queued|awaiting_approval)$/);
  const rework = canRework(node);
  const choose = () => {
    select(t.id);
    setPanelOpen('command', true);
  };
  return (
    <div>
      <div
        role="option"
        aria-selected={selected}
        aria-label={`${t.title} · ${label}`}
        tabIndex={selected ? 0 : -1}
        data-board-task={t.id}
        onClick={choose}
        onDoubleClick={() => node.worker && openSession(node.worker.id, { from: 'command' })}
        className={cn(
          'group relative flex h-9 cursor-default items-center gap-2.5 rounded-sm pr-2 pl-3 outline-none',
          'focus-visible:shadow-[inset_0_0_0_1px_var(--focus-ring)]',
          selected ? 'bg-selected' : 'hover:bg-hover',
        )}
      >
        {selected && <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-accent" />}
        <StatusIcon state={state} size={13} />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-ui text-fg">{t.title}</span>
          {node.waitsFor.length > 0 && (
            <Tooltip content={`先に終わる必要がある Task: ${node.waitsFor.map((d) => d.title).join('、')}`}>
              <span className="hidden min-w-0 shrink truncate text-meta text-fg-4 @[640px]:inline">
                ← {node.waitsFor.map((d) => d.title).join('、')}
              </span>
            </Tooltip>
          )}
          {reason && t.status !== 'review' && (
            <span className="hidden min-w-0 shrink truncate text-meta text-fg-3 @[640px]:inline">{reason}</span>
          )}
        </span>
        {showGoal && (
          <span className="hidden w-52 shrink-0 truncate text-meta text-fg-3 @[900px]:block">
            {project ? `${project.name} · ` : ''}
            {goalLabel(node.group)}
          </span>
        )}
        <span className="hidden w-36 shrink-0 truncate text-meta text-fg-2 @[720px]:block">
          {worker ? `Worker · ${worker}` : <span className="text-fg-4">未割り当て</span>}
        </span>
        <span className="w-16 shrink-0 text-right">
          {node.diff && node.diff.files > 0 ? (
            <DiffStatText additions={node.diff.additions} deletions={node.diff.deletions} />
          ) : (
            <span className="text-meta text-fg-4">—</span>
          )}
        </span>
        <span className="w-14 shrink-0 text-right">
          <TimeStamp iso={t.updatedAt} className="text-meta text-fg-3" />
        </span>
        {/* Actions float over the row's right edge on hover / selection (no reserved column). */}
        <span
          className={cn(
            'absolute inset-y-0 right-0 items-center gap-1.5 rounded-r-sm pr-1.5 pl-10',
            // Same surface as the row (canvas + its hover/selected tint), fading in from the left.
            '[mask-image:linear-gradient(to_right,transparent,black_32px)]',
            selected ? 'flex' : 'hidden group-hover:flex',
          )}
          style={{
            background: `linear-gradient(var(${selected ? '--bg-selected' : '--bg-hover'}), var(${selected ? '--bg-selected' : '--bg-hover'})), var(--bg-canvas)`,
          }}
        >
          {run && (
            <Button
              size="sm"
              variant={t.status === 'ready' ? 'primary' : 'secondary'}
              icon={<Play size={10} strokeWidth={2} fill="currentColor" />}
              shortcut={selected ? 'runTask' : undefined}
              disabled={!connected}
              onClick={(e) => {
                e.stopPropagation();
                void spawnWorker(rt, t).then((r) => r && openSession(r.sessionId, { from: 'command' }));
              }}
            >
              {t.status === 'failed' ? 'もう一度実行' : 'このTaskを実行'}
            </Button>
          )}
          {rework && (
            <Button
              size="sm"
              icon={<CornerUpLeft size={11} strokeWidth={1.75} />}
              shortcut={selected ? 'reworkTask' : undefined}
              disabled={!connected}
              onClick={(e) => {
                e.stopPropagation();
                select(t.id);
                onFeedback(t.id);
              }}
            >
              Worker に差し戻す
            </Button>
          )}
          {canCancel(t) && (
            <Tooltip
              content={
                <span className="inline-flex items-center gap-2">
                  Task を中止 <Kbd id="cancelTask" />
                </span>
              }
            >
              <button
                type="button"
                aria-label="Task を中止"
                disabled={!connected}
                onClick={(e) => {
                  e.stopPropagation();
                  confirmCancelTask(rt, t);
                }}
                className="flex size-6 items-center justify-center rounded-sm text-fg-3 hover:bg-hover hover:text-st-failed disabled:text-fg-4"
              >
                <X size={13} strokeWidth={1.75} />
              </button>
            </Tooltip>
          )}
        </span>
      </div>
      {feedbackOpen && <FeedbackBox task={node.task} onClose={() => onFeedback(null)} />}
    </div>
  );
});

function EmptyTasks({ filtered }: { filtered: boolean }) {
  const rt = useRuntime();
  const setGoal = useUi((s) => s.setTaskGoal);
  if (filtered) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center">
        <div className="text-title text-fg-2">この目標の Task はありません</div>
        <button type="button" className="text-ui text-accent hover:underline" onClick={() => setGoal(null)}>
          すべての目標を表示
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center">
      <ListTodo size={20} strokeWidth={1.5} className="text-fg-3" />
      <div className="text-title text-fg-2">Task はまだありません</div>
      <div className="max-w-[420px] text-ui text-fg-3">
        Orchestrator に目標を伝えると、Task に分けてここに並べます。Worker 未起動の Task もここから実行できます。
      </div>
      <Button
        className="mt-2"
        icon={<Network size={13} strokeWidth={1.75} />}
        onClick={() =>
          void newChat(rt).then((s) => {
            if (s) useUi.getState().setGrantDialog(s.id);
          })
        }
      >
        Orchestrator に依頼…
      </Button>
    </div>
  );
}

/**
 * Command Mode → Task: every task of the project (or one goal) by status, including tasks
 * no worker has picked up yet. Each row can start a worker, send a reviewed result back
 * with feedback, or be cancelled — by mouse or keyboard (j/k, R, F, Ctrl+Shift+Backspace).
 */
export function TaskBoard() {
  const rt = useRuntime();
  const groups = useTaskGroups();
  const goal = useUi((s) => s.taskGoal);
  const selectedId = useUi((s) => s.selectedId);
  const select = useUi((s) => s.select);
  const collapsed = useUi((s) => s.collapsed);
  const toggleCollapsed = useUi((s) => s.toggleCollapsed);
  const togglePanel = useUi((s) => s.togglePanel);
  const setPanelOpen = useUi((s) => s.setPanelOpen);
  const openSession = useUi((s) => s.openSession);
  const projectId = useUi((s) => s.projectId);
  const projects = useProjects().data ?? NONE;
  const connected = useConnectionState() === 'open';
  const [feedbackFor, setFeedbackFor] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // A goal that no longer exists (other project, archived) falls back to "all".
  const goalShown = goal && groups.some((g) => g.id === goal) ? goal : null;
  const sections = useMemo(() => buildBoardSections(groups, goalShown), [groups, goalShown]);
  const isCollapsed = (s: { status: string; collapsedByDefault: boolean }) =>
    collapsed[`tasks.section.${s.status}`] ?? s.collapsedByDefault;
  const visible = sections.flatMap((s) => (isCollapsed(s) ? [] : s.tasks));
  const selected = visible.find((n) => n.task.id === selectedId) ?? null;
  const projectOf = (id: string) => (projectId ? null : (projects.find((p) => p.id === id) ?? null));
  const total = sections.reduce((n, s) => n + s.tasks.length, 0);

  const move = (to: number) => {
    const target = visible[Math.max(0, Math.min(visible.length - 1, to))];
    if (!target) return;
    select(target.task.id, true);
    const el = listRef.current?.querySelector<HTMLElement>(`[data-board-task="${CSS.escape(target.task.id)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  };

  useWindowKeydown((e) => {
    if (e.defaultPrevented || overlayOpen()) return;
    if (matchShortcut(e, 'cancelTask')) {
      // Global chord (works from inputs too, like stopping a run); asks before cancelling.
      if (!selected || !canCancel(selected.task) || !connected) return;
      e.preventDefault();
      confirmCancelTask(rt, selected.task);
      return;
    }
    if (isTypingTarget(e.target)) return;
    const idx = selected ? visible.indexOf(selected) : -1;
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
      if (e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      if (selected.worker) openSession(selected.worker.id, { from: 'command' });
      else setPanelOpen('command', true);
    } else if (matchShortcut(e, 'peek')) {
      if (e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      togglePanel('command');
    } else if (matchShortcut(e, 'runTask')) {
      const busy = selected.workerRun && ['running', 'queued', 'awaiting_approval'].includes(selected.workerRun.status);
      if (!canRun(selected.task) || busy || !connected) return;
      e.preventDefault();
      void spawnWorker(rt, selected.task).then((r) => r && openSession(r.sessionId, { from: 'command' }));
    } else if (matchShortcut(e, 'reworkTask')) {
      if (!canRework(selected) || !connected) return;
      e.preventDefault();
      setFeedbackFor(selected.task.id);
    }
  });

  const counts = sections.filter((s) => s.status !== 'cancelled').map((s) => `${s.label.replace(/（.*）/, '')} ${s.tasks.length}`);

  return (
    <div className="@container flex flex-col" data-testid="task-board">
      <div className="flex h-10 items-center gap-2 px-6">
        <GoalPicker groups={groups} goal={goalShown} />
        <span className="min-w-0 flex-1 truncate text-meta text-fg-3 tabular">{counts.join(' · ')}</span>
        <span className="hidden items-center gap-3 text-micro text-fg-4 @[720px]:flex">
          <span className="flex items-center gap-1">
            <Kbd id="runTask" /> 実行
          </span>
          <span className="flex items-center gap-1">
            <Kbd id="reworkTask" /> 差し戻す
          </span>
          <span className="flex items-center gap-1">
            <Kbd id="peek" /> 詳細
          </span>
        </span>
      </div>
      {total === 0 ? (
        <EmptyTasks filtered={!!goalShown} />
      ) : (
        <div ref={listRef} role="listbox" aria-label="Task" className="flex flex-col gap-3 px-3">
          {sections.map((s) => {
            const closed = isCollapsed(s);
            return (
              <section key={s.status} aria-label={s.label}>
                <button
                  type="button"
                  aria-expanded={!closed}
                  onClick={() => toggleCollapsed(`tasks.section.${s.status}`, s.collapsedByDefault)}
                  className="flex h-8 w-full items-center gap-2 px-3 text-left text-micro text-fg-3 hover:text-fg-2"
                >
                  <span className={s.status === 'review' || s.status === 'failed' ? 'text-fg' : undefined}>{s.label}</span>
                  <span className="tabular">{s.tasks.length}</span>
                  <ChevronRight
                    size={12}
                    strokeWidth={1.75}
                    className={cn('text-fg-4 transition-transform duration-[120ms]', !closed && 'rotate-90')}
                  />
                </button>
                {!closed &&
                  s.tasks.map((n) => (
                    <TaskRow
                      key={n.task.id}
                      node={n}
                      selected={n.task.id === selectedId}
                      showGoal={!goalShown}
                      project={projectOf(n.task.projectId)}
                      feedbackOpen={feedbackFor === n.task.id}
                      onFeedback={setFeedbackFor}
                    />
                  ))}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
