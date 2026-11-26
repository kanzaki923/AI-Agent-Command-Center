import { CHARACTER_PROFILE_MAX, type Character, type Session } from '@acc/protocol';
import { Diamond, MessageSquarePlus, MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import {
  archiveMember,
  setAssistantSeat,
  updateMember,
  useMember,
  useMemberPage,
} from '../../daemon/members';
import { useSettings } from '../../daemon/queries';
import { useRuntime } from '../../daemon/runtime';
import { cn } from '../../lib/cn';
import { sessionTitle } from '../../lib/states';
import { toast } from '../../store/toast';
import { useUi } from '../../store/ui';
import { ModelPicker } from '../focus/ModelPicker';
import { formatSpend } from '../settings/UsageStats';
import { DigestState, MemoryChanges, Memories } from './Memories';
import { IconButton } from '../ui/Button';
import { MEMBER_TONES, MemberFace, toneColor } from '../ui/Face';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger } from '../ui/Menu';
import { RoleIcon } from '../ui/SemanticIcons';
import { StateIcon } from '../ui/StateIcon';
import { Tooltip } from '../ui/Tooltip';

/**
 * The face and its colour: one character (or the first letter of the name) and 8 colours.
 * The typed face is a draft over the member's own (reset each time the popover opens) and is
 * saved once: on Enter (which closes the popover) or when the popover closes.
 */
function FaceEditor({ member }: { member: Character }) {
  const rt = useRuntime();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? member.face ?? '';
  const commitFace = () => {
    if (draft === null) return;
    setDraft(null);
    const next = draft.trim() || null;
    if (next !== member.face) void updateMember(rt, { characterId: member.id, face: next });
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(null);
        else commitFace();
        setOpen(next);
      }}
    >
      <Tooltip content="顔と色">
        <PopoverTrigger asChild>
          <button type="button" aria-label="顔と色" data-face-editor className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
            <MemberFace member={member} size={44} />
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="start">
        <div className="flex w-56 flex-col gap-2.5 p-2">
          <div role="radiogroup" aria-label="色" className="grid grid-cols-8 gap-1">
            {Array.from({ length: MEMBER_TONES }, (_, i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={member.tone === i}
                aria-label={`色 ${i + 1}`}
                onClick={() => void updateMember(rt, { characterId: member.id, tone: i })}
                className={cn('size-5 rounded-full', member.tone === i && 'ring-2 ring-fg ring-offset-2 ring-offset-[var(--bg-raised)]')}
                style={{ background: toneColor(i) }}
              />
            ))}
          </div>
          <input
            value={value}
            maxLength={4}
            aria-label="顔の文字"
            placeholder={[...member.name][0] ?? ''}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
              e.preventDefault();
              commitFace();
              setOpen(false);
            }}
            className="h-8 w-16 rounded-sm border border-line bg-canvas px-2 text-center text-ui text-fg placeholder:text-fg-4 focus:border-[var(--focus-ring)]"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The name, edited in place (double-click, F2 or Enter). */
function NameEditor({ member }: { member: Character }) {
  const rt = useRuntime();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  if (!editing) {
    return (
      <h1
        tabIndex={0}
        data-member-name
        onDoubleClick={() => {
          setValue(member.name);
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'F2' || e.key === 'Enter') {
            e.preventDefault();
            setValue(member.name);
            setEditing(true);
          }
        }}
        className="min-w-0 cursor-default truncate rounded-xs px-1 text-[18px] leading-7 font-semibold text-fg outline-none hover:bg-hover focus-visible:bg-hover"
      >
        {member.name}
      </h1>
    );
  }
  const commit = () => {
    setEditing(false);
    const t = value.trim();
    if (t && t !== member.name) void updateMember(rt, { characterId: member.id, name: t });
  };
  return (
    <input
      autoFocus
      aria-label="名前"
      value={value}
      maxLength={40}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          e.stopPropagation();
          setEditing(false);
        }
      }}
      className="h-8 min-w-0 rounded-xs border border-line bg-canvas px-1.5 text-[18px] font-semibold text-fg focus:border-[var(--focus-ring)]"
    />
  );
}

/**
 * Who the member is: free text, saved when the field is left. Its working style counts in
 * work too; its voice only where it talks (the daemon's frame says so).
 */
function ProfileEditor({ member }: { member: Character }) {
  const rt = useRuntime();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? member.profile;
  const save = () => {
    if (draft !== null && draft.trim() !== member.profile) {
      void updateMember(rt, { characterId: member.id, profile: draft });
    }
    setDraft(null);
  };
  return (
    <textarea
      data-member-profile
      aria-label="プロフィール"
      value={value}
      maxLength={CHARACTER_PROFILE_MAX}
      rows={Math.min(12, Math.max(4, value.split('\n').length + 1))}
      placeholder={'どんな人か、話し方、得意なこと、仕事の流儀'}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      className="selectable w-full resize-none rounded-md border border-transparent bg-surface px-3 py-2.5 text-chat leading-relaxed text-fg placeholder:text-fg-4 hover:border-line focus:border-[var(--focus-ring)]"
    />
  );
}

function SessionRow({ session }: { session: Session }) {
  const openSession = useUi((s) => s.openSession);
  const role = session.parentSessionId && (session.speaks || session.persona) ? 'speaker' : session.kind;
  return (
    <button
      type="button"
      data-member-session={session.id}
      onClick={() => openSession(session.id)}
      className="flex h-7 w-full items-center gap-2 rounded-sm px-1.5 text-left text-ui text-fg-2 hover:bg-hover hover:text-fg"
    >
      <StateIcon state={session.state} size={12} />
      <span className="min-w-0 flex-1 truncate">{sessionTitle(session)}</span>
      <RoleIcon role={role} size={12} scheduled={!!session.scheduleId} className="text-fg-3" />
    </button>
  );
}

