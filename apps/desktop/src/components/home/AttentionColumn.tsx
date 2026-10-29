import type { Attention } from '@acc/protocol';
import { AnimatePresence, motion } from 'motion/react';
import type { AttentionAnswer } from '../../daemon/attention';
import { AttentionRow } from '../ui/AttentionRow';
import { LAYOUT_SPRING } from './Lane';

/**
 * Where the human is needed (spec §3.1): open attention items by priority, one row each. New
 * ones slide in from above (180ms); an answered row fades out and the rest close up. With
 * nothing open the column is not there at all.
 */
export function AttentionColumn({
  shown,
  more,
  titles,
  selectedId,
  onRespond,
  onShowAll,
}: {
  shown: Attention[];
  more: number;
  titles: Map<string, string>;
  selectedId: string | null;
  onRespond: (a: Attention, answer: AttentionAnswer) => void;
  onShowAll: () => void;
}) {
  if (shown.length === 0) return null;
  return (
    <section aria-label="出番" className="flex flex-col gap-1.5">
      <AnimatePresence initial={false}>
        {shown.map((a) => (
          <motion.div
            key={a.id}
            layout="position"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1], layout: LAYOUT_SPRING }}
          >
            <AttentionRow
              attention={a}
              sessionTitle={titles.get(a.sessionId)}
              selected={selectedId === a.id}
              onRespond={onRespond}
            />
          </motion.div>
        ))}
      </AnimatePresence>
      {more > 0 && (
        <button
          type="button"
          onClick={onShowAll}
          className="self-start rounded-sm px-2 py-0.5 text-meta text-fg-2 hover:bg-hover hover:text-fg"
        >
          あと {more} 件
        </button>
      )}
    </section>
  );
}
