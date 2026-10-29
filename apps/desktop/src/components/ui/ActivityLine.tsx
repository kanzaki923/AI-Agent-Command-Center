import { AnimatePresence, motion } from 'motion/react';
import { useActivity } from '../../daemon/queries';
import { cn } from '../../lib/cn';

/**
 * "What it is doing now": old text leaves in 120ms, new text rises 4px (§3.2). Updates are
 * throttled to 4/s upstream (activity store).
 */
export function ActivityLine({
  runId,
  fallback,
  className,
}: {
  runId: string | null | undefined;
  fallback: string | null;
  className?: string;
}) {
  const activity = useActivity(runId);
  const text = activity?.text ?? fallback;
  const key = activity ? `a${activity.rev}` : `f:${fallback ?? ''}`;
  return (
    <span className={cn('relative block h-5 min-w-0 overflow-hidden', className)}>
      <AnimatePresence initial={false} mode="wait">
        {text && (
          <motion.span
            key={key}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="block truncate"
          >
            {text}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
