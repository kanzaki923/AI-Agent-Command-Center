import type { HomeTree, SessionCard } from '@acc/protocol';
import { Clock } from 'lucide-react';
import { motion } from 'motion/react';
import { useSlowNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { OUTPUT_META, budgetTone, formatNextRun, sessionTitle } from '../../lib/states';
import { useUnread } from '../../store/ui';
import { CostMeter } from '../ui/CostMeter';
import { OutputIcon, RoleIcon } from '../ui/SemanticIcons';
import { SessionChip } from '../ui/SessionChip';
import { StateIcon } from '../ui/StateIcon';
import { Tooltip } from '../ui/Tooltip';
import { UnreadDot } from '../ui/UnreadDot';
import { StateBand } from './StateBand';
import { type LaneShape, costNote, outputCounts, showLaneCost } from './layout';

/** motion's layout move (ui-design §3.1 spring.layout). */
export const LAYOUT_SPRING = { type: 'spring', stiffness: 500, damping: 40, mass: 1 } as const;

/** A chip being born (ui-rework spec §2): fades and rises in; siblings born together follow 60ms apart. */
export const BORN = { duration: 0.22, ease: [0.16, 1, 0.3, 1] as const, stagger: 0.06 };

/** Root states the heading repeats next to the title; the rest are told by the role icon and the chips. */
const ROOT_STATE_SHOWN = new Set(['needs_you', 'failed', 'working', 'queued', 'stopped']);

/**
 * Chips already shown once in this app session: only chips that are new to the screen are
 * born with motion (coming back to home must not replay every chip). Module state on purpose.
 */
const SEEN_CHIPS = new Set<string>();

/**
 * One tree (ui-rework spec §3.1): a heading (role, title, progress, the state band, what came
 * out of it, next run, spend only past half the budget), the human's own words under it, and
 * its children as chips. A tree without children, or a settled one (`compact`), is its
 * heading alone; a childless tree shows its root's state (and what it is doing) beside the
 * title.
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
  const busy = tree.counts.working > 0 || tree.counts.queued > 0;
  const goal = tree.goal && tree.goal !== title && hasChildren && !shape.compact ? tree.goal : null;

  // Which chips are new to the screen this render: they are born in order, 60ms apart.
  let bornIndex = 0;
  const birth = new Map<string, number>();
  for (const c of chips) {
    if (SEEN_CHIPS.has(c.id)) continue;
    birth.set(c.id, bornIndex++);
    SEEN_CHIPS.add(c.id);
  }

  return (
    <section aria-label={title} data-lane={root.id} data-compact={shape.compact || undefined} className="flex flex-col gap-2">
      <div className="flex flex-col">
        <div className="flex h-7 min-w-0 items-center gap-2">
          <RoleIcon
            role={root.role}
            scheduled={root.startedBy === 'schedule'}
            className={cn(
              root.role === 'supervisor' ? 'text-st-supervising' : 'text-fg-3',
              root.role === 'supervisor' && busy && 'acc-breathe',
              shape.compact && 'opacity-60',
            )}
          />
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
          <LaneFacts tree={tree} withBand={hasChildren} childCount={chips.length + tree.hiddenNodes} />
        </div>
        {goal && (
          <div className="min-w-0 truncate pl-6 text-meta text-fg-3" data-lane-goal>
            {goal}
          </div>
        )}
      </div>
      {!folded && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(184px,1fr))] gap-2">
          {chips.map((c) => {
            const born = birth.get(c.id);
            return (
              <motion.div
                key={c.id}
                layout="position"
                initial={born === undefined ? false : { opacity: 0, y: 6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{
                  layout: LAYOUT_SPRING,
                  opacity: { duration: BORN.duration, ease: BORN.ease, delay: (born ?? 0) * BORN.stagger },
                  y: { duration: BORN.duration, ease: BORN.ease, delay: (born ?? 0) * BORN.stagger },
                  scale: { duration: BORN.duration, ease: BORN.ease, delay: (born ?? 0) * BORN.stagger },
                }}
                className="min-w-0"
              >
                <SessionChip card={c} selected={selectedId === c.id} onOpen={onOpen} className="w-full" />
              </motion.div>
            );
          })}
          {tree.hiddenNodes > 0 && (
            <button
              type="button"
              aria-label={`ほか ${tree.hiddenNodes}`}
              onClick={() => onOpen(root.id)}
              className="flex h-14 items-center justify-center rounded-md border border-dashed border-line text-ui text-fg-2 tabular hover:bg-hover"
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
 * The right end of a heading, in fixed columns so they line up from lane to lane: progress
 * (finished / children), the state band (its tooltip carries the spend), what came out of the
 * tree, the next scheduled run, and the budget meter only once half of it is used.
 */
function LaneFacts({ tree, withBand, childCount }: { tree: HomeTree; withBand: boolean; childCount: number }) {
  const now = useSlowNow();
  const finished = tree.counts.done + tree.counts.review;
  const outputs = outputCounts(tree.nodes).slice(0, 3);
  const note = costNote(tree.spend);
  const showCost = showLaneCost(tree.spend);
  return (
    <span className="flex shrink-0 items-center gap-4">
      {withBand && childCount > 0 && (
        <span className="tabular text-meta text-fg-3 whitespace-nowrap" aria-label="進み具合" data-lane-progress>
          {finished} / {childCount}
        </span>
      )}
      <span className="flex w-[120px] justify-end">{withBand && <StateBand counts={tree.counts} note={note} />}</span>
      <span className="flex w-[72px] items-center justify-end gap-2" data-lane-outputs>
        {outputs.map(({ kind, n }) => (
          <Tooltip key={kind} content={`${OUTPUT_META[kind].label} ${n}`}>
            <span className="flex items-center gap-0.5 text-meta text-fg-3">
              <OutputIcon kind={kind} size={12} />
              {n > 1 && <span className="tabular">{n}</span>}
            </span>
          </Tooltip>
        ))}
      </span>
      <span className="flex w-[84px] items-center justify-end gap-1 text-meta text-fg-3">
        {tree.nextRunAt && (
          <>
            <Clock size={12} strokeWidth={2} aria-label="次回" />
            <span className="tabular whitespace-nowrap">{formatNextRun(tree.nextRunAt, now)}</span>
          </>
        )}
      </span>
      <span className="flex w-[150px] justify-end">
        {showCost && (
          <CostMeter
            usedUsd={tree.spend.treeUsd}
            limitUsd={tree.spend.limitUsd}
            committedUsd={tree.spend.committedUsd}
            estimated={tree.spend.estimated}
          />
        )}
        {!showCost && !withBand && note && tree.spend.limitUsd != null && budgetTone(tree.spend.treeUsd, tree.spend.limitUsd) !== 'ok' && (
          <CostMeter usedUsd={tree.spend.treeUsd} limitUsd={tree.spend.limitUsd} committedUsd={tree.spend.committedUsd} estimated={tree.spend.estimated} />
        )}
      </span>
    </span>
  );
}
