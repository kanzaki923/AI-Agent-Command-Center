import { type HomeTree, isTerminalRunStatus } from '@acc/protocol';
import { Diamond } from 'lucide-react';
import { Fragment } from 'react';
import { useAssistantId } from '../../daemon/assistant';
import { useHomeTrees } from '../../daemon/home';
import { useMessages, useSessionRuns, useStreaming } from '../../daemon/queries';
import type { ChatMessage } from '../../daemon/sync';
import { cn } from '../../lib/cn';
import { useUi } from '../../store/ui';

const textOf = (m: ChatMessage | undefined): string =>
  (m?.content ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('')
    .trim();

/** When this window opened: only what the assistant said since then is shown on home. */
const OPENED_AT = new Date().toISOString();

/** A notice the daemon posted into the conversation of the assistant (a tree ended or failed). */
const isNotice = (m: ChatMessage) => m.role === 'system' && m.meta?.kind === 'wake';

/**
 * The voice of the assistant (right-hand spec §2.2, §4): above the home field, the last
 * exchange of this window only — the words of the human in one line, then the reply as it
 * streams in (at most two lines; 開く has the rest). When the assistant speaks up by itself
 * (a tree ended or failed), only its line shows. While it works and has said nothing yet,
 * its mark breathes; a failed run shows its reason. Titles in 「」 that name a lane open it.
 */
export function AssistantLine({ className }: { className?: string }) {
  const id = useAssistantId();
  const askedAt = useUi((s) => s.assistantAskedAt);
  const openSession = useUi((s) => s.openSession);
  const messages = useMessages(id).data;
  const streaming = useStreaming(id);
  const runs = useSessionRuns(id ?? '');
  const trees = useHomeTrees();
  if (!id || !messages) return null;

  let userAt = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' || isNotice(m)) {
      userAt = i;
      break;
    }
  }
  const user = messages[userAt];
  if (!user || user.createdAt < (askedAt && askedAt < OPENED_AT ? askedAt : OPENED_AT)) return null;
  const notice = isNotice(user);
  const reply = messages
    .slice(userAt + 1)
    .filter((m) => m.role === 'assistant' && textOf(m))
    .at(-1);
  const stream = streaming.at(-1)?.text.trim();
  const run =
    (user.runId ? runs.find((r) => r.id === user.runId) : undefined) ??
    runs
      .filter((r) => r.createdAt >= user.createdAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const busy = !!run && !isTerminalRunStatus(run.status);
  const text = stream || textOf(reply);
  const failed =
    !text && run?.status === 'failed' ? (run.error?.message ?? '右腕が答えられませんでした') : null;
  const sending = user.local?.status === 'sending';

  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)} data-assistant-line>
      {!notice && (
        <div className="min-w-0 truncate pl-[30px] text-ui text-fg-3" data-assistant-asked>
          {textOf(user) || user.local?.text}
        </div>
      )}
      <div
        className="flex min-w-0 items-start gap-2 pl-1.5"
        data-assistant-notice={notice || undefined}
      >
        <span
          role="img"
          aria-label="右腕"
          className={cn(
            'mt-[3px] inline-flex shrink-0 text-st-supervising',
            (busy || sending) && !text && 'acc-breathe',
          )}
        >
          <Diamond size={15} strokeWidth={1.75} aria-hidden />
        </span>
        <span className="line-clamp-2 min-w-0 flex-1 text-ui text-fg" data-assistant-said>
          {text ? (
            <WithTitles text={text} trees={trees} onOpen={openSession} />
          ) : failed ? (
            <span className="text-fg-3">{failed}</span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={() => openSession(id)}
          className="shrink-0 rounded-sm px-1 text-meta text-fg-3 hover:bg-hover hover:text-fg"
        >
          開く
        </button>
      </div>
    </div>
  );
}

/** Titles in 「」 that name a lane become presses that open it. */
function WithTitles({
  text,
  trees,
  onOpen,
}: {
  text: string;
  trees: HomeTree[];
  onOpen: (id: string) => void;
}) {
  const byTitle = new Map(trees.map((t) => [t.root.title, t.root.id]));
  const parts = text.split(/(「[^」]+」)/);
  return (
    <>
      {parts.map((p, i) => {
        const title = p.startsWith('「') && p.endsWith('」') ? p.slice(1, -1) : null;
        const target = title ? byTitle.get(title) : undefined;
        if (!target) return <Fragment key={i}>{p}</Fragment>;
        return (
          <button
            key={i}
            type="button"
            onClick={() => onOpen(target)}
            className="rounded-[2px] font-medium text-fg underline-offset-2 hover:underline"
          >
            {p}
          </button>
        );
      })}
    </>
  );
}
