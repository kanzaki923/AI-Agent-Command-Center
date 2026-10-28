import { type Approval, type Run, type Session, isTerminalRunStatus } from '@acc/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, ArrowDown, Bot, Brain, ChevronRight, Pencil, RotateCcw, Square } from 'lucide-react';
import { type ReactNode, memo, useEffect, useMemo, useState } from 'react';
import { focusComposerSoon, retry } from '../../app/commands';
import { sendMessage } from '../../daemon/actions';
import {
  useGrants,
  useMessages,
  usePendingApprovals,
  useResolvedApprovals,
  useRuns,
  useStreaming,
  useTasks,
} from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import type { ChatMessage } from '../../daemon/sync';
import type { StickToBottom } from '../../hooks/useStickToBottom';
import { cn } from '../../lib/cn';
import { headLines } from '../../lib/tools';
import { describeApproval } from '../../model/approval';
import {
  type ChatBlock,
  buildChatBlocks,
  lastUnanswered,
  messageText,
  stabilizeBlocks,
} from '../../model/chat';
import { useUi } from '../../store/ui';
import { ResolvedLine, RiskNote, useApprovalControls } from '../approval/ApprovalControls';
import { GrantLine, OrchestratorIntro, useSessionGrants } from '../grant/Grant';
import { Button } from '../ui/Button';
import { CopyButton } from '../ui/CopyButton';
import { Kbd } from '../ui/Kbd';
import { Skeleton, TimeStamp } from '../ui/Meta';
import { Markdown } from './Markdown';
import { ToolGroup } from './ToolBlocks';

const NONE: never[] = [];

/** A user message longer than this folds to its first lines (a pasted log stays readable). */
const FOLD_LINES = 18;
const FOLD_CHARS = 1800;

/**
 * Copy / edit as a small floating bar over the message's top-right corner, shown on hover
 * or keyboard focus. It takes no layout space: a conversation keeps its rhythm whether or
 * not the pointer is on it. Hover appears instantly and fades out in 120ms (§3.1).
 */
function MessageActions({ children }: { children: ReactNode }) {
  return (
    <div
      role="toolbar"
      aria-label="メッセージの操作"
      className={cn(
        'absolute -top-3.5 right-0 z-10 flex h-7 items-center gap-0.5 rounded-sm border border-line bg-raised px-0.5 shadow-float',
        'invisible opacity-0 transition-[opacity,visibility] duration-[120ms]',
        'group-hover/msg:visible group-hover/msg:opacity-100 group-hover/msg:duration-0',
        'group-focus-within/msg:visible group-focus-within/msg:opacity-100',
      )}
    >
      {children}
    </div>
  );
}

function UserBlock({ message, fromAgent, editable }: { message: ChatMessage; fromAgent: boolean; editable: boolean }) {
  const rt = useRuntime();
  const setEditing = useUi((s) => s.setEditing);
  const superseded = useUi((s) => !!s.superseded[message.id]);
  const text = messageText(message);
  const failed = message.local?.status === 'failed';
  const long = text.length > FOLD_CHARS || text.split('\n').length > FOLD_LINES;
  const [expanded, setExpanded] = useState(false);
  if (superseded) {
    return (
      <div className="flex items-center gap-1.5 text-meta text-fg-4">
        <Pencil size={11} strokeWidth={1.75} />
        <span className="shrink-0">編集前:</span>
        <span className="min-w-0 truncate line-through decoration-fg-4/60">{text}</span>
      </div>
    );
  }
  const folded = long && !expanded;
  return (
    <div className="group/msg relative flex flex-col gap-1">
      {fromAgent && (
        <div className="flex items-center gap-1.5 text-micro text-fg-3">
          <Bot size={12} strokeWidth={1.75} />
          Orchestrator から
        </div>
      )}
      <div
        className={cn(
          'selectable relative overflow-hidden rounded-md border bg-surface px-3.5 py-2.5 text-chat whitespace-pre-wrap text-fg',
          failed ? 'border-[color-mix(in_oklch,var(--st-failed)_45%,transparent)]' : 'border-line',
          folded && 'max-h-[312px]',
        )}
      >
        {text}
        {folded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[var(--bg-surface)] to-transparent" />
        )}
      </div>
      {failed && (
        <div className="flex items-center gap-1.5 text-meta text-st-failed">
          送信できませんでした
          <span className="text-fg-4">·</span>
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => void sendMessage(rt, message.sessionId, text, { reuseLocalId: message.id })}
          >
            再送
          </button>
        </div>
      )}
      {message.local?.status === 'sending' && <div className="text-meta text-fg-4">送信中…</div>}
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex h-6 items-center gap-1 self-start rounded-xs px-1.5 text-meta text-fg-3 hover:bg-hover hover:text-fg"
        >
          <ChevronRight
            size={12}
            strokeWidth={1.75}
            className={cn('transition-transform duration-[120ms]', expanded ? '-rotate-90' : 'rotate-90')}
          />
          {expanded ? '折りたたむ' : `全文を表示（${text.split('\n').length} 行）`}
        </button>
      )}
      {!message.local && (
        <MessageActions>
          <CopyButton text={text} iconOnly label="メッセージをコピー" />
          {editable && (
            <button
              type="button"
              onClick={() => {
                setEditing({ sessionId: message.sessionId, messageId: message.id, text });
                focusComposerSoon();
              }}
              className="flex h-6 items-center gap-1 rounded-xs px-1.5 text-meta text-fg-3 hover:bg-hover hover:text-fg"
            >
              <Pencil size={11} strokeWidth={1.75} />
              編集して送り直す
              <Kbd keys="ArrowUp" />
            </button>
          )}
          <span className="px-1 text-meta text-fg-4">
            <TimeStamp iso={message.createdAt} />
          </span>
        </MessageActions>
      )}
    </div>
  );
}

