import { ArrowRight, MoreHorizontal } from 'lucide-react';
import { motion } from 'motion/react';
import { type ReactNode, memo } from 'react';
import { useStore } from 'zustand';
import { retry, stop } from '../../app/commands';
import { archiveSession } from '../../daemon/actions';
import { useResolvedApprovals } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { cn } from '../../lib/cn';
import { STATE_LABEL } from '../../lib/status';
import { shortModel } from '../../lib/models';
import { headLines } from '../../lib/tools';
import { describeApproval } from '../../model/approval';
import { type BoardItem, elapsedRange } from '../../model/board';
import { useUi } from '../../store/ui';
import { ResolvedLine, RiskNote, useApprovalControls } from '../approval/ApprovalControls';
import { Button } from '../ui/Button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu';
import { Cost, ElapsedTime, Monogram } from '../ui/Meta';
import { StatusIcon, StatusLabel, stateColor } from '../ui/StatusIcon';
import { Tooltip } from '../ui/Tooltip';
import { ActivityLine } from './ActivityLine';

export const LAYOUT_SPRING = { type: 'spring', stiffness: 500, damping: 40, mass: 1 } as const;

export function fallbackActivity(item: BoardItem): string | null {
  switch (item.state) {
    case 'running':
      if (item.run?.kind === 'orchestrator') return 'Worker の完了を待機中';
      if (item.run?.kind === 'chat') return '回答を生成中';
      return '作業中';
    case 'queued':
      return '同時実行の空きを待っています';
    case 'awaiting_approval':
      return '承認を待っています';
    case 'completed':
      return item.task?.resultSummary ?? '完了しました';
    case 'cancelled':
      return item.run?.statusReason ? `停止されました（${item.run.statusReason}）` : '停止されました';
    case 'idle':
      return item.session?.kind === 'agent' ? 'まだ作業を始めていません' : 'まだメッセージはありません';
    default:
      return null;
  }
}

function RoleTitle({ item, className }: { item: BoardItem; className?: string }) {
  return (
    <span className={cn('min-w-0 truncate text-ui', className)}>
      <span className="text-fg-3">{item.role}</span>
      <span className="px-1 text-fg-4">·</span>
      <span className="font-medium text-fg">{item.title}</span>
    </span>
  );
}

function RowMenu({ item }: { item: BoardItem }) {
  const rt = useRuntime();
  const openSession = useUi((s) => s.openSession);
  const run = item.run;
  const live = item.state === 'running' || item.state === 'awaiting_approval' || item.state === 'queued';
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label="操作"
          onClick={(e) => e.stopPropagation()}
          className="flex size-6 items-center justify-center rounded-sm text-fg-3 opacity-0 group-hover:opacity-100 hover:bg-selected hover:text-fg data-[state=open]:opacity-100"
        >
          <MoreHorizontal size={14} strokeWidth={1.5} />
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        {item.session && (
          <MenuItem shortcut="open" onSelect={() => openSession(item.session!.id)}>
            フォーカスで開く
          </MenuItem>
        )}
        {run && live && (
          <MenuItem shortcut="stopRun" onSelect={() => void stop(rt, run)}>
            停止
          </MenuItem>
        )}
        {run && (item.state === 'failed' || item.state === 'interrupted' || item.state === 'cancelled') && (
          <MenuItem shortcut="retry" onSelect={() => void retry(rt, run)}>
            再試行
          </MenuItem>
        )}
        {item.session && (
          <MenuItem shortcut="archive" onSelect={() => void archiveSession(rt, item.session!)}>
            アーカイブ
          </MenuItem>
        )}
      </MenuContent>
    </Menu>
  );
}

