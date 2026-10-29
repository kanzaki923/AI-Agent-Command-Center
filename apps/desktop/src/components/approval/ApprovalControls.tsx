import type { Approval } from '@acc/protocol';
import { Check, Repeat, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type KeyboardEvent, useState } from 'react';
import { approve, reject } from '../../app/commands';
import { usePermissionRules } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { claimKeyDecision } from '../../lib/approvalKeys';
import { formatClock } from '../../lib/format';
import { matchShortcut } from '../../lib/shortcuts';
import { cn } from '../../lib/cn';
import { type ApprovalView, RISK_LABEL, describeApproval } from '../../model/approval';
import {
  REMEMBERED_TEXT,
  type RememberScope,
  canRemember,
  rememberHint,
  rememberOptions,
} from '../../model/permissions';
import { Button } from '../ui/Button';

/**
 * Impact line under an approval's evidence, led by the daemon's risk rating when it gave
 * one (`危険度 高` in the failed colour: these need Ctrl+Y).
 */
export function RiskNote({ view }: { view: ApprovalView }) {
  const level = view.riskLevel && view.riskLevel !== 'low' ? view.riskLevel : view.risk === 'high' ? 'high' : null;
  if (!view.scope && !level && !view.why) return null;
  const high = view.risk === 'high' || level === 'high';
  const color = high ? 'var(--st-failed)' : 'var(--st-awaiting_approval)';
  return (
    <p className={cn('flex items-center gap-2 text-meta', high ? 'text-st-failed' : 'text-fg-3')} data-testid="risk-note">
      {level && (
        <span className="shrink-0 rounded-xs px-1.5 py-px text-micro" style={{ color, background: `color-mix(in oklch, ${color} 14%, transparent)` }}>
          {RISK_LABEL[level]}
        </span>
      )}
      {view.scope}
      {/* Why the daemon asked instead of deciding: approvals are the exception, so say why. */}
      {view.why && <span className="text-fg-3">{view.scope || level ? `· ${view.why}` : view.why}</span>}
    </p>
  );
}

