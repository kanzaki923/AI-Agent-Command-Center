import { type Run, type Session, type SessionCard, isTerminalRunStatus } from '@acc/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, ArrowDown, Brain, ChevronRight, Clock, Diamond, Pencil, RotateCcw, Square } from 'lucide-react';
import { type ReactNode, createContext, memo, use, useEffect, useMemo, useState } from 'react';
import { focusComposerSoon, retry } from '../../app/commands';
import { sendMessage } from '../../daemon/actions';
import { useAttention } from '../../daemon/home';
import {
  useMessages,
  usePendingApprovals,
  useResolvedApprovals,
  useRunFromList,
  useSessionRuns,
  useSessions,
  useStreaming,
  useToolDecisionHistory,
} from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import type { ChatMessage } from '../../daemon/sync';
import type { StickToBottom } from '../../hooks/useStickToBottom';
import { cn } from '../../lib/cn';
import { formatClock } from '../../lib/format';
import { sessionTitle } from '../../lib/states';
import { headLines } from '../../lib/tools';
import { decisionsByToolCall } from '../../model/permissions';
import { type ChatBlock, contentKey, lastUnanswered, messageText, stabilizeBlocks } from '../../model/chat';
import { toast } from '../../store/toast';
import { useUi } from '../../store/ui';
import { InlineApproval } from '../approval/ApprovalControls';
import { Button } from '../ui/Button';
import { CopyButton } from '../ui/CopyButton';
import { Kbd } from '../ui/Kbd';
import { Skeleton, TimeStamp } from '../ui/Meta';
import { Tooltip } from '../ui/Tooltip';
import { ApprovalLine, BriefCard, FromLine, WakeCard } from './Cards';
import { type ConversationBlock, buildBaseBlocks, stripMachineBlocks, toConversationBlocks } from './conversation';
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

/** What the screen shows of a message the person (or the leading conversation) wrote. */
function displayText(message: ChatMessage): string {
  const text = messageText(message);
  if (message.meta?.kind === 'answer') return message.meta.choiceLabel ?? text.replace(/^回答[:：]\s*/, '');
  return stripMachineBlocks(text);
}

/** Who sent a message that was not typed here (the leading conversation, a schedule). */
function Origin({ message }: { message: ChatMessage }) {
  const { titleOf } = use(ConversationContext);
  if (message.meta?.kind === 'schedule') {
    return (
      <FromLine icon={<Clock size={12} strokeWidth={1.75} aria-label="繰り返し" />}>
        <span className="tabular">{formatClock(message.meta.scheduledFor)}</span>
      </FromLine>
    );
  }
  if (message.author.kind !== 'agent') return null;
  const title = titleOf(message.author.sessionId);
  return (
    <FromLine icon={<Diamond size={11} strokeWidth={1.75} fill="currentColor" className="text-st-supervising" aria-hidden />}>
      <button
        type="button"
        className="truncate hover:text-fg hover:underline"
        onClick={() => message.author.kind === 'agent' && useUi.getState().openSession(message.author.sessionId)}
      >
        {title ?? '任せた会話'}
      </button>
    </FromLine>
  );
}

