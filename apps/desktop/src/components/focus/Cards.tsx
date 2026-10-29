import type { Approval, SessionBrief, SessionCard, SessionState, WakeItemView } from '@acc/protocol';
import { ChevronRight, Circle, CircleCheck, Coins, CornerDownLeft, ShieldCheck, ShieldX } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useProjects, useWorkspace } from '../../daemon/queries';
import { cn } from '../../lib/cn';
import { formatClock } from '../../lib/format';
import { describeApproval } from '../../model/approval';
import { STATE_META, sessionTitle } from '../../lib/states';
import { useUi } from '../../store/ui';
import { WorkspaceIcon } from '../ui/SemanticIcons';
import { StateIcon } from '../ui/StateIcon';
import { Tooltip } from '../ui/Tooltip';
import { stripMachineBlocks } from './conversation';

const NONE: never[] = [];

/** Last segment of a path (`C:\work\market` → `market`). */
export function pathTail(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

/** Where a session works, as an icon and a short name (nothing for a scratch folder). */
function WorkspaceTag({ workspaceId }: { workspaceId: string | null }) {
  const ws = useWorkspace(workspaceId).data ?? null;
  const projects = useProjects().data ?? NONE;
  if (!ws || ws.kind === 'scratch') return null;
  const code = ws.kind === 'worktree' || ws.kind === 'main';
  const name = code ? (projects.find((p) => p.id === ws.projectId)?.name ?? pathTail(ws.path)) : pathTail(ws.path);
  return (
    <Tooltip content={ws.path}>
      <span className="flex min-w-0 items-center gap-1 text-meta text-fg-3" data-testid="brief-workspace">
        <WorkspaceIcon kind={code ? 'worktree' : 'folder'} size={12} />
        <span className="truncate">{name}</span>
      </span>
    </Tooltip>
  );
}

/**
 * The request card (spec §5.2): what a child was asked to do. The goal (two lines, the rest on
 * click), the conditions for done as a checklist (checked once it has delivered its outputs),
 * and where it works (the budget is in the head, right above). The raw request text and
 * machine blocks stay hidden.
 */
export function BriefCard({
  brief,
  card,
  workspaceId,
}: {
  brief: SessionBrief;
  /** The session's tree card (state, outputs, budget), when known. */
  card: SessionCard | null;
  workspaceId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const goal = stripMachineBlocks(brief.goal);
  const delivered = !!card && card.outputs.length > 0 && (card.state === 'done' || card.state === 'review');
  const long = goal.length > 120 || goal.split('\n').length > 2;
  return (
    <section aria-label="依頼" data-brief className="flex flex-col gap-2 rounded-md border border-line bg-surface px-3.5 py-2.5">
      <div className="flex h-4 items-center gap-3 text-micro text-fg-3">
        <span>依頼</span>
        <span className="flex-1" />
        <WorkspaceTag workspaceId={workspaceId} />
      </div>
      <div
        role={long ? 'button' : undefined}
        tabIndex={long ? 0 : undefined}
        aria-expanded={long ? open : undefined}
        onClick={long ? () => setOpen((v) => !v) : undefined}
        onKeyDown={
          long
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setOpen((v) => !v);
                }
              }
            : undefined
        }
        className={cn('selectable text-chat whitespace-pre-wrap text-fg', !open && 'line-clamp-2', long && 'cursor-pointer')}
      >
        {goal}
      </div>
      {brief.doneWhen.length > 0 && (
        <ul aria-label="完了条件" className="flex flex-col gap-1">
          {brief.doneWhen.map((c, i) => (
            <li key={i} className="flex items-start gap-2 text-ui text-fg-2" data-done={delivered || undefined}>
              {delivered ? (
                <CircleCheck size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-st-done" aria-label="済み" />
              ) : (
                <Circle size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-fg-4" aria-label="未" />
              )}
              <span className="min-w-0">{c}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A change in a wake-up, as the state it moved the child to (or its own mark). */
const CHANGE_STATE: Partial<Record<WakeItemView['change'], SessionState>> = {
  done: 'done',
  failed: 'failed',
  review: 'review',
  needs_you: 'needs_you',
  stopped: 'stopped',
  resume: 'working',
};

function ChangeIcon({ change }: { change: WakeItemView['change'] }) {
  const state = CHANGE_STATE[change];
  if (state) return <StateIcon state={state} size={13} />;
  if (change === 'budget') {
    return (
      <span role="img" aria-label="予算" className="inline-flex text-st-needs_you">
        <Coins size={13} strokeWidth={2} aria-hidden />
      </span>
    );
  }
  return (
    <span role="img" aria-label="回答" className="inline-flex text-fg-2">
      <CornerDownLeft size={13} strokeWidth={2} aria-hidden />
    </span>
  );
}

const CHANGE_LABEL: Record<WakeItemView['change'], string> = {
  done: STATE_META.done.label,
  failed: STATE_META.failed.label,
  review: STATE_META.review.label,
  needs_you: STATE_META.needs_you.label,
  stopped: STATE_META.stopped.label,
  resume: '再開',
  answer: '回答',
  budget: '予算',
};

/**
 * The status card (spec §5.2): a supervisor was woken because children changed. One line of
 * the changes (icon + child); open it for one row per child (press a row to go there).
 */
export function WakeCard({ items }: { items: WakeItemView[] }) {
  const [open, setOpen] = useState(false);
  const openSession = useUi((s) => s.openSession);
  return (
    <section aria-label="状況" data-wake className="rounded-md border border-line-subtle">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-ui text-fg-2 hover:bg-hover"
      >
        <ChevronRight
          size={12}
          strokeWidth={1.75}
          className={cn('shrink-0 text-fg-4 transition-transform duration-[120ms]', open && 'rotate-90')}
        />
        <span className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
          {items.map((it, i) => (
            <span key={`${it.sessionId}:${i}`} className="flex min-w-0 shrink items-center gap-1">
              <ChangeIcon change={it.change} />
              <span className="truncate">{it.title}</span>
            </span>
          ))}
        </span>
      </button>
      {open && (
        <ul className="flex flex-col border-t border-line-subtle py-1">
          {items.map((it, i) => (
            <li key={`${it.sessionId}:${i}`}>
              <button
                type="button"
                onClick={() => openSession(it.sessionId)}
                className="flex h-7 w-full items-center gap-2 px-3 text-left text-ui text-fg-2 hover:bg-hover hover:text-fg"
              >
                <ChangeIcon change={it.change} />
                <span className="min-w-0 flex-1 truncate">{it.title}</span>
                <span className="shrink-0 text-meta text-fg-3">{CHANGE_LABEL[it.change]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What remains of an answered approval in the flow: `🛡✓ 許可 · pnpm add zod`. */
export function ApprovalLine({ approval }: { approval: Approval }) {
  const ok = approval.status === 'approved';
  const Icon = ok ? ShieldCheck : ShieldX;
  const what = describeApproval(approval).target?.split('\n')[0] ?? approval.title;
  return (
    <div className="flex h-6 min-w-0 items-center gap-1.5 text-meta text-fg-3" data-approval-line={approval.status}>
      <Icon size={13} strokeWidth={1.75} className={ok ? undefined : 'text-st-failed'} aria-hidden />
      <span className="shrink-0">{ok ? '許可' : '拒否'}</span>
      <span className="text-fg-4">·</span>
      <span className="min-w-0 truncate font-mono">{what}</span>
      {approval.resolvedAt && <span className="shrink-0 tabular">· {formatClock(approval.resolvedAt)}</span>}
    </div>
  );
}

/** A message not typed here: from the conversation that leads this one, or from a schedule. */
export function FromLine({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <div className="flex h-4 items-center gap-1.5 text-micro text-fg-3">{icon}{children}</div>;
}

/** A session title for display, falling back to its default name. */
export function titleOrDefault(s: { title: string; kind?: 'chat' | 'agent' } | undefined): string | undefined {
  return s ? sessionTitle(s) : undefined;
}
