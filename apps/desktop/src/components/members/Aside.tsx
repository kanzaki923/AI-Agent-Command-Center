import { useMember } from '../../daemon/members';
import { cn } from '../../lib/cn';
import { useUi } from '../../store/ui';
import { Markdown } from '../focus/Markdown';
import { MemberFace, toneColor } from '../ui/Face';

/**
 * A member's remark in a conversation (@name, snapshot 20261104_members-spec.md §4): its face,
 * its name (press for its page) and its words — the same shape as a speaker's turn, so the
 * member looks the same wherever it talks. `waiting`: asked, not answered yet.
 */
export function AsideRemark({
  characterId,
  text,
  waiting = false,
}: {
  characterId: string;
  text?: string;
  waiting?: boolean;
}) {
  const member = useMember(characterId);
  const openMember = useUi((s) => s.openMember);
  if (!member) return null;
  return (
    <div data-aside={characterId} data-waiting={waiting || undefined} className="grid min-w-0 grid-cols-[22px_minmax(0,1fr)] items-start gap-x-2.5">
      <span className="pt-0.5">
        <MemberFace member={member} size={22} busy={waiting} />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <button
          type="button"
          onClick={() => openMember(member.id)}
          className="self-start truncate text-ui font-medium hover:underline"
          style={{ color: toneColor(member.tone) }}
        >
          {member.name}
        </button>
        {waiting ? (
          <span aria-label={`${member.name}が考えています`} className="flex h-6 items-center gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={cn('size-1.5 rounded-full bg-fg-3 motion-safe:animate-pulse')}
                style={{ animationDelay: `${i * 160}ms` }}
              />
            ))}
          </span>
        ) : (
          <div className="selectable min-w-0">
            <Markdown text={text ?? ''} />
          </div>
        )}
      </div>
    </div>
  );
}

/** A remark asked for in this window and not answered yet: the ask, then the member thinking. */
export function AsidePending({ characterId, text }: { characterId: string; text: string }) {
  return (
    <div className="flex flex-col gap-6" data-aside-pending>
      <div className="selectable rounded-md border border-line bg-surface px-3.5 py-2.5 text-chat whitespace-pre-wrap text-fg">{text}</div>
      <AsideRemark characterId={characterId} waiting />
    </div>
  );
}