/** Model reasoning: folded to one quiet line; the answer is what matters (§5.2). */
function Reasoning({ text, live = false }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const chars = text.length;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-6 items-center gap-1.5 self-start rounded-xs pr-1.5 text-meta text-fg-3 hover:text-fg-2"
      >
        <ChevronRight
          size={12}
          strokeWidth={1.75}
          className={cn('transition-transform duration-[120ms]', open && 'rotate-90')}
        />
        <Brain size={12} strokeWidth={1.75} />
        {live ? '考えています…' : '思考過程'}
        <span className="text-fg-4 tabular">· {chars.toLocaleString()} 文字</span>
      </button>
      {open && (
        <div className="selectable mt-1 border-l-2 border-line pl-3 text-ui whitespace-pre-wrap text-fg-3">
          {text}
          {live && <span className="acc-caret" aria-hidden="true" />}
        </div>
      )}
    </div>
  );
}

function AssistantBlock({ block }: { block: ChatBlock & { kind: 'assistant' } }) {
  const rt = useRuntime();
  const connected = useConnectionState() === 'open';
  const run = useRuns().data?.find((r) => r.id === block.message.runId) ?? null;
  const retryable = !!run && ['failed', 'cancelled', 'interrupted'].includes(run.status);
  return (
    <div className="group/msg relative flex flex-col gap-1.5">
      {block.reasoning.trim() && <Reasoning text={block.reasoning} />}
      {block.text.trim() && <Markdown text={block.text} />}
      {block.text.trim() && (
        <MessageActions>
          <CopyButton text={block.text} label="コピー" />
          {retryable && run && (
            <button
              type="button"
              disabled={!connected}
              onClick={() => void retry(rt, run)}
              className="flex h-6 items-center gap-1 rounded-xs px-1.5 text-meta text-fg-2 hover:bg-hover hover:text-fg disabled:text-fg-4"
            >
              <RotateCcw size={11} strokeWidth={1.75} />
              再試行
            </button>
          )}
        </MessageActions>
      )}
    </div>
  );
}

function InlineApproval({ approval }: { approval: Approval }) {
  const view = describeApproval(approval);
  const pending = approval.status === 'pending';
  const { controls, onKeyDown } = useApprovalControls(pending ? approval : null, view);
  const barColor =
    approval.status === 'pending'
      ? 'var(--st-awaiting_approval)'
      : approval.status === 'approved'
        ? 'var(--border-strong)'
        : 'var(--border-strong)';
  return (
    <div
      tabIndex={pending ? 0 : -1}
      onKeyDown={onKeyDown}
      data-approval={approval.id}
      className="relative flex flex-col gap-2 rounded-sm py-1 pl-4 outline-none focus-visible:bg-hover"
    >
      <span className="absolute top-0 bottom-0 left-0 w-0.5 rounded-full" style={{ background: barColor }} />
      <div className={cn('text-ui font-medium', pending ? 'text-fg' : 'text-fg-3')}>{view.question}</div>
      {view.target && (
        <pre className="selectable overflow-x-auto rounded-sm border border-line-subtle bg-canvas px-2.5 py-1.5 font-mono text-code text-fg whitespace-pre-wrap">
          {view.targetKind === 'command' ? `$ ${view.target}` : view.target}
        </pre>
      )}
      {pending && <RiskNote view={view} />}
      {pending ? controls : <ResolvedLine approval={approval} />}
    </div>
  );
}