/**
 * A member's page (snapshot 20261104_members-spec.md §6): its face, name, model and profile,
 * a button to talk with it, and on the side what it cost this month and the conversations it
 * was in, and what it remembers (stage 2) with its latest changes.
 */
export function MemberPage() {
  const rt = useRuntime();
  const memberId = useUi((s) => s.memberId);
  const member = useMember(memberId);
  const page = useMemberPage(memberId).data;
  const settings = useSettings().data;
  const openDraft = useUi((s) => s.openDraft);
  const goHome = useUi((s) => s.goHome);
  if (!member) {
    return <div className="flex h-full items-center justify-center text-ui text-fg-3">メンバーが見つかりません</div>;
  }
  const seated = settings?.assistant?.characterId === member.id;
  const roster = [
    ...new Set([
      ...(settings?.modelRules ?? []).map((r) => r.model),
      ...(settings?.defaultModel ? [settings.defaultModel] : []),
    ]),
  ];
  const archived = !!member.archivedAt;
  // An older daemon may leave out what came later (memories, changes, memoryUsd).
  const monthUsd = (page?.monthUsd ?? 0) + (page?.memoryUsd ?? 0);
  const takeOff = async () => {
    const out = await archiveMember(rt, member.id);
    if (!out) return;
    goHome();
    toast({
      title: `「${member.name}」を名簿から外しました`,
      tone: 'info',
      sticky: false,
      action: { label: '元に戻す', undo: true, run: () => void archiveMember(rt, member.id, false) },
    });
  };
  return (
    <div className="h-full overflow-y-auto" data-member-page={member.id}>
      <div className="mx-auto grid max-w-[880px] grid-cols-[minmax(0,1fr)_220px] gap-8 px-8 py-8">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex items-center gap-3">
            <FaceEditor key={member.id} member={member} />
            <div className="flex min-w-0 flex-1 flex-col">
              <NameEditor member={member} />
              <div className="flex h-6 items-center gap-2 px-1 text-meta text-fg-3">
                <ModelPicker
                  value={member.model}
                  fallback={null}
                  roster={roster}
                  side="bottom"
                  autoLabel="会話の既定"
                  autoHint="会話を始めるときの既定のモデルを使います"
                  local
                  onChange={(m) => void updateMember(rt, { characterId: member.id, model: m })}
                />
                {seated && (
                  <span className="flex items-center gap-1" data-seated>
                    <Diamond size={11} strokeWidth={2} aria-hidden />
                    右腕
                  </span>
                )}
              </div>
            </div>
            {!archived && (
              <IconButton label={`${member.name}と話す`} onClick={() => openDraft(member.id)}>
                <MessageSquarePlus size={16} strokeWidth={1.75} />
              </IconButton>
            )}
            <Menu>
              <MenuTrigger asChild>
                <IconButton label="その他の操作">
                  <MoreHorizontal size={15} strokeWidth={1.75} />
                </IconButton>
              </MenuTrigger>
              <MenuContent align="end">
                {!archived && (
                  <MenuItem onSelect={() => void setAssistantSeat(rt, seated ? null : member.id)}>
                    {seated ? '右腕の席から外す' : '右腕の席に座らせる'}
                  </MenuItem>
                )}
                {!archived && <MenuSeparator />}
                {archived ? (
                  <MenuItem onSelect={() => void archiveMember(rt, member.id, false)}>名簿に戻す</MenuItem>
                ) : (
                  <MenuItem danger onSelect={() => void takeOff()}>
                    名簿から外す
                  </MenuItem>
                )}
              </MenuContent>
            </Menu>
          </div>
          <ProfileEditor key={member.id} member={member} />
          <Memories member={member} memories={page?.memories ?? []} off={settings?.members?.memory === false} />
        </div>
        <aside className="flex min-w-0 flex-col gap-1 border-l border-line-subtle pl-6" aria-label={`${member.name}の記録`}>
          <div className="flex items-baseline justify-between">
            <span className="text-micro text-fg-3">今月</span>
            <span className={cn('text-[20px] leading-7 font-semibold tabular', monthUsd > 0 ? 'text-fg' : 'text-fg-3')} data-member-cost>
              {formatSpend(monthUsd)}
            </span>
          </div>
          {(page?.memoryUsd ?? 0) > 0 && (
            <div className="flex flex-col text-meta text-fg-3 tabular" data-member-cost-split>
              <span className="flex justify-between">
                <span>話した</span>
                <span>{formatSpend(page?.monthUsd ?? 0)}</span>
              </span>
              <span className="flex justify-between">
                <span>整理</span>
                <span>{formatSpend(page?.memoryUsd ?? 0)}</span>
              </span>
            </div>
          )}
          <DigestState member={member} />
          <div className="mt-4 mb-1 text-micro text-fg-3">出た会話</div>
          {(page?.sessions ?? []).map((s) => (
            <SessionRow key={s.id} session={s} />
          ))}
          {(page?.changes?.length ?? 0) > 0 && <div className="mt-4 mb-1 text-micro text-fg-3">最近の変化</div>}
          <MemoryChanges changes={page?.changes ?? []} />
        </aside>
      </div>
    </div>
  );
}
