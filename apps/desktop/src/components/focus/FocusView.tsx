import { type Run, type Session, isTerminalRunStatus } from '@acc/protocol';
import { GitBranch, MoreHorizontal, Pin, RotateCcw, Square } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import { newChat, retry, stop } from '../../app/commands';
import { archiveSession, renameSession, setPinned } from '../../daemon/actions';
import { useRun, useRuns, useSessionBudgets, useSessions, useWorkspace } from '../../daemon/queries';
import { RoleBadge } from '../grant/Grant';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { useStickToBottom } from '../../hooks/useStickToBottom';
import { sumUsage } from '../../lib/format';
import { shortModel } from '../../lib/models';
import { runStatusToState } from '../../lib/status';
import { roleOf, untitled } from '../../model/board';
import { useUi } from '../../store/ui';
import { Button, IconButton } from '../ui/Button';
import { Kbd } from '../ui/Kbd';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu';
import { Cost, ElapsedTime } from '../ui/Meta';
import { StatusIcon } from '../ui/StatusIcon';
import { Tooltip } from '../ui/Tooltip';
import { ChatStream } from './ChatStream';
import { Composer } from './Composer';

const NONE: never[] = [];

function TitleEditor({ session }: { session: Session }) {
  const rt = useRuntime();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  if (!editing) {
    return (
      <Tooltip content="クリックで名前を変更">
        <button
          type="button"
          onClick={() => {
            setValue(session.title);
            setEditing(true);
          }}
          className="min-w-0 truncate rounded-xs px-1 text-title text-fg hover:bg-hover"
        >
          {untitled(session)}
        </button>
      </Tooltip>
    );
  }
  const commit = () => {
    setEditing(false);
    const t = value.trim();
    if (t && t !== session.title) void renameSession(rt, session, t);
  };
  return (
    <input
      autoFocus
      data-inline-edit
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          // Ladder step 2: cancel the inline edit only.
          e.stopPropagation();
          setEditing(false);
        }
      }}
      className="h-7 min-w-0 flex-1 rounded-xs border border-line bg-canvas px-1.5 text-title text-fg focus:border-[var(--focus-ring)]"
    />
  );
}

function FocusHeader({ session, run, runs }: { session: Session; run: Run | null; runs: Run[] }) {
  const rt = useRuntime();
  const connected = useConnectionState() === 'open';
  const workspace = useWorkspace(session.workspaceId).data;
  const budget = useSessionBudgets(session.kind === 'chat' ? session.id : null).data?.find((b) => b.status === 'active');
  const usage = sumUsage(runs.map((r) => r.usage));
  const state = run ? runStatusToState(run.status) : 'idle';
  const live = !!run && !isTerminalRunStatus(run.status);
  const latest = runs[0] ?? null;
  const retryable = !live && latest && ['failed', 'interrupted', 'cancelled'].includes(latest.status);
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line-subtle px-4">
      <StatusIcon state={latest && !live ? runStatusToState(latest.status) : state} size={14} />
      <RoleBadge session={session} fallback={roleOf(session, run ?? latest)} />
      <span className="text-fg-4">·</span>
      <TitleEditor session={session} />
      {session.pinned && <Pin size={12} strokeWidth={1.75} className="shrink-0 text-fg-3" />}
      <span className="flex-1" />
      {session.model && (
        <span className="shrink-0 rounded-xs bg-hover px-1.5 text-meta text-fg-2">{shortModel(session.model)}</span>
      )}
      {workspace?.branch && (
        <Tooltip content={workspace.path}>
          <span className="flex max-w-56 shrink-0 items-center gap-1 font-mono text-meta text-fg-3">
            <GitBranch size={12} strokeWidth={1.75} />
            <span className="truncate">{workspace.branch}</span>
          </span>
        </Tooltip>
      )}
      {live && run && <ElapsedTime start={run.startedAt ?? run.createdAt} />}
      <span className="flex items-center gap-1">
        <Cost usd={usage.costUsd} source={usage.costSource} />
        {budget && (
          <Tooltip content="このチャットの予算（Worker への配分を含む使用額 / 上限）">
            <span className="tabular text-meta text-fg-3">
              / ${budget.limitUsd.toFixed(2)}
            </span>
          </Tooltip>
        )}
      </span>
      {live && run ? (
        <Button
          size="sm"
          icon={<Square size={10} strokeWidth={2.5} fill="currentColor" />}
          onClick={() => void stop(rt, run)}
          disabled={!connected}
          hint={
            <span className="inline-flex items-center gap-2">
              停止 <Kbd id="stopRun" />
            </span>
          }
        >
          停止
        </Button>
      ) : retryable && latest ? (
        <Button
          size="sm"
          icon={<RotateCcw size={12} strokeWidth={1.75} />}
          onClick={() => void retry(rt, latest)}
          disabled={!connected}
        >
          再試行
        </Button>
      ) : null}
      <Menu>
        <MenuTrigger asChild>
          <IconButton label="その他の操作" size="sm">
            <MoreHorizontal size={15} strokeWidth={1.5} />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem onSelect={() => void setPinned(rt, session, !session.pinned)}>
            {session.pinned ? 'ピン留めを外す' : 'ピン留め'}
          </MenuItem>
          <MenuItem shortcut="newChat" onSelect={() => void newChat(rt)}>
            新しいチャット
          </MenuItem>
          <MenuSeparator />
          <MenuItem shortcut="archive" onSelect={() => void archiveSession(rt, session)}>
            アーカイブ
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

export function FocusView() {
  const focusSessionId = useUi((s) => s.focusSessionId);
  const sessions = useSessions();
  const runsQ = useRuns();
  const session = sessions.data?.find((s) => s.id === focusSessionId) ?? null;
  const runs = (runsQ.data ?? NONE).filter((r) => r.sessionId === focusSessionId);
  const activeFromList = session?.activeRunId ? runs.find((r) => r.id === session.activeRunId) : undefined;
  const activeRunQ = useRun(activeFromList ? null : session?.activeRunId);
  const activeRun = activeFromList ?? activeRunQ.data ?? null;

  if (!focusSessionId || (!session && !sessions.isPending)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <div className="text-title text-fg-2">フォーカスするセッションがありません</div>
        <div className="text-ui text-fg-3">サイドバーかコマンドパレット（Ctrl K）からセッションを選んでください。</div>
      </div>
    );
  }
  if (!session) return null;
  return <FocusSession key={session.id} session={session} activeRun={activeRun} runs={runs} />;
}

/** Keyed by session: scroll-follow state starts fresh for every session. */
function FocusSession({ session, activeRun, runs }: { session: Session; activeRun: Run | null; runs: Run[] }) {
  const stick = useStickToBottom();
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="flex h-full min-h-0 flex-col"
    >
      <FocusHeader session={session} run={activeRun} runs={runs} />
      <ChatStream session={session} stick={stick} />
      <Composer session={session} activeRun={activeRun} onSent={() => stick.scrollToBottom()} />
    </motion.div>
  );
}