function RunError({ run }: { run: Run }) {
  const rt = useRuntime();
  const connected = useConnectionState() === 'open';
  const msg = run.error?.message ?? 'エラーで停止しました';
  return (
    <div
      className="flex flex-col gap-2 rounded-md border px-3.5 py-2.5"
      style={{
        borderColor: 'color-mix(in oklch, var(--st-failed) 35%, transparent)',
        background: 'color-mix(in oklch, var(--st-failed) 6%, transparent)',
      }}
    >
      <div className="flex items-center gap-2 text-ui text-st-failed">
        <AlertTriangle size={14} strokeWidth={1.5} />
        {headLines(msg, 1)}
      </div>
      {msg.includes('\n') && (
        <pre className="font-mono text-code text-fg-2 whitespace-pre-wrap">{headLines(msg.split('\n').slice(1).join('\n'), 2)}</pre>
      )}
      <div className="flex gap-2">
        <Button size="sm" shortcut="retry" onClick={() => void retry(rt, run)} disabled={!connected}>
          再試行
        </Button>
        <CopyButton text={msg} label="エラーをコピー" />
      </div>
    </div>
  );
}

function RunStopped({ run }: { run: Run }) {
  const rt = useRuntime();
  const connected = useConnectionState() === 'open';
  return (
    <div className="flex items-center gap-1.5 text-meta text-fg-3">
      <Square size={11} strokeWidth={2} />
      停止しました
      {run.endedAt && (
        <>
          <span className="text-fg-4">·</span>
          <TimeStamp iso={run.endedAt} />
        </>
      )}
      <span className="text-fg-4">·</span>
      <button
        type="button"
        disabled={!connected}
        onClick={() => void retry(rt, run)}
        className="text-accent hover:underline disabled:text-fg-4"
      >
        もう一度生成
      </button>
    </div>
  );
}

const Block = memo(function Block({ block, editableId }: { block: ChatBlock; editableId: string | null }) {
  switch (block.kind) {
    case 'user':
      return (
        <UserBlock message={block.message} fromAgent={block.fromAgent} editable={block.message.id === editableId} />
      );
    case 'assistant':
      return <AssistantBlock block={block} />;
    case 'tools':
      return <ToolGroup calls={block.calls} />;
    case 'approval':
      return <InlineApproval approval={block.approval} />;
    case 'streaming':
      // Joined mid-stream: a fragment would render as broken markdown. Show progress and
      // let message.created bring the full text.
      return block.stream.partial ? (
        <div className="text-chat text-fg-3">
          回答を生成中…<span className="acc-caret" aria-hidden="true" />
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {block.stream.reasoning.trim() && <Reasoning text={block.stream.reasoning} live={!block.stream.text} />}
          {(block.stream.text || !block.stream.reasoning) && (
            <Markdown text={block.stream.text} streaming streamId={block.stream.messageId} />
          )}
        </div>
      );
    case 'run-error':
      return <RunError run={block.run} />;
    case 'grant':
      return <GrantLine grant={block.grant} change={block.change} />;
    case 'run-stopped':
      return <RunStopped run={block.run} />;
  }
});

/** Vertical rhythm: tighter between consecutive tool blocks, roomier around turns. */
function gapBefore(prev: ChatBlock | undefined, cur: ChatBlock): number {
  if (!prev) return 24;
  if (prev.kind === 'tools' && cur.kind === 'tools') return 6;
  if (cur.kind === 'grant' || prev.kind === 'grant') return 18;
  if (cur.kind === 'user' || prev.kind === 'user') return 24;
  return 14;
}

/** The message a block shows (jump targets). */
function blockMessageId(b: ChatBlock): string | null {
  if (b.kind === 'user' || b.kind === 'assistant') return b.message.id;
  return null;
}

