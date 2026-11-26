import type { Actor, Session } from '@acc/protocol';
import type { DaemonContext } from '../core/context';

/** Recorded as the reason of a member conversation's grant. */
export const MEMBER_GRANT_REASON = 'member';

const MEMBER_SYSTEM: Actor = { kind: 'system', component: 'member' };

/**
 * A conversation with a member may ask for its memories to be sorted (`character.remember`,
 * when the person says "覚えておいて"): the daemon grants just that, at the start of a run, so
 * the tool is there from the first turn. It writes nothing itself — the sorting decides what
 * to keep from what was said — so no bound beyond the sorting's own is needed.
 */
export function ensureMemberGrant(ctx: DaemonContext, session: Session): void {
  if (!session.characterId || session.archivedAt) return;
  if (!ctx.hasService('policy') || !ctx.hasService('characters')) return;
  const member = ctx.service('characters').get(session.characterId);
  if (!member || member.archivedAt) return;
  const policy = ctx.service('policy');
  if (policy.sessionGrantsAllowing(session.id, 'character.remember').length > 0) return;
  policy.createGrant(
    {
      subject: { kind: 'session', sessionId: session.id },
      permissions: ['character.remember'],
      lifetime: 'session',
      expiresAt: null,
      reason: MEMBER_GRANT_REASON,
    },
    MEMBER_SYSTEM,
  );
}