/** Fixed-width right columns: model · elapsed · cost (never reflow on updates). */
function MetaColumns({ item }: { item: BoardItem }) {
  const range = elapsedRange(item);
  const live = item.state === 'running' || item.state === 'awaiting_approval' || item.state === 'queued';
  return (
    <span className="flex shrink-0 items-center">
      <span className="w-24 truncate pr-3 text-right text-meta text-fg-3">{shortModel(item.model)}</span>
      <span className="w-16 text-right">
        <ElapsedTime start={range.start} end={live ? null : range.end} />
      </span>
      <span className="w-16 text-right">
        <Cost usd={item.costUsd} source={item.costSource} />
      </span>
    </span>
  );
}


interface RowProps {
  item: BoardItem;
  selected: boolean;
  onSelect: (item: BoardItem) => void;
  onOpen: (item: BoardItem) => void;
}

/** One-shot marks from the event stream: the run completed / failed a moment ago. */
function useJustEnded(item: BoardItem, kind: 'completed' | 'failed'): boolean {
  const rt = useRuntime();
  const runId = item.run?.id;
  return useStore(rt.streams.recent.store, (s) => !!runId && !!s[kind][runId]);
}

/** 52px two-line agent row (§5.1). */
export const AgentRow = memo(function AgentRow({ item, selected, onSelect, onOpen }: RowProps) {
  const justCompleted = useJustEnded(item, 'completed') && item.state === 'completed';
  return (
    <motion.div
      layoutId={item.id}
      layout="position"
      transition={{ layout: LAYOUT_SPRING }}
      data-board-item={item.id}
      tabIndex={-1}
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(item)}
      onDoubleClick={() => onOpen(item)}
      className={cn(
        'group relative flex h-[52px] cursor-default items-center gap-3 overflow-hidden rounded-sm pr-2 pl-3 outline-none',
        selected ? 'bg-selected' : 'hover:bg-hover',
      )}
    >
      {selected && <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-accent" />}
      {justCompleted && (
        <span
          aria-hidden="true"
          className="acc-sweep pointer-events-none absolute inset-0"
          style={{ background: 'color-mix(in oklch, var(--st-completed) 10%, transparent)' }}
        />
      )}
      <StatusIcon state={item.state} size={14} />
      <Monogram text={item.title} />
      <span className="flex min-w-0 flex-1 flex-col">
        <RoleTitle item={item} />
        <ActivityLine
          runId={item.state === 'running' || item.state === 'queued' ? item.run?.id : null}
          fallback={fallbackActivity(item)}
          className="text-ui text-fg-2"
        />
      </span>
      <MetaColumns item={item} />
      <RowMenu item={item} />
    </motion.div>
  );
});

function Evidence({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'error' }) {
  return (
    <pre
      className={cn(
        'max-w-full overflow-x-auto rounded-sm border border-line-subtle bg-canvas px-2.5 py-1.5 font-mono text-code whitespace-pre-wrap',
        tone === 'error' ? 'text-fg-2' : 'text-fg',
      )}
    >
      {children}
    </pre>
  );
}

