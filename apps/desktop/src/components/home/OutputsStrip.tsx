import { AnimatePresence, motion } from 'motion/react';
import { cn } from '../../lib/cn';
import { sessionTitle } from '../../lib/states';
import { useUnread } from '../../store/ui';
import { Elapsed } from '../ui/Elapsed';
import { OutputIcon } from '../ui/SemanticIcons';
import type { HomeOutput } from './layout';

/**
 * できたもの (ui-rework spec §3.2): what the agents delivered, newest first, one card each —
 * kind, title, which tree, when. One waiting for a decision wears the review colour. Pressing
 * a card opens the conversation (its outputs panel shows the piece). A new card slides in
 * from the right. Nothing at all when nothing was delivered.
 */
export function OutputsStrip({
  outputs,
  onOpen,
}: {
  outputs: HomeOutput[];
  onOpen: (sessionId: string) => void;
}) {
  if (outputs.length === 0) return null;
  return (
    <section aria-label="できたもの" className="flex gap-2 overflow-x-auto pb-1" data-outputs-strip>
      <AnimatePresence initial={false}>
        {outputs.map((o) => (
          <motion.div
            key={o.id}
            layout="position"
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="shrink-0"
          >
            <OutputCard output={o} onOpen={onOpen} />
          </motion.div>
        ))}
      </AnimatePresence>
    </section>
  );
}

function OutputCard({
  output: o,
  onOpen,
}: {
  output: HomeOutput;
  onOpen: (sessionId: string) => void;
}) {
  const unread = useUnread(o.session);
  return (
    <button
      type="button"
      data-home-output={o.id}
      data-review={o.review || undefined}
      onClick={() => onOpen(o.session.id)}
      className={cn(
        'flex h-14 w-56 flex-col justify-center gap-0.5 rounded-md border bg-surface px-2.5 text-left hover:bg-raised',
        o.review ? '' : 'border-transparent',
      )}
      style={
        o.review
          ? { borderColor: 'color-mix(in oklch, var(--st-review) 60%, transparent)' }
          : undefined
      }
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <OutputIcon kind={o.kind} size={13} className={o.review ? 'text-st-review' : 'text-fg-3'} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-ui font-medium',
            unread || o.review ? 'text-fg' : 'text-fg-2',
          )}
        >
          {o.title}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-[19px] text-meta text-fg-3">
        <span className="min-w-0 truncate">{sessionTitle(o.root)}</span>
        {o.session.stateSince && (
          <>
            <span aria-hidden>·</span>
            <Elapsed since={o.session.stateSince} settled className="shrink-0" />
          </>
        )}
      </span>
    </button>
  );
}
