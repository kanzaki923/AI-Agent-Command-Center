import type { Artifact, Integration } from '@acc/protocol';
import { Bot, Check, CircleCheck, GitMerge, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { approveIntegration, resolveWithAgent } from '../../daemon/orchestration';
import { reviewOutput } from '../../daemon/outputs';
import { useIntegrations } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { useWindowKeydown } from '../../hooks/useWindowKeydown';
import { cn } from '../../lib/cn';
import { overlayOpen } from '../../lib/overlay';
import { canResolveWithAgent, isResolving } from '../../model/integration';
import { Button } from '../ui/Button';
import { StateIcon } from '../ui/StateIcon';
import { Tooltip } from '../ui/Tooltip';
import { type ReviewPhase, reviewPhase } from './model';

const NONE: Integration[] = [];

/** What was just sent from this bar, shown until the daemon's events catch up. */
type Sent = { kind: 'accept'; integrationId: string | null } | { kind: 'redo' } | null;

/**
 * The phase an output is in, with what this window just decided laid over it until the data
 * says the same (an adoption shows as applying / adopted at once, a redo as sent back).
 */
export function useReviewPhase(output: Artifact, sent: Sent): ReviewPhase {
  const integrations = useIntegrations().data ?? NONE;
  const phase = reviewPhase(output, integrations);
  if (!sent) return phase;
  if (sent.kind === 'redo') return phase.kind === 'adopted' ? phase : { kind: 'sent_back' };
  if (phase.kind !== 'waiting') return phase;
  if (output.kind !== 'diff') return { kind: 'adopted' };
  const integ = integrations.find((i) => i.id === sent.integrationId);
  // The integration the adoption started was cancelled or rejected: decide again.
  if (integ && (integ.status === 'rejected' || integ.status === 'cancelled')) return phase;
  return { kind: 'applying', integration: integ ?? ({ id: sent.integrationId } as Integration) };
}

/** A small mark of the phase for list rows (shape and colour; nothing when undecided-free). */
export function PhaseMark({ phase, size = 12 }: { phase: ReviewPhase; size?: number }) {
  switch (phase.kind) {
    case 'waiting':
      return <StateIcon state="review" size={size} />;
    case 'applying':
      return <StateIcon state="working" size={size} />;
    case 'apply_wait':
      return <StateIcon state="needs_you" size={size} />;
    case 'apply_failed':
      return <StateIcon state="failed" size={size} />;
    case 'adopted':
      return <StateIcon state="done" size={size} />;
    case 'sent_back':
      return (
        <span role="img" aria-label="やり直し中" className="inline-flex shrink-0 text-fg-3">
          <RotateCcw size={size} strokeWidth={2} aria-hidden />
        </span>
      );
    default:
      return null;
  }
}

function failureLabel(i: Integration): string {
  if (i.status === 'conflict') return '競合';
  if (i.error?.code === 'tests_failed' || i.error?.code === 'tests_timed_out') return 'テスト失敗';
  return '反映できません';
}

/** Left side of the bar: where the decision stands (icon + noun phrase, the reason on hover). */
function PhaseStatus({
  phase,
  code,
  note,
}: {
  phase: ReviewPhase;
  code: boolean;
  note: string | null;
}) {
  switch (phase.kind) {
    case 'applying':
      return (
        <span className="flex items-center gap-1.5 text-ui text-fg-2" data-phase="applying">
          <StateIcon state="working" size={14} />
          {isResolving(phase.integration) ? '競合を解消中' : '反映中'}
        </span>
      );
    case 'apply_wait':
      return (
        <Tooltip content={phase.integration.error?.message}>
          <span
            className="flex items-center gap-1.5 text-ui text-st-needs_you"
            data-phase="apply_wait"
          >
            <TriangleAlert size={14} strokeWidth={1.75} aria-hidden />
            反映待ち
          </span>
        </Tooltip>
      );
    case 'apply_failed':
      return (
        <Tooltip content={phase.integration.error?.message}>
          <span
            className="flex items-center gap-1.5 text-ui text-st-failed"
            data-phase="apply_failed"
          >
            <TriangleAlert size={14} strokeWidth={1.75} aria-hidden />
            {failureLabel(phase.integration)}
          </span>
        </Tooltip>
      );
    case 'adopted':
      return (
        <span className="flex items-center gap-1.5 text-ui text-st-done" data-phase="adopted">
          <CircleCheck size={14} strokeWidth={2} aria-hidden />
          {code ? '反映済み' : '採用済み'}
        </span>
      );
    case 'sent_back':
      return (
        <Tooltip content={note}>
          <span className="flex items-center gap-1.5 text-ui text-fg-3" data-phase="sent_back">
            <RotateCcw size={14} strokeWidth={1.75} aria-hidden />
            やり直し中
          </span>
        </Tooltip>
      );
    default:
      return null;
  }
}

/**
 * The decision on one output (ui-redesign spec §6): 採用 / やり直す while it waits; for code,
 * adopting applies it (反映) and the bar follows that. A change that conflicts with what was
 * applied meanwhile offers 解消を任せる (an agent merges both; then 反映 again). やり直す takes
 * an optional note (Enter sends, Esc cancels). Nothing is shown for an output nobody has to
 * decide on.
 */
export function ReviewBar({
  output,
  size = 'panel',
  onDecide,
  className,
}: {
  output: Artifact;
  /** `full`: the expanded code view (taller, Ctrl+Enter shown on the primary action). */
  size?: 'panel' | 'full';
  /** Called when 採用 or やり直す is sent (the panel keeps the decided output in view). */
  onDecide?: () => void;
  className?: string;
}) {
  const rt = useRuntime();
  const connected = useConnectionState() === 'open';
  const [sent, setSent] = useState<Sent>(null);
  const [redoOpen, setRedoOpen] = useState(false);
  const [note, setNote] = useState('');
  const phase = useReviewPhase(output, sent);
  const code = output.kind === 'diff';
  const full = size === 'full';

  const adopt = () => {
    onDecide?.();
    setSent({ kind: 'accept', integrationId: null });
    void reviewOutput(rt, output.id, 'accept').then((r) =>
      setSent(r ? { kind: 'accept', integrationId: r.integrationId } : null),
    );
  };
  const redo = () => {
    const text = note.trim();
    setRedoOpen(false);
    setNote('');
    onDecide?.();
    setSent({ kind: 'redo' });
    void reviewOutput(rt, output.id, 'redo', text || undefined).then((r) => {
      if (!r) setSent(null);
    });
  };
  const apply = (integ: Integration) => void approveIntegration(rt, integ);
  /** A conflict an agent can resolve (the merge that conflicted is recorded). */
  const conflict =
    phase.kind === 'apply_failed' && canResolveWithAgent(phase.integration) ? phase.integration : null;
  const resolve = (integ: Integration) => void resolveWithAgent(rt, integ);
  const canRedo =
    phase.kind === 'waiting' || phase.kind === 'apply_failed' || phase.kind === 'apply_wait';

  useWindowKeydown((e) => {
    // The expanded view's one primary action (like the old 承認して反映).
    if (!full || !connected || redoOpen || e.defaultPrevented || overlayOpen()) return;
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    if (phase.kind === 'waiting') {
      e.preventDefault();
      adopt();
    } else if (phase.kind === 'apply_wait') {
      e.preventDefault();
      apply(phase.integration);
    } else if (conflict) {
      e.preventDefault();
      resolve(conflict);
    }
  });

  if (phase.kind === 'none') return null;

  return (
    <div
      className={cn('flex shrink-0 flex-col border-t border-line-subtle bg-canvas', className)}
      data-review-bar={output.id}
      data-phase={phase.kind}
    >
      {redoOpen && (
        <div className={cn('flex items-start gap-2 pt-2', full ? 'px-6' : 'px-3')}>
          <textarea
            autoFocus
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                redo();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setRedoOpen(false);
              }
            }}
            aria-label="直してほしいこと"
            placeholder="直してほしいこと"
            className="min-w-0 flex-1 resize-none rounded-sm border border-line bg-surface px-2.5 py-1.5 text-ui text-fg placeholder:text-fg-4 focus:border-[var(--focus-ring)]"
          />
          <button
            type="button"
            aria-label="やめる"
            onClick={() => setRedoOpen(false)}
            className="mt-1 inline-flex size-6 items-center justify-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg"
          >
            <X size={14} strokeWidth={1.75} />
          </button>
        </div>
      )}
      <div className={cn('flex items-center gap-2', full ? 'h-14 px-6' : 'h-12 px-3')}>
        <div className="min-w-0 flex-1">
          <PhaseStatus phase={phase} code={code} note={output.review.note} />
        </div>
        {canRedo && (
          <Button
            variant={redoOpen ? 'primary' : 'ghost'}
            size={full ? 'lg' : 'md'}
            icon={<RotateCcw size={13} strokeWidth={1.75} />}
            disabled={!connected}
            onClick={() => (redoOpen ? redo() : setRedoOpen(true))}
          >
            やり直す
          </Button>
        )}
        {phase.kind === 'waiting' && !redoOpen && (
          <Button
            variant="primary"
            size={full ? 'lg' : 'md'}
            icon={<Check size={14} strokeWidth={2} />}
            shortcutKeys={full ? 'Mod+Enter' : undefined}
            hint={code ? '採用して反映' : undefined}
            disabled={!connected}
            onClick={adopt}
            data-action="adopt"
          >
            採用
          </Button>
        )}
        {conflict && !redoOpen && (
          <Button
            variant="primary"
            size={full ? 'lg' : 'md'}
            icon={<Bot size={14} strokeWidth={1.75} />}
            shortcutKeys={full ? 'Mod+Enter' : undefined}
            hint="エージェントに競合の解消を任せる"
            disabled={!connected}
            onClick={() => resolve(conflict)}
            data-action="resolve"
          >
            解消を任せる
          </Button>
        )}
        {phase.kind === 'apply_wait' && !redoOpen && (
          <Button
            variant="primary"
            size={full ? 'lg' : 'md'}
            icon={<GitMerge size={14} strokeWidth={1.75} />}
            shortcutKeys={full ? 'Mod+Enter' : undefined}
            disabled={!connected}
            onClick={() => apply(phase.integration)}
            data-action="apply"
          >
            反映
          </Button>
        )}
      </div>
    </div>
  );
}
