import type { Run, Session } from '@acc/protocol';
import { motion } from 'motion/react';
import { useAttention } from '../../daemon/home';
import { useRun, useRunFromList, useSessions } from '../../daemon/queries';
import { treeRelations, useSessionTree } from '../../daemon/tree';
import { useStickToBottom } from '../../hooks/useStickToBottom';
import { useUi } from '../../store/ui';
import { AttentionRow } from '../ui/AttentionRow';
import { ChatStream } from './ChatStream';
import { Composer } from './Composer';
import { Draft } from './Draft';
import { FocusHeader } from './FocusHeader';

/**
 * One conversation (ui-redesign spec §5): its head (parent, title, state, spend, actions,
 * children), the flow of messages, this conversation's attention items pinned right above the
 * composer, and the composer. With no conversation open (Ctrl+N) it is the draft.
 */
export function FocusView() {
  const focusSessionId = useUi((s) => s.focusSessionId);
  const sessions = useSessions();
  const session = sessions.data?.find((s) => s.id === focusSessionId) ?? null;

  if (!focusSessionId) return <Draft />;
  if (!session && !sessions.isPending) {
    return (
      <div className="flex h-full items-center justify-center text-ui text-fg-3">この会話は見つかりません。</div>
    );
  }
  if (!session) return null;
  return <FocusSession key={session.id} session={session} />;
}

/** The run in progress of a session, from the shared run list (or fetched on its own). */
function useActiveRun(session: Session): Run | null {
  const fromList = useRunFromList(session.activeRunId);
  const fetched = useRun(fromList ? null : session.activeRunId).data ?? null;
  return fromList ?? (fetched && fetched.id === session.activeRunId ? fetched : null);
}

/** This conversation's open attention items, right above the composer (spec §5.2). */
function PinnedAttention({ sessionId }: { sessionId: string }) {
  const items = useAttention({ sessionId });
  if (items.length === 0) return null;
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-1.5 px-6 pb-2" role="region" aria-label="出番">
      {items.map((a) => (
        <AttentionRow key={a.id} attention={a} compact />
      ))}
    </div>
  );
}

/** Keyed by session: scroll-follow state starts fresh for every session. */
function FocusSession({ session }: { session: Session }) {
  const stick = useStickToBottom();
  const activeRun = useActiveRun(session);
  const tree = useSessionTree(session.id).data;
  const card = treeRelations(tree, session.id).self;
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="flex h-full min-h-0 flex-col"
    >
      <FocusHeader session={session} tree={tree} activeRun={activeRun} />
      <ChatStream session={session} card={card} stick={stick} />
      <PinnedAttention sessionId={session.id} />
      <Composer session={session} activeRun={activeRun} onSent={() => stick.scrollToBottom()} />
    </motion.div>
  );
}
