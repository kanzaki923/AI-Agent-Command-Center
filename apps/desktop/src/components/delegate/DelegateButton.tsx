import { Diamond } from 'lucide-react';
import { delegateSession, undelegateSession } from '../../daemon/actions';
import { useRuntime } from '../../daemon/runtime';
import { treeRelations, useSessionTree } from '../../daemon/tree';
import { cn } from '../../lib/cn';
import { IconButton } from '../ui/Button';

/**
 * 任せる (spec §7): one press delegates with the daemon's defaults (no dialog). While
 * delegated the diamond is filled. Owned by track U5 (the popover with budget / children /
 * workspace / 任せるのをやめる); this entry point keeps its props fixed: `sessionId`.
 * Minimal behaviour until then: press again to take it back.
 */
export function DelegateButton({ sessionId, className }: { sessionId: string; className?: string }) {
  const rt = useRuntime();
  const tree = useSessionTree(sessionId).data;
  const delegated = treeRelations(tree, sessionId).self?.role === 'supervisor';
  return (
    <IconButton
      label={delegated ? '任せるのをやめる' : '任せる'}
      aria-pressed={delegated}
      className={cn(delegated && 'text-st-supervising', className)}
      onClick={() => void (delegated ? undelegateSession(rt, sessionId) : delegateSession(rt, sessionId))}
    >
      <Diamond size={15} strokeWidth={1.75} fill={delegated ? 'currentColor' : 'none'} />
    </IconButton>
  );
}