/** Attention card (min 88px, §5.1): state bar, what is asked, evidence, inline actions. */
export const AttentionCard = memo(function AttentionCard({ item, selected, onSelect, onOpen }: RowProps) {
  const rt = useRuntime();
  const connected = useConnectionState() === 'open';
  const resolved = useResolvedApprovals();
  const justFailed = useJustEnded(item, 'failed') && item.state === 'failed';
  const view = item.approval ? describeApproval(item.approval) : null;
  const { controls, onKeyDown } = useApprovalControls(item.approval, view, () => onSelect(item));
  const recentDecision =
    !item.approval && item.state === 'awaiting_approval'
      ? resolved.find((a) => a.sessionId === item.session?.id || (item.run && a.runId === item.run.id))
      : undefined;
  const range = elapsedRange(item);
  const run = item.run;
  const color = stateColor(item.state);

  let ask: string;
  let evidence: ReactNode = null;
  let actions: ReactNode;
  switch (item.state) {
    case 'awaiting_approval':
      ask = recentDecision
        ? recentDecision.status === 'approved'
          ? '承認しました。作業の再開を待っています'
          : '拒否を伝えました。エージェントの応答を待っています'
        : (view?.question ?? '承認を待っています');
      if (view?.target) evidence = <Evidence>{view.targetKind === 'command' ? `$ ${view.target}` : view.target}</Evidence>;
      actions = recentDecision ? <ResolvedLine approval={recentDecision} /> : controls;
      break;
    case 'failed': {
      const msg = run?.error?.message ?? item.integration?.error?.message ?? 'エラーで停止しました';
      ask = headLines(msg, 1);
      const rest = msg.split('\n').slice(1).join('\n');
      if (rest.trim()) evidence = <Evidence tone="error">{headLines(rest, 2)}</Evidence>;
      actions = run ? (
        <>
          <Button shortcut="retry" onClick={() => void retry(rt, run)} disabled={!connected}>
            再試行
          </Button>
          <Button variant="ghost" onClick={() => onOpen(item)}>
            ログを見る
          </Button>
        </>
      ) : null;
      break;
    }
    case 'interrupted':
      ask = 'プロセスが予期せず終了しました。再開または再試行できます';
      actions = run ? (
        <Button shortcut="retry" onClick={() => void retry(rt, run)} disabled={!connected}>
          再試行
        </Button>
      ) : null;
      break;
    default: {
      const i = item.integration;
      ask = i
        ? `${i.taskIds.length} 件の Task を統合しました · ${i.steps.filter((s) => s.status === 'succeeded').length}/${i.steps.length} ステップ成功`
        : (item.task?.resultSummary ?? '作業が終わりました。レビューしてください');
      actions = (
        <Button variant="primary" onClick={() => onOpen(item)}>
          レビューを開始
        </Button>
      );
    }
  }

  return (
    <motion.div
      layoutId={item.id}
      layout="position"
      transition={{ layout: LAYOUT_SPRING }}
      data-board-item={item.id}
      tabIndex={0}
      role="option"
      aria-selected={selected}
      aria-label={`${item.role} · ${item.title} · ${STATE_LABEL[item.state]}`}
      onClick={() => onSelect(item)}
      onDoubleClick={() => onOpen(item)}
      onKeyDown={onKeyDown}
      className={cn(
        'group relative flex min-h-[88px] flex-col gap-2 overflow-hidden rounded-md border py-3 pr-3 pl-4 outline-none',
        'focus-visible:shadow-[inset_0_0_0_1px_var(--focus-ring)]',
        selected ? 'border-line-strong bg-selected' : 'border-line bg-surface hover:border-line-strong',
        justFailed && 'acc-fail-flash',
      )}
    >
      <motion.span
        aria-hidden="true"
        initial={{ scaleY: 0 }}
        animate={{ scaleY: 1 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="absolute top-0 bottom-0 left-0 w-0.5 origin-top"
        style={{ background: color }}
      />
      <div className="flex items-center gap-3">
        <StatusIcon state={item.state} size={14} />
        <RoleTitle item={item} className="flex-1" />
        <StatusLabel state={item.state} className="w-16 text-right" />
        <span className="w-16 text-right">
          <ElapsedTime start={range.start} end={item.state === 'awaiting_approval' ? null : range.end} />
        </span>
        <span className="w-16 text-right">
          <Cost usd={item.costUsd} source={item.costSource} />
        </span>
        <RowMenu item={item} />
      </div>
      <div className="flex flex-col gap-2 pl-[26px]">
        <p className="text-ui text-fg-2">{ask}</p>
        {evidence}
        {view && item.state === 'awaiting_approval' && !recentDecision && <RiskNote view={view} />}
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {item.session && (
            <Tooltip content="フォーカスで開く（Enter）">
              <button
                type="button"
                onClick={() => onOpen(item)}
                className="ml-1 inline-flex h-7 items-center gap-1 rounded-sm px-1.5 text-ui text-fg-3 hover:text-fg"
              >
                詳細
                <ArrowRight size={13} strokeWidth={1.5} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </motion.div>
  );
});