/** "承認しました · 14:03" — what remains after a decision (§3.2). */
export function ResolvedLine({ approval }: { approval: Approval }) {
  const ok = approval.status === 'approved';
  // What the daemon actually remembered (its rule), not what the click asked for.
  const rules = usePermissionRules(ok && approval.kind === 'tool_use' ? approval.projectId : null).data;
  const remembered = rules?.find((r) => r.approvalId === approval.id) ?? null;
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="flex items-center gap-1.5 overflow-hidden text-meta text-fg-3"
    >
      {ok ? <Check size={13} strokeWidth={1.75} /> : <X size={13} strokeWidth={1.75} />}
      {ok ? '承認しました' : '拒否しました'}
      {remembered && (
        <span className="flex items-center gap-1" data-testid="remembered-scope">
          · <Repeat size={11} strokeWidth={1.75} />
          {REMEMBERED_TEXT[remembered.scope]}
        </span>
      )}
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
export function useApprovalControls(
  approval: Approval | null,
  view: ApprovalView | null,
  /** `E`: show the details (the card opens the detail panel). */
  onExpand?: () => void,
) {
  const rt = useRuntime();
  const connected = useConnectionState() === 'open';
  const [rejecting, setRejecting] = useState(false);
  const [remembering, setRemembering] = useState(false);
  const [note, setNote] = useState('');
  const high = view?.risk === 'high';
  const rememberable = !!approval && !!view && canRemember(approval, view);
  const options = approval ? rememberOptions(approval) : [];

  const doApprove = (remember?: RememberScope) => {
    if (!approval || !connected) return;
    setRemembering(false);
    void approve(rt, approval, remember);
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
      if (claimKeyDecision(e)) doApprove();
    } else if (matchShortcut(e, 'reject')) {
      e.preventDefault();
      if (claimKeyDecision(e)) setRejecting(true);
    } else if (rememberable && matchShortcut(e, 'approveAlways')) {
      // Opens the scope choice; approving still takes a second, deliberate key.
      e.preventDefault();
      if (!e.repeat) setRemembering(true);
    } else if (onExpand && matchShortcut(e, 'expand')) {
      e.preventDefault();
      onExpand();
    }
  };

  const disabledHint = connected ? undefined : 'Core Daemon に接続していないため操作できません';

  const firstAvailable = options.findIndex((x) => x.available);
  const rememberChooser = (
    <motion.div
      key="remember"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      className="flex flex-col gap-1.5"
      data-testid="remember-chooser"
      onKeyDown={(e) => {
        const opt = options.find((o) => o.available && matchShortcut(e, o.shortcut));
        if (opt) {
          e.preventDefault();
          e.stopPropagation();
          if (claimKeyDecision(e)) doApprove(opt.scope);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setRemembering(false);
        } else if (e.key !== 'Tab' && e.key !== 'Enter' && e.key !== ' ' && !e.key.startsWith('Arrow') && !e.ctrlKey && !e.metaKey) {
          // Nothing else means anything here (Y / N / j / k would act on the card or list).
          e.stopPropagation();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-meta text-fg-2">承認して、今後は確認しない範囲</span>
        {options.map((o, i) => (
          <Button
            key={o.scope}
            size="md"
            variant={i === firstAvailable ? 'primary' : 'secondary'}
            shortcut={o.shortcut}
            autoFocus={i === firstAvailable}
            disabled={!connected || !o.available}
            hint={o.unavailable ?? disabledHint}
            onClick={() => doApprove(o.scope)}
            data-remember={o.scope}
          >
            {o.label}
          </Button>
        ))}
        <Button size="md" variant="ghost" onClick={() => setRemembering(false)}>
          キャンセル
        </Button>
      </div>
      {view && <p className="text-meta text-fg-3">{rememberHint(view)}</p>}
    </motion.div>
  );

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
      ) : remembering ? (
        rememberChooser
      ) : (
        <motion.div
          key="buttons"
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          className="flex items-center gap-2"
        >
          <Button
            variant={high ? 'danger' : 'primary'}
            shortcut={high ? 'approveDanger' : 'approve'}
            onClick={() => doApprove()}
            disabled={!connected}
            hint={disabledHint}
          >
            {high ? '承認（要注意）' : '承認'}
          </Button>
          <Button shortcut="reject" onClick={() => setRejecting(true)} disabled={!connected} hint={disabledHint}>
            拒否
          </Button>
          {rememberable && (
            <Button
              variant="ghost"
              shortcut="approveAlways"
              icon={<Repeat size={12} strokeWidth={1.75} />}
              onClick={() => setRemembering(true)}
              disabled={!connected}
              hint={disabledHint ?? '承認して、この Run・Task・プロジェクトでは同じ操作を確認しないようにします'}
              data-testid="approve-always"
            >
              今後も許可…
            </Button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  ) : null;

  return { controls, onKeyDown, rejecting, remembering };
}

/**
 * The approval card inside a flow (§5.2): the chat at the point it was requested, and the
 * integration review for its test step. Y / N / A while it has focus.
 */
export function InlineApproval({ approval }: { approval: Approval }) {
  const view = describeApproval(approval);
  const pending = approval.status === 'pending';
  const { controls, onKeyDown } = useApprovalControls(pending ? approval : null, view);
  const barColor =
    approval.status === 'pending'
      ? 'var(--st-awaiting_approval)'
      : approval.status === 'approved'
        ? 'var(--border-strong)'
        : 'var(--border-strong)';
  return (
    <div
      tabIndex={pending ? 0 : -1}
      onKeyDown={onKeyDown}
      data-approval={approval.id}
      className="relative flex flex-col gap-2 rounded-sm py-1 pl-4 outline-none focus-visible:bg-hover"
    >
      <span className="absolute top-0 bottom-0 left-0 w-0.5 rounded-full" style={{ background: barColor }} />
      <div className={cn('text-ui font-medium', pending ? 'text-fg' : 'text-fg-3')}>{view.question}</div>
      {view.target && (
        <pre className="selectable overflow-x-auto rounded-sm border border-line-subtle bg-canvas px-2.5 py-1.5 font-mono text-code text-fg whitespace-pre-wrap">
          {view.targetKind === 'command' ? `$ ${view.target}` : view.target}
        </pre>
      )}
      {pending && <RiskNote view={view} />}
      {pending ? controls : <ResolvedLine approval={approval} />}
    </div>
  );
}
