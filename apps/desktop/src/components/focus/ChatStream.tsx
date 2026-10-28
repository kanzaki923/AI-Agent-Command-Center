import type { Approval, Run, Session } from '@acc/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, ArrowDown, Bot, Square } from 'lucide-react';
import { memo, useMemo } from 'react';
import { retry } from '../../app/commands';
import { sendMessage } from '../../daemon/actions';
import { useGrants, useMessages, usePendingApprovals, useResolvedApprovals, useRuns, useStreaming } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import type { ChatMessage } from '../../daemon/sync';
import type { StickToBottom } from '../../hooks/useStickToBottom';
import { cn } from '../../lib/cn';
import { headLines } from '../../lib/tools';
import { describeApproval } from '../../model/approval';
import { type ChatBlock, buildChatBlocks } from '../../model/chat';
import { ResolvedLine, RiskNote, useApprovalControls } from '../approval/ApprovalControls';
import { GrantLine, OrchestratorIntro, useSessionGrants } from '../grant/Grant';
import { Button } from '../ui/Button';
import { Skeleton, TimeStamp } from '../ui/Meta';
import { Markdown } from './Markdown';
import { ToolGroup } from './ToolBlocks';

const NONE: never[] = [];

function UserBlock({ message, fromAgent }: { message: ChatMessage; fromAgent: boolean }) {
  const rt = useRuntime();
  const text = message.content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n');
  const failed = message.local?.status === 'failed';
  return (
    <div className="flex flex-col gap-1">
      {fromAgent && (
        <div className="flex items-center gap-1.5 text-micro text-fg-3">
          <Bot size={12} strokeWidth={1.75} />
          Orchestrator から
        </div>
      )}
      <div
        className={cn(
          'selectable rounded-md border bg-surface px-3.5 py-2.5 text-chat whitespace-pre-wrap text-fg',
          failed ? 'border-[color-mix(in_oklch,var(--st-failed)_45%,transparent)]' : 'border-line',
        )}
      >
        {text}
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
      </div>
    </div>
  );
}

const Block = memo(function Block({ block }: { block: ChatBlock }) {
  switch (block.kind) {
    case 'user':
      return <UserBlock message={block.message} fromAgent={block.fromAgent} />;
    case 'assistant':
      return <Markdown text={block.text} />;
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
        <Markdown text={block.stream.text} streaming />
      );
    case 'run-error':
      return <RunError run={block.run} />;
    case 'grant':
      return <GrantLine grant={block.grant} change={block.change} />;
    case 'run-stopped':
      return (
        <div className="flex items-center gap-1.5 text-meta text-fg-3">
          <Square size={11} strokeWidth={2} />
          停止しました
          {block.run.endedAt && (
            <>
              <span className="text-fg-4">·</span>
              <TimeStamp iso={block.run.endedAt} />
            </>
          )}
        </div>
      );
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

export function ChatStream({ session, stick }: { session: Session; stick: StickToBottom }) {
  const messages = useMessages(session.id);
  const pending = usePendingApprovals().data ?? NONE;
  const resolved = useResolvedApprovals();
  const runs = useRuns().data ?? NONE;
  const streaming = useStreaming(session.id);
  const grants = useGrants(session.id).data ?? NONE;
  const activeOrchestrator = useSessionGrants(session.kind === 'chat' ? session.id : null).orchestrator;

  const blocks = useMemo(() => {
    const approvals = [...pending, ...resolved].filter((a) => a.sessionId === session.id);
    const unique = [...new Map(approvals.map((a) => [a.id, a])).values()];
    return buildChatBlocks({
      messages: messages.data ?? NONE,
      approvals: unique,
      streaming,
      runs: runs.filter((r) => r.sessionId === session.id),
      grants: grants.filter((g) => g.subject.kind === 'session'),
    });
  }, [messages.data, pending, resolved, streaming, runs, session.id, grants]);

  // The React Compiler is not used in this app; TanStack Virtual is fine without memoization.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virt = useVirtualizer({
    count: blocks.length,
    getScrollElement: stick.getElement,
    estimateSize: (i) => (blocks[i]?.kind === 'tools' ? 34 : 96),
    getItemKey: (i) => blocks[i]?.id ?? i,
    overscan: 8,
  });

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
                  ref={virt.measureElement}
                  className="absolute right-6 left-6"
                  style={{ transform: `translateY(${vi.start}px)`, paddingTop: gapBefore(blocks[vi.index - 1], b) }}
                >
                  <Block block={b} />
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
