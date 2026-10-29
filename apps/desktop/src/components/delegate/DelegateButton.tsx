import { type CapabilityGrant, type Project, matchAnyPattern } from '@acc/protocol';
import { Ban, Diamond, Folder, GitBranch } from 'lucide-react';
import { useState } from 'react';
import { delegateSession, undelegateSession } from '../../daemon/actions';
import { setTreeBudget } from '../../daemon/cost';
import { useHomeSelect } from '../../daemon/home';
import { useGrants, useProjects, useSessions } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { treeRelations, useSessionTree } from '../../daemon/tree';
import { useSlowNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { budgetTone, formatUsd } from '../../lib/states';
import { FieldRow, type SegmentOption, Segmented, Stepper, UsdField } from '../settings/controls';
import { Button, IconButton } from '../ui/Button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';

/** Children at once the daemon allows a supervisor (session.delegate `maxChildren`). */
export const MAX_CHILDREN = { min: 1, max: 16, fallback: 4 } as const;

/** Where the children may work: nothing, the project's folder, or the project's code. */
export type DelegateWorkspace = 'none' | 'folder' | 'worktree';

/** The session's active supervisor grant (it lets the session start children), if any. */
export function supervisorGrant(grants: readonly CapabilityGrant[] | undefined, nowMs: number): CapabilityGrant | null {
  for (let i = (grants?.length ?? 0) - 1; i >= 0; i--) {
    const g = grants![i]!;
    if (g.revokedAt || g.subject.kind !== 'session') continue;
    if (g.expiresAt && Date.parse(g.expiresAt) <= nowMs) continue;
    if (matchAnyPattern(g.permissions, 'session.spawn')) return g;
  }
  return null;
}

/**
 * What the children may use as a workspace under a grant. The daemon decides it from the
 * project the grant is limited to: without one, nothing; a folder project, its folder; a
 * project with a repository, its code (worktrees).
 */
export function grantWorkspace(grant: CapabilityGrant | null, project: Project | null): DelegateWorkspace {
  if (!grant || !project || !grant.scope.projectIds?.includes(project.id)) return 'none';
  if (project.repoPath) return 'worktree';
  return project.folderPath ? 'folder' : 'none';
}

/** The choices of 作業場所: only what the session's project offers can be picked. */
export function workspaceOptions(project: Project | null): SegmentOption<DelegateWorkspace>[] {
  return [
    { value: 'none', label: 'なし', icon: <Ban size={13} strokeWidth={1.75} />, iconOnly: true },
    {
      value: 'folder',
      label: 'フォルダ',
      icon: <Folder size={13} strokeWidth={1.75} />,
      iconOnly: true,
      disabled: !project?.folderPath || !!project.repoPath,
    },
    {
      value: 'worktree',
      label: 'コード',
      icon: <GitBranch size={13} strokeWidth={1.75} />,
      iconOnly: true,
      disabled: !project?.repoPath,
    },
  ];
}

/**
 * 任せる (spec §7): one press delegates with the daemon's defaults — no dialog. While
 * delegated the diamond is filled; pressing it opens a small popover to adjust the budget,
 * how many children work at once and where they may work, or to stop delegating.
 */
export function DelegateButton({ sessionId, className }: { sessionId: string; className?: string }) {
  const rt = useRuntime();
  const connected = useConnectionState() === 'open';
  const now = useSlowNow();
  const tree = useSessionTree(sessionId).data;
  const self = treeRelations(tree, sessionId).self;
  const grants = useGrants(sessionId);
  const grant = supervisorGrant(grants.data, now);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  // Agents work themselves; only conversations lead others (the daemon refuses the rest).
  if (self?.role === 'agent') return null;
  const delegated = grants.data ? !!grant : self?.role === 'supervisor';

  if (!delegated) {
    return (
      <IconButton
        label="任せる"
        aria-pressed={false}
        disabled={!connected || busy}
        className={className}
        onClick={() => {
          setBusy(true);
          void delegateSession(rt, sessionId).finally(() => setBusy(false));
        }}
      >
        <Diamond size={15} strokeWidth={1.75} />
      </IconButton>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content={open ? null : '任せている'}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="任せている"
            aria-pressed={true}
            data-delegated=""
            className={cn(
              'inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-st-supervising hover:bg-hover',
              className,
            )}
          >
            <Diamond size={15} strokeWidth={1.75} fill="currentColor" />
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent focusInput={false} align="end" className="w-[280px]">
        {open && (
          <DelegateSettings
            sessionId={sessionId}
            grant={grant}
            budget={self?.budget ?? null}
            onStopped={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function DelegateSettings({
  sessionId,
  grant,
  budget,
  onStopped,
}: {
  sessionId: string;
  grant: CapabilityGrant | null;
  budget: { limitUsd: number; usedUsd: number } | null;
  onStopped: () => void;
}) {
  const rt = useRuntime();
  const session = useSessions().data?.find((s) => s.id === sessionId) ?? null;
  const project = useProjects().data?.find((p) => p.id === session?.projectId) ?? null;
  const maxChildren = grant?.limits.maxChildren ?? grant?.limits.maxWorkers ?? MAX_CHILDREN.fallback;
  const workspace = grantWorkspace(grant, project);
  const redelegate = (patch: { maxChildren?: number; workspace?: DelegateWorkspace }) => {
    const ws = patch.workspace ?? workspace;
    void delegateSession(rt, sessionId, {
      maxChildren: patch.maxChildren ?? maxChildren,
      projectId: ws === 'none' ? null : (project?.id ?? null),
      ...(grant?.lifetime === 'work' ? { lifetime: 'work' as const } : {}),
    });
  };
  // The budget covers the whole tree (the session and its children): show what the tree spent.
  const treeUsd = useHomeSelect((s) => s.trees.find((t) => t.root.id === sessionId)?.spend.treeUsd);
  const spent = treeUsd ?? budget?.usedUsd ?? 0;
  const used = budget ? formatUsd(spent) : null;
  const tone = budget ? budgetTone(spent, budget.limitUsd) : 'ok';
  return (
    <div className="flex flex-col gap-1.5 p-3" data-testid="delegate-popover">
      <FieldRow label="予算" htmlFor="delegate-budget">
        {used && (
          <span
            className={cn('text-meta tabular', tone === 'ok' ? 'text-fg-3' : tone === 'warn' ? 'text-st-needs_you' : 'text-st-failed')}
            data-testid="delegate-used"
          >
            {used} /
          </span>
        )}
        <UsdField
          id="delegate-budget"
          label="予算"
          value={budget?.limitUsd ?? null}
          allowEmpty
          placeholder="—"
          width={84}
          onCommit={(v) => void setTreeBudget(rt, sessionId, v)}
        />
      </FieldRow>
      <FieldRow label="同時に動かす数">
        <Stepper
          label="同時に動かす数"
          value={maxChildren}
          min={MAX_CHILDREN.min}
          max={MAX_CHILDREN.max}
          onChange={(n) => redelegate({ maxChildren: n })}
        />
      </FieldRow>
      <FieldRow label="作業場所">
        <Segmented<DelegateWorkspace>
          label="作業場所"
          value={workspace}
          options={workspaceOptions(project)}
          onChange={(w) => redelegate({ workspace: w })}
        />
      </FieldRow>
      <div className="mt-1.5 border-t border-line-subtle pt-2.5">
        <Button
          size="sm"
          variant="ghost"
          className="w-full justify-start"
          icon={<Diamond size={13} strokeWidth={1.75} />}
          onClick={() => {
            onStopped();
            void undelegateSession(rt, sessionId);
          }}
        >
          任せるのをやめる
        </Button>
      </div>
    </div>
  );
}
