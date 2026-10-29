import type { HomeTree, SessionCard } from '@acc/protocol';
import { Clock } from 'lucide-react';
import { motion } from 'motion/react';
import { useSlowNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { formatNextRun, sessionTitle } from '../../lib/states';
import { useUnread } from '../../store/ui';
import { CostMeter } from '../ui/CostMeter';
import { RoleIcon } from '../ui/SemanticIcons';
import { SessionChip } from '../ui/SessionChip';
import { StateIcon } from '../ui/StateIcon';
import { UnreadDot } from '../ui/UnreadDot';
import { StateBand } from './StateBand';
import type { LaneShape } from './layout';

/** motion's layout move (ui-design §3.1 spring.layout). */
export const LAYOUT_SPRING = { type: 'spring', stiffness: 500, damping: 40, mass: 1 } as const;

/** Root states the heading repeats next to the title; the rest are told by the role icon and the chips. */
const ROOT_STATE_SHOWN = new Set(['needs_you', 'failed', 'working', 'queued', 'stopped']);

/**
 * One tree (spec §3.1): a heading line (role, title, the state band, next run, spend) and its
 * children as chips. A tree without children, or a settled one (`compact`), is its heading
 * alone; a childless tree shows its root's state (and what it is doing) beside the title.
 */
export function Lane({
  tree,
  shape,
  selectedId,
  onOpen,
}: {
  tree: HomeTree;
  shape: LaneShape;
  selectedId: string | null;
  onOpen: (sessionId: string) => void;
}) {
  const { root } = tree;
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const chips = shape.chips.map((id) => byId.get(id)).filter((c): c is SessionCard => !!c);
  const hasChildren = chips.length > 0 || tree.hiddenNodes > 0;
  const folded = shape.compact || !hasChildren;
  const showRootState = hasChildren ? ROOT_STATE_SHOWN.has(root.state) : root.state !== 'idle';
  const title = sessionTitle(root);
  const unread = useUnread(root);

  return (
    <section aria-label={title} data-lane={root.id} data-compact={shape.compact || undefined} className="flex flex-col gap-2">
      <div className="flex h-7 min-w-0 items-center gap-2">
        <RoleIcon role={root.role} scheduled={root.startedBy === 'schedule'} className={cn('text-fg-3', shape.compact && 'opacity-60')} />
        <button
          type="button"
          data-lane-root={root.id}
          data-selected={selectedId === root.id || undefined}
          onClick={() => onOpen(root.id)}
          className={cn(
            'min-w-0 shrink truncate rounded-sm px-1 text-ui font-medium hover:bg-hover',
            shape.compact && !unread ? 'text-fg-2' : 'text-fg',
            selectedId === root.id && 'ring-2 ring-[var(--focus-ring)]',
          )}
        >
          {title}
        </button>
        {unread && <UnreadDot />}
        {showRootState && <StateIcon state={root.state} />}
        {!hasChildren && root.now && root.state === 'working' && (
          <span className="min-w-0 truncate text-meta text-fg-2">{root.now}</span>
        )}
        <span className="min-w-4 flex-1" />
        <LaneFacts tree={tree} withBand={hasChildren} />
      </div>
      {!folded && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-2">
          {chips.map((c) => (
            <motion.div key={c.id} layout="position" transition={{ layout: LAYOUT_SPRING }} className="min-w-0">
              <SessionChip card={c} selected={selectedId === c.id} onOpen={onOpen} className="w-full" />
            </motion.div>
          ))}
          {tree.hiddenNodes > 0 && (
            <button
              type="button"
              aria-label={`ほか ${tree.hiddenNodes}`}
              onClick={() => onOpen(root.id)}
              className="flex h-[66px] items-center justify-center rounded-md border border-dashed border-line text-ui text-fg-2 tabular hover:bg-hover"
            >
              +{tree.hiddenNodes}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The right end of a heading, in fixed columns so they line up from lane to lane: the state
 * band, the next scheduled run and the tree's spend (against its budget when it has one).
 */
function LaneFacts({ tree, withBand }: { tree: HomeTree; withBand: boolean }) {
  const now = useSlowNow();
  return (
    <span className="flex shrink-0 items-center gap-4">
      <span className="flex w-[120px] justify-end">{withBand && <StateBand counts={tree.counts} />}</span>
      <span className="flex w-[84px] items-center justify-end gap-1 text-meta text-fg-3">
        {tree.nextRunAt && (
          <>
            <Clock size={12} strokeWidth={1.75} aria-label="次回" />
            <span className="tabular whitespace-nowrap">{formatNextRun(tree.nextRunAt, now)}</span>
          </>
        )}
      </span>
      <span className="flex w-[150px] justify-end">
        <CostMeter usedUsd={tree.spend.treeUsd} limitUsd={tree.spend.limitUsd} committedUsd={tree.spend.committedUsd} estimated={tree.spend.estimated} />
      </span>
    </span>
  );
}
