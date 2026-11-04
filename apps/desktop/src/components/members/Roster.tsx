import type { Character, Session } from '@acc/protocol';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { createMember, useMembers } from '../../daemon/members';
import { useSessions } from '../../daemon/queries';
import { useRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { MemberFace } from '../ui/Face';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';

/** Faces shown in the sidebar; the rest fold into +N (the first page shows them all). */
export const ROSTER_SHOWN = 8;

const BUSY = new Set(['working', 'supervising', 'queued']);

/** What each member is doing now: its busiest conversation (working first). */
export function memberActivity(sessions: readonly Session[]): Map<string, Session> {
  const out = new Map<string, Session>();
  for (const s of sessions) {
    if (!s.characterId || s.archivedAt || !BUSY.has(s.state)) continue;
    const cur = out.get(s.characterId);
    if (!cur || (cur.state !== 'working' && s.state === 'working')) out.set(s.characterId, s);
  }
  return out;
}

/** Name a new member; its page opens to write the rest. */
function NewMember() {
  const rt = useRuntime();
  const openMember = useUi((s) => s.openMember);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const create = async () => {
    const n = name.trim();
    if (!n) return;
    const m = await createMember(rt, { name: n });
    if (!m) return;
    setOpen(false);
    setName('');
    openMember(m.id);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content="メンバーを追加">
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="メンバーを追加"
            data-add-member
            className="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-line-strong text-fg-3 hover:text-fg"
          >
            <Plus size={13} strokeWidth={1.75} aria-hidden />
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="start">
        <form
          className="flex w-56 flex-col gap-2 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input
            autoFocus
            value={name}
            maxLength={40}
            aria-label="名前"
            placeholder="名前"
            onChange={(e) => setName(e.target.value)}
            className="h-8 rounded-sm border border-line bg-canvas px-2 text-ui text-fg placeholder:text-fg-4 focus:border-[var(--focus-ring)]"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="h-7 self-end rounded-sm bg-accent px-3 text-ui text-accent-fg hover:bg-accent-hover disabled:bg-selected disabled:text-fg-4"
          >
            追加
          </button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function RosterFace({ member, busy }: { member: Character; busy: Session | undefined }) {
  const openMember = useUi((s) => s.openMember);
  const active = useUi((s) => s.mode === 'member' && s.memberId === member.id);
  const label = busy?.now ? `${member.name}：${busy.now}` : member.name;
  return (
    <Tooltip content={label}>
      <button
        type="button"
        data-roster-member={member.id}
        data-busy={busy ? true : undefined}
        aria-label={member.name}
        aria-current={active ? 'page' : undefined}
        onClick={() => openMember(member.id)}
        className="flex shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        <MemberFace member={member} size={24} busy={!!busy} className={active ? 'outline-2 outline-offset-2 outline-line-strong' : undefined} />
      </button>
    </Tooltip>
  );
}

/**
 * The team at the foot of the sidebar (snapshot 20261104_members-spec.md §6): faces only, a
 * ring on those at work. Nothing at all while there is no member besides the + — those who
 * do not use members see one quiet circle.
 */
export function Roster() {
  const members = useMembers();
  const sessions = useSessions().data;
  const openMember = useUi((s) => s.openMember);
  const busy = useMemo(() => memberActivity(sessions ?? []), [sessions]);
  const shown = members.slice(0, ROSTER_SHOWN);
  const more = members.length - shown.length;
  return (
    <div role="group" aria-label="メンバー" data-roster className="flex flex-wrap items-center gap-1.5 px-2 py-2">
      {shown.map((m) => (
        <RosterFace key={m.id} member={m} busy={busy.get(m.id)} />
      ))}
      {more > 0 && (
        <button
          type="button"
          onClick={() => openMember(members[ROSTER_SHOWN]!.id)}
          className="flex h-6 items-center rounded-full px-1.5 text-micro text-fg-3 tabular hover:bg-hover hover:text-fg"
        >
          +{more}
        </button>
      )}
      <NewMember />
    </div>
  );
}
