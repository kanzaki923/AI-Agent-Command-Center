import type { Character } from '@acc/protocol';
import { Check, UserRound } from 'lucide-react';
import { useMember, useMembers } from '../../daemon/members';
import { cn } from '../../lib/cn';
import { MemberFace } from '../ui/Face';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';

/**
 * The face slot (snapshot 20261104_members-spec.md §6): who a conversation is with, or the
 * assistant's seat. Empty, it is a dashed circle; pressed, the roster to choose from (and
 * なし). Hidden while the roster is empty — nobody to choose.
 */
export function MemberPicker({
  value,
  onChange,
  size = 20,
  label,
  disabled = false,
}: {
  value: string | null;
  onChange: (characterId: string | null) => void;
  size?: number;
  /** What the slot stands for (会話の相手, 右腕の席). */
  label: string;
  disabled?: boolean;
}) {
  const members = useMembers();
  const current = useMember(value);
  if (members.length === 0 && !current) return null;
  const pick = (c: Character | null) => onChange(c?.id ?? null);
  return (
    <Menu>
      <Tooltip content={current ? `${label}: ${current.name}` : label}>
        <MenuTrigger asChild disabled={disabled}>
          <button
            type="button"
            aria-label={current ? `${label}（${current.name}）` : label}
            data-member-picker={current?.id ?? ''}
            className="flex shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
          >
            {current ? (
              <MemberFace member={current} size={size} />
            ) : (
              <span
                className={cn('flex items-center justify-center rounded-full border border-dashed border-line-strong text-fg-3 hover:text-fg-2')}
                style={{ width: size, height: size }}
              >
                <UserRound size={Math.round(size * 0.6)} strokeWidth={1.75} aria-hidden />
              </span>
            )}
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent className="min-w-44">
        {members.map((m) => (
          <MenuItem key={m.id} icon={<MemberFace member={m} size={16} />} onSelect={() => pick(m)}>
            <span className="flex-1">{m.name}</span>
            {m.id === value && <Check size={13} className="text-fg-2" aria-hidden />}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onSelect={() => pick(null)}>
          <span className="flex-1 text-fg-2">なし</span>
          {!value && <Check size={13} className="text-fg-2" aria-hidden />}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