export function ChatStream({ session, stick }: { session: Session; stick: StickToBottom }) {
  const messages = useMessages(session.id);
  const pending = usePendingApprovals().data ?? NONE;
  const resolved = useResolvedApprovals();
  const runs = useRuns().data ?? NONE;
  const tasks = useTasks().data;
  const streaming = useStreaming(session.id);
  const grants = useGrants(session.id).data ?? NONE;
  const activeOrchestrator = useSessionGrants(session.kind === 'chat' ? session.id : null).orchestrator;
  const jumpTo = useUi((s) => (s.jumpTo?.sessionId === session.id ? s.jumpTo : null));
  const clearJump = useUi((s) => s.clearJump);
  // Previous blocks by id (structural sharing). A cache, not state: writing it never renders.
  const [previous] = useState(() => new Map<string, ChatBlock>());

  const lookup = useMemo(() => {
    const titles = new Map((tasks ?? NONE).map((t) => [t.id, t.title]));
    return { taskTitle: (id: string) => titles.get(id) };
  }, [tasks]);

  const blocks = useMemo(() => {
    const approvals = [...pending, ...resolved].filter((a) => a.sessionId === session.id);
    const unique = [...new Map(approvals.map((a) => [a.id, a])).values()];
    return stabilizeBlocks(
      previous,
      buildChatBlocks({
        messages: messages.data ?? NONE,
        approvals: unique,
        streaming,
        runs: runs.filter((r) => r.sessionId === session.id),
        grants: grants.filter((g) => g.subject.kind === 'session'),
        lookup,
      }),
    );
  }, [previous, messages.data, pending, resolved, streaming, runs, session.id, grants, lookup]);

  // ↑-editable: the last human message nothing answered yet (an agent run in progress is
  // not interrupted from here; its own stop control does that).
  const unanswered = lastUnanswered(messages.data ?? NONE);
  const activeRun = session.activeRunId ? runs.find((r) => r.id === session.activeRunId) : undefined;
  const editableId =
    unanswered && streaming.length === 0 && (session.kind === 'chat' || !activeRun || isTerminalRunStatus(activeRun.status))
      ? unanswered.id
      : null;

  // The React Compiler is not used in this app; TanStack Virtual is fine without memoization.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virt = useVirtualizer({
    count: blocks.length,
    getScrollElement: stick.getElement,
    estimateSize: (i) => (blocks[i]?.kind === 'tools' ? 34 : 96),
    getItemKey: (i) => blocks[i]?.id ?? i,
    overscan: 8,
  });

  const release = stick.release;
  const jumpIndex = jumpTo ? blocks.findIndex((b) => blockMessageId(b) === jumpTo.messageId) : -1;
  // useEffect is required: scrolling the virtualized list is a DOM side effect that can only
  // run once the blocks are laid out; the jump request comes from outside (palette, Timeline).
  useEffect(() => {
    if (!jumpTo || jumpIndex === -1) return;
    release();
    virt.scrollToIndex(jumpIndex, { align: 'center' });
    const t = setTimeout(clearJump, 1700);
    return () => clearTimeout(t);
  }, [jumpTo, jumpIndex, virt, clearJump, release]);

  if (messages.isPending) {
    return (
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-6 pt-8">
        <Skeleton className="h-11 w-2/3" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-8 w-1/2" />
      </div>
    );
  }

  const items = virt.getVirtualItems();
  // Nothing said yet: an orchestrator chat introduces its role instead of a blank page.
  const conversationStarted = blocks.some((b) => b.kind !== 'grant');
  const orchestrator = session.kind === 'chat' ? activeOrchestrator : null;
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={stick.scrollRef}
        tabIndex={-1}
        className="h-full overflow-y-auto outline-none"
        data-region="main"
      >
        {!conversationStarted && orchestrator ? (
          <OrchestratorIntro session={session} grant={orchestrator} />
        ) : blocks.length === 0 ? (
          <div className="mx-auto flex h-full max-w-[760px] flex-col items-center justify-center px-6 text-center">
            <div className="text-title text-fg-2">{session.kind === 'agent' ? '作業内容を伝えてください' : '何でも聞いてください'}</div>
            <div className="mt-1 text-ui text-fg-3">
              {session.kind === 'agent'
                ? 'エージェントは worktree の中で作業し、変更は右の「変更」タブに表示されます。'
                : 'Enter で送信、Shift+Enter で改行します。'}
            </div>
          </div>
        ) : (
          <div ref={stick.contentRef} className="relative mx-auto w-full max-w-[760px] px-6" style={{ height: virt.getTotalSize() + 32 }}>
            {items.map((vi) => {
              const b = blocks[vi.index]!;
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  data-message-id={blockMessageId(b) ?? undefined}
                  ref={virt.measureElement}
                  className="absolute right-6 left-6"
                  style={{ transform: `translateY(${vi.start}px)`, paddingTop: gapBefore(blocks[vi.index - 1], b) }}
                >
                  <div className={cn(jumpIndex === vi.index && '-mx-2 px-2 py-1 acc-flash')}>
                    <Block block={b} editableId={editableId} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {!stick.following && blocks.length > 0 && (
        <button
          type="button"
          onClick={() => stick.scrollToBottom('smooth')}
          className="absolute bottom-3 left-1/2 z-10 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-raised px-3 text-meta text-fg-2 shadow-float hover:text-fg"
          style={{ animation: 'acc-fade-in 180ms var(--ease-out)' }}
        >
          <ArrowDown size={13} strokeWidth={1.75} />
          {stick.hasUnseen ? '新しいメッセージ' : '最新へ'}
        </button>
      )}
    </div>
  );
}
