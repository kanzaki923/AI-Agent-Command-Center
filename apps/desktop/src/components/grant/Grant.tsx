import { type CapabilityGrant, type Session, matchAnyPattern } from '@acc/protocol';
import { Diamond } from 'lucide-react';
import { useGrants } from '../../daemon/queries';
import { useNow } from '../../hooks/useNow';
import { formatClock } from '../../lib/format';
import { activeGrants, canOrchestrate } from '../../model/grant';

/**
 * What is left of the old grant dialog (spec §7: 任せる replaced it — components/delegate).
 * Only the pieces the conversation screen still imports remain, reduced to the new
 * vocabulary; the conversation track (U3) drops them as it rewrites that screen.
 */

const NONE: never[] = [];

/** Active grants of a session, re-evaluated with the shared 1s clock (expiry). */
export function useSessionGrants(sessionId: string | null | undefined) {
  const grants = useGrants(sessionId).data ?? NONE;
  const now = useNow();
  const nowIso = new Date(now).toISOString();
  const active = activeGrants(grants, nowIso);
  return { grants, active, orchestrator: active.find(canOrchestrate) ?? null };
}

/** The 任せた mark: a diamond, filled while delegated. */
export function OrchestratorMark({ size = 12, hollow = false }: { size?: number; hollow?: boolean }) {
  return (
    <Diamond
      size={size}
      strokeWidth={1.75}
      className={hollow ? 'text-fg-3' : 'text-st-supervising'}
      fill={hollow ? 'none' : 'currentColor'}
      aria-hidden="true"
    />
  );
}

/** The composer's old grant chip. 任せる lives in the conversation's header now. */
export function GrantChip(_props: { session: Session }) {
  return null;
}

/** A delegated conversation before its first message: the filled diamond, nothing to read. */
export function OrchestratorIntro(_props: { session: Session; grant: CapabilityGrant }) {
  return (
    <div className="flex h-full items-center justify-center pb-16" data-testid="orchestrator-intro">
      <span className="flex size-10 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--st-supervising)_14%,transparent)]">
        <OrchestratorMark size={16} />
      </span>
    </div>
  );
}

/** A person let the session lead others (任せる), as opposed to a child's own working grant. */
export function isDelegation(grant: CapabilityGrant): boolean {
  return grant.grantedBy.kind === 'human' && matchAnyPattern(grant.permissions, 'session.spawn');
}

/** Grants that were replaced by delegating again (a new grant created at the same moment). */
const REPLACE_WINDOW_MS = 1_000;

export function isReplacement(grant: CapabilityGrant, change: 'given' | 'ended', all: readonly CapabilityGrant[]): boolean {
  const at = Date.parse(change === 'given' ? grant.createdAt : (grant.revokedAt ?? ''));
  if (!Number.isFinite(at)) return false;
  return all.some((g) => {
    if (g.id === grant.id) return false;
    const other = Date.parse(change === 'given' ? (g.revokedAt ?? '') : g.createdAt);
    return Number.isFinite(other) && Math.abs(other - at) <= REPLACE_WINDOW_MS;
  });
}

/** Chat stream line: ◆ 任せました · 10:12 / ◇ 任せるのをやめました · 10:40 (changes of settings stay quiet). */
export function GrantLine({ grant, change }: { grant: CapabilityGrant; change: 'given' | 'ended' }) {
  const sessionId = grant.subject.kind === 'session' ? grant.subject.sessionId : null;
  const all = useGrants(sessionId).data ?? NONE;
  // Only a person delegating says something; a child's own working grant stays silent.
  if (!isDelegation(grant) || isReplacement(grant, change, all)) return null;
  const at = change === 'given' ? grant.createdAt : (grant.revokedAt ?? grant.createdAt);
  return (
    <div className="flex items-center gap-3 py-1" data-testid={`grant-line-${change}`}>
      <span className="h-px min-w-6 flex-1 bg-line-subtle" />
      <span className="flex items-center gap-1.5 text-meta text-fg-3">
        <OrchestratorMark size={10} hollow={change === 'ended'} />
        <span className="text-fg-2">{change === 'given' ? '任せました' : '任せるのをやめました'}</span>
        <span className="tabular">· {formatClock(at)}</span>
      </span>
      <span className="h-px min-w-6 flex-1 bg-line-subtle" />
    </div>
  );
}
