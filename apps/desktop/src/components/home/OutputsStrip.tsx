import { Inbox } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '../../lib/cn';
import { sessionTitle } from '../../lib/states';
import { useUnread } from '../../store/ui';
import { Elapsed } from '../ui/Elapsed';
import { OutputIcon } from '../ui/SemanticIcons';
import type { HomeOutput } from './layout';

/**
 * できたもの (ui-rework spec §3.2): what the agents delivered, newest first. A heading row in
 * the lanes' own shape (icon, name), then one line per piece — kind, title, which tree, when —
 * so the pieces read as documents, not as another lane of people: a single line, regular
 * weight, the small radius. One waiting for a decision wears the review colour; one not yet
 * opened keeps the brighter title. Pressing a piece opens its conversation (the outputs panel
 * shows it). A new piece slides in from the right. Nothing at all when nothing was delivered.
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
    <section aria-label="できたもの" className="flex flex-col gap-2" data-outputs-strip>
      <div className="flex h-7 items-center gap-2">
        <Inbox size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-st-done" />
        <span className="px-1 text-ui font-medium text-fg-2">できたもの</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <AnimatePresence initial={false}>
          {outputs.map((o) => (
            <motion.div
              key={o.id}
              layout="position"
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="min-w-0 max-w-full"
            >
              <OutputRow output={o} onOpen={onOpen} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
}

function OutputRow({
  output: o,
  onOpen,
}: {
  output: HomeOutput;
  onOpen: (sessionId: string) => void;
}) {
  const unread = useUnread(o.session);
  const bright = unread || o.review;
  return (
    <button
      type="button"
      data-home-output={o.id}
      data-review={o.review || undefined}
      onClick={() => onOpen(o.session.id)}
      className={cn(
        'flex h-9 max-w-full items-center gap-2 rounded-sm border bg-surface pr-3 pl-2.5 text-left hover:bg-raised',
        o.review ? '' : 'border-transparent',
      )}
      style={
        o.review
          ? { borderColor: 'color-mix(in oklch, var(--st-review) 60%, transparent)' }
          : undefined
      }
    >
      <OutputIcon
        kind={o.kind}
        size={14}
        className={cn('shrink-0', o.review ? 'text-st-review' : 'text-fg-3')}
      />
      <span
        className={cn(
          'min-w-0 max-w-64 truncate text-ui',
          bright ? 'font-medium text-fg' : 'text-fg-2',
        )}
      >
        {o.title}
      </span>
      <span className="flex min-w-0 shrink items-center gap-1.5 text-meta text-fg-3">
        <span className="min-w-0 max-w-40 truncate">{sessionTitle(o.root)}</span>
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
