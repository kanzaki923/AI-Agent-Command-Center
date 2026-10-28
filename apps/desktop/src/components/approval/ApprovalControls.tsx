import type { Approval } from '@acc/protocol';
import { Check, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type KeyboardEvent, useState } from 'react';
import { approve, reject } from '../../app/commands';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { formatClock } from '../../lib/format';
import { matchShortcut } from '../../lib/shortcuts';
import type { ApprovalView } from '../../model/approval';
import { Button } from '../ui/Button';

/** "承認しました · 14:03" — what remains after a decision (§3.2). */
export function ResolvedLine({ approval }: { approval: Approval }) {
  const ok = approval.status === 'approved';
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="flex items-center gap-1.5 overflow-hidden text-meta text-fg-3"
    >
      {ok ? <Check size={13} strokeWidth={1.75} /> : <X size={13} strokeWidth={1.75} />}
      {ok ? '承認しました' : '拒否しました'}
      {approval.resolvedAt && <span className="tabular">· {formatClock(approval.resolvedAt)}</span>}
      {approval.resolutionNote && <span className="truncate">· {approval.resolutionNote}</span>}
    </motion.div>
  );
}

export interface ApprovalKeys {
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}

/**
 * Approve / reject buttons + the reject-reason input. Returns the key handler for the
 * card that hosts it (Y / N / Ctrl+Y on the focused card, §7.2). Esc never decides.
 */
export function useApprovalControls(approval: Approval | null, view: ApprovalView | null) {
  const rt = useRuntime();
  const connected = useConnectionState() === 'open';
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const high = view?.risk === 'high';

  const doApprove = () => {
    if (!approval || !connected) return;
    void approve(rt, approval);
  };
  const doReject = () => {
    if (!approval || !connected) return;
    setRejecting(false);
    void reject(rt, approval, note.trim() || undefined);
    setNote('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!approval || e.target !== e.currentTarget) return;
    if (high ? matchShortcut(e, 'approveDanger') : matchShortcut(e, 'approve')) {
      e.preventDefault();
      doApprove();
    } else if (matchShortcut(e, 'reject')) {
      e.preventDefault();
      setRejecting(true);
    }
  };

  const disabledHint = connected ? undefined : 'Core Daemon に接続していないため操作できません';

  const controls = approval ? (
    <AnimatePresence initial={false} mode="popLayout">
      {rejecting ? (
        <motion.form
          key="reject"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            doReject();
          }}
        >
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setRejecting(false);
              }
            }}
            placeholder="拒否の理由（任意）· Enter で拒否"
            className="h-7 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-2 text-ui text-fg placeholder:text-fg-4 focus:border-[var(--focus-ring)]"
          />
          <Button type="submit" size="md" variant="secondary">
            拒否する
          </Button>
          <Button size="md" variant="ghost" onClick={() => setRejecting(false)}>
            キャンセル
          </Button>
        </motion.form>
      ) : (
        <motion.div
          key="buttons"
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          className="flex items-center gap-2"
        >
          <Button
            variant={high ? 'danger' : 'primary'}
            shortcut={high ? 'approveDanger' : 'approve'}
            onClick={doApprove}
            disabled={!connected}
            hint={disabledHint}
          >
            {high ? '承認（要注意）' : '承認'}
          </Button>
          <Button shortcut="reject" onClick={() => setRejecting(true)} disabled={!connected} hint={disabledHint}>
            拒否
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  ) : null;

  return { controls, onKeyDown, rejecting };
}