function UserBlock({ message, editable }: { message: ChatMessage; editable: boolean }) {
  const rt = useRuntime();
  const setEditing = useUi((s) => s.setEditing);
  const superseded = useUi((s) => !!s.superseded[message.id]);
  const text = displayText(message);
  const failed = message.local?.status === 'failed';
  const queued = message.delivery === 'queued' && !message.local;
  const long = text.length > FOLD_CHARS || text.split('\n').length > FOLD_LINES;
  const [expanded, setExpanded] = useState(false);
  if (superseded) {
    return (
      <div className="flex items-center gap-1.5 text-meta text-fg-3">
        <Pencil size={11} strokeWidth={1.75} />
        <span className="shrink-0">編集前:</span>
        <span className="min-w-0 truncate line-through decoration-fg-4/60">{text}</span>
      </div>
    );
  }
  const folded = long && !expanded;
  return (
    <div className="group/msg relative flex flex-col gap-1" data-delivery={message.delivery}>
      <Origin message={message} />
      <div className="flex items-end gap-1.5">
        <div
          className={cn(
            'selectable relative min-w-0 flex-1 overflow-hidden rounded-md border bg-surface px-3.5 py-2.5 text-chat whitespace-pre-wrap text-fg',
            failed ? 'border-[color-mix(in_oklch,var(--st-failed)_45%,transparent)]' : 'border-line',
            queued && 'border-dashed text-fg-2',
            folded && 'max-h-[312px]',
          )}
        >
          {text}
          {folded && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[var(--bg-surface)] to-transparent" />
          )}
        </div>
        {queued && (
          <Tooltip content="送信待ち">
            <span role="img" aria-label="送信待ち" data-testid="queued-mark" className="mb-2 inline-flex shrink-0 text-fg-3">
              <Clock size={13} strokeWidth={1.75} aria-hidden />
            </span>
          </Tooltip>
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
          <span className="px-1 text-meta text-fg-3">
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
        <span className="text-fg-3 tabular">· {chars.toLocaleString()} 文字</span>
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
  const run = useRunFromList(block.message.runId);
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

function RunError({ run }: { run: Run }) {
  const rt = useRuntime();
  const connected = useConnectionState() === 'open';
  // The open failure (its row above the composer) offers 再試行: not twice.
  const { failureOpen } = use(ConversationContext);
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
        <span className="min-w-0 flex-1">{headLines(msg, 1)}</span>
        <CopyButton text={msg} iconOnly label="エラーをコピー" />
      </div>
      {msg.includes('\n') && (
        <pre className="font-mono text-code text-fg-2 whitespace-pre-wrap">{headLines(msg.split('\n').slice(1).join('\n'), 2)}</pre>
      )}
      {!failureOpen && (
        <div className="flex gap-2">
          <Button size="sm" shortcut="retry" onClick={() => void retry(rt, run)} disabled={!connected}>
            再試行
          </Button>
        </div>
      )}
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

/** What every row of one conversation shares (no prop churn through the memoized rows). */
interface ConversationCtx {
  session: Session | null;
  card: SessionCard | null;
  titleOf: (sessionId: string) => string | undefined;
  /** An open failure of this conversation: its row above the composer offers 再試行. */
  failureOpen: boolean;
}
const ConversationContext = createContext<ConversationCtx>({
  session: null,
  card: null,
  titleOf: () => undefined,
  failureOpen: false,
});

function Brief({ block }: { block: ConversationBlock & { kind: 'brief' } }) {
  const { session, card } = use(ConversationContext);
  return <BriefCard brief={block.brief} card={card} workspaceId={session?.workspaceId ?? null} />;
}

const Block = memo(function Block({ block, editableId }: { block: ConversationBlock; editableId: string | null }) {
  switch (block.kind) {
    case 'user':
      return <UserBlock message={block.message} editable={block.message.id === editableId} />;
    case 'brief':
      return <Brief block={block} />;
    case 'wake':
      return <WakeCard items={block.items} />;
    case 'assistant':
      return <AssistantBlock block={block} />;
    case 'tools':
      return <ToolGroup calls={block.calls} />;
    case 'approval':
      // Pending ones without an attention row (older daemons) keep their inline card.
      return block.approval.status === 'pending' ? (
        <InlineApproval approval={block.approval} />
      ) : (
        <ApprovalLine approval={block.approval} />
      );
    case 'streaming':
      // Joined mid-stream: a fragment would render as broken markdown. Show progress and
      // let message.created bring the full text.
      return block.stream.partial ? (
        <div className="text-chat text-fg-3">
          <span className="acc-caret" aria-hidden="true" />
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
    case 'run-stopped':
      return <RunStopped run={block.run} />;
  }
});

/** Vertical rhythm: tighter between consecutive tool blocks, roomier around turns. */
function gapBefore(prev: ConversationBlock | undefined, cur: ConversationBlock): number {
  if (!prev) return 24;
  if (prev.kind === 'tools' && cur.kind === 'tools') return 6;
  if (cur.kind === 'approval' && prev.kind === 'tools') return 6;
  if (cur.kind === 'user' || prev.kind === 'user' || prev.kind === 'brief') return 24;
  return 14;
}

/** The message a block shows (jump targets). */
function blockMessageId(b: ConversationBlock): string | null {
  if (b.kind === 'user' || b.kind === 'assistant' || b.kind === 'brief' || b.kind === 'wake') return b.message.id;
  return null;
}

export function ChatStream({
  session,
  card = null,
  stick,
}: {
  session: Session;
  /** The session's card in its tree (state, outputs, budget): the request card reads it. */
  card?: SessionCard | null;
  stick: StickToBottom;
}) {
  const rt = useRuntime();
  const messages = useMessages(session.id);
  const pending = usePendingApprovals().data ?? NONE;
  const resolved = useResolvedApprovals();
  // Only this session's runs: run.updated of other sessions' runs must not rebuild the chat.
  const runs = useSessionRuns(session.id);
  const streaming = useStreaming(session.id);
  const attention = useAttention({ sessionId: session.id });
  const sessions = useSessions().data;
  const jumpTo = useUi((s) => (s.jumpTo?.sessionId === session.id ? s.jumpTo : null));
  const clearJump = useUi((s) => s.clearJump);
  const landJump = useUi((s) => s.landJump);
  const flashId = useUi((s) => (s.flash?.sessionId === session.id ? s.flash.messageId : null));
  // Previous blocks by id (structural sharing) and their mapped rows. Caches, not state:
  // writing them never renders.
  const [previous] = useState(() => new Map<string, ChatBlock>());
  const [mapped] = useState(() => new WeakMap<ChatBlock, ConversationBlock>());

  const titleOf = useMemo(() => {
    const byId = new Map((sessions ?? NONE).map((s) => [s.id, sessionTitle(s)]));
    return (id: string) => byId.get(id);
  }, [sessions]);

  // Agent sessions: how each tool use was decided (the event log holds tool.decided).
  const agent = session.kind === 'agent';
  const decisionVersion = useToolDecisionHistory(agent ? session.id : null);
  const decisions = useMemo(
    () => (agent ? decisionsByToolCall(rt.streams.events.events, session.id) : undefined),
    // `decisionVersion` changes whenever an event of this session reaches the (mutable) log.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent, decisionVersion, session.id, rt],
  );
  const base = useMemo(() => {
    const approvals = [...pending, ...resolved].filter((a) => a.sessionId === session.id);
    const unique = [...new Map(approvals.map((a) => [a.id, a])).values()];
    return stabilizeBlocks(
      previous,
      buildBaseBlocks({
        messages: messages.data ?? NONE,
        approvals: unique,
        streaming,
        runs,
        decisions,
        attention,
      }),
    );
  }, [previous, messages.data, pending, resolved, streaming, runs, session.id, decisions, attention]);
  const blocks = useMemo(() => toConversationBlocks(base, mapped, titleOf), [base, mapped, titleOf]);
  const failureOpen = attention.some((a) => a.kind === 'failure');
  const ctx = useMemo<ConversationCtx>(
    () => ({ session, card, titleOf, failureOpen }),
    [session, card, titleOf, failureOpen],
  );

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
    estimateSize: (i) => (blocks[i]?.kind === 'tools' || blocks[i]?.kind === 'wake' ? 34 : 96),
    getItemKey: (i) => blocks[i]?.id ?? i,
    overscan: 8,
  });

  const { release, recheck } = stick;
  const jumpIndex = jumpTo ? blocks.findIndex((b) => blockMessageId(b) === jumpTo.messageId) : -1;
  // useEffect is required: scrolling the virtualized list is a DOM side effect that can only
  // run once the blocks are laid out; the jump request comes from outside (palette, Timeline).
  const loaded = messages.data !== undefined;
  useEffect(() => {
    if (!jumpTo) return;
    if (jumpIndex === -1) {
      // Loaded, and not among the latest 500: say so instead of keeping the request around.
      if (loaded) {
        clearJump();
        toast({ title: 'メッセージが見つかりませんでした', detail: '最新の 500 件より前のメッセージです', tone: 'info', sticky: false });
      }
      return;
    }
    release();
    virt.scrollToIndex(jumpIndex, { align: 'center' });
    // Consumed now: leaving within the flash must not leave a jump for the next visit.
    landJump();
    // A message near the end lands at the bottom anyway: keep following then (no "new" pill).
    const settle = setTimeout(recheck, 80);
    return () => clearTimeout(settle);
  }, [jumpTo, jumpIndex, loaded, virt, clearJump, landJump, release, recheck]);

  if (messages.isPending) {
    return (
      <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col gap-4 px-6 pt-8">
        <Skeleton className="h-11 w-2/3" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-8 w-1/2" />
      </div>
    );
  }

  const items = virt.getVirtualItems();
  return (
    <ConversationContext value={ctx}>
    <div className="relative min-h-0 flex-1">
      <div
        ref={stick.scrollRef}
        tabIndex={-1}
        className="h-full overflow-y-auto outline-none"
        data-region="main"
      >
        {blocks.length > 0 && (
          <div
            ref={stick.contentRef}
            data-content-key={contentKey(base)}
            className="relative mx-auto w-full max-w-[760px] px-6"
            style={{ height: virt.getTotalSize() + 32 }}
          >
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
                  <div className={cn(flashId !== null && blockMessageId(b) === flashId && '-mx-2 px-2 py-1 acc-flash')}>
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
    </ConversationContext>
  );
}
