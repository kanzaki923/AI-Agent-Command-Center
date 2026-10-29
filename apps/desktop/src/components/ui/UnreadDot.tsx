import { cn } from '../../lib/cn';

/** A conversation whose answer arrived after you last looked at it (store isUnread). */
export function UnreadDot({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="未読"
      data-unread
      className={cn('inline-block size-1.5 shrink-0 rounded-full bg-accent', className)}
    />
  );
}
