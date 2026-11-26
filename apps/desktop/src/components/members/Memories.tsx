import { MEMORY_LIMITS, type Character, type CharacterMemory, type MemoryChange, type MemoryKind } from '@acc/protocol';
import { Briefcase, HeartHandshake, Pencil, PenLine, Plus, RefreshCw, Trash2, UserRound, UsersRound } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import {
  type DigestTone,
  addMemory,
  deleteMemory,
  digestLine,
  digestNow,
  memoryWhen,
  updateMemory,
  useAllMembers,
  useDigestStatus,
} from '../../daemon/members';
import { useNow } from '../../hooks/useNow';
import { formatTimestamp } from '../../lib/format';
import { useUi } from '../../store/ui';
import { type AppRuntime, useRuntime } from '../../daemon/runtime';
import { toast } from '../../store/toast';
import { cn } from '../../lib/cn';
import { MemberFace } from '../ui/Face';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';

/** A one-line field for a memory: Enter keeps it, Escape or an empty field drops the edit. */
function MemoryInput({
  initial = '',
  label,
  onDone,
}: {
  initial?: string;
  label: string;
  onDone: (text: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const finish = () => {
    const t = value.trim();
    onDone(t && t !== initial ? t : null);
  };
  return (
    <input
      autoFocus
      aria-label={label}
      value={value}
      maxLength={MEMORY_LIMITS.textChars}
      onChange={(e) => setValue(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') finish();
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDone(null);
        }
      }}
      className="h-7 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-2 text-ui text-fg focus:border-[var(--focus-ring)]"
    />
  );
}

/** Forget one memory; 元に戻す (5 seconds) has the member remember it again, as it was. */
async function forget(rt: AppRuntime, memory: CharacterMemory) {
  const out = await deleteMemory(rt, memory.id);
  if (!out) return;
  toast({
    title: '忘れさせました',
    tone: 'info',
    sticky: false,
    durationMs: 5000,
    action: {
      label: '元に戻す',
      undo: true,
      run: () =>
        void addMemory(rt, {
          characterId: memory.characterId,
          kind: memory.kind,
          text: memory.text,
          ...(memory.work ? { work: true } : {}),
          ...(memory.aboutId ? { aboutId: memory.aboutId } : {}),
        }),
    },
  });
}

function MemoryRow({ memory, about }: { memory: CharacterMemory; about?: Character | undefined }) {
  const rt = useRuntime();
  const [editing, setEditing] = useState(false);
  return (
    <li data-memory={memory.id} data-source={memory.source} className="group/mem flex min-h-7 items-center gap-2 rounded-sm px-1.5 hover:bg-hover">
      {about && <MemberFace member={about} size={16} />}
      {editing ? (
        <MemoryInput
          initial={memory.text}
          label="記憶を直す"
          onDone={(t) => {
            setEditing(false);
            if (t) void updateMemory(rt, memory.id, t);
          }}
        />
      ) : (
        <span className="selectable min-w-0 flex-1 text-ui text-fg">{memory.text}</span>
      )}
      {memory.work && !editing && (
        <Tooltip content="仕事でも使うやり方">
          <Briefcase size={12} strokeWidth={1.75} className="shrink-0 text-fg-3" aria-label="仕事でも使うやり方" />
        </Tooltip>
      )}
      {memory.source === 'person' && !editing && (
        <Tooltip content="あなたが書いた">
          <PenLine size={12} strokeWidth={1.75} className="shrink-0 text-fg-3" aria-label="あなたが書いた" />
        </Tooltip>
      )}
      {/* Faded in on hover, and on focus so the keyboard reaches them (not display:none). */}
      {!editing && (
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover/mem:opacity-100 group-focus-within/mem:opacity-100">
          <button type="button" aria-label="直す" onClick={() => setEditing(true)} className="flex size-6 items-center justify-center rounded-sm text-fg-3 hover:bg-selected hover:text-fg">
            <Pencil size={12} strokeWidth={1.75} />
          </button>
          <button type="button" aria-label="忘れさせる" onClick={() => void forget(rt, memory)} className="flex size-6 items-center justify-center rounded-sm text-fg-3 hover:bg-selected hover:text-st-failed">
            <Trash2 size={12} strokeWidth={1.75} />
          </button>
        </span>
      )}
      <span className="shrink-0 text-micro text-fg-3 tabular group-hover/mem:hidden group-focus-within/mem:hidden">{memoryWhen(memory.at)}</span>
    </li>
  );
}

function AddMemory({ member, kind, others }: { member: Character; kind: MemoryKind; others: Character[] }) {
  const rt = useRuntime();
  const [open, setOpen] = useState(false);
  const [about, setAbout] = useState<Character | null>(null);
  if (kind === 'relation' && others.length === 0) return null;
  const start = (c: Character | null) => {
    setAbout(c);
    setOpen(true);
  };
  if (open) {
    return (
      <div className="flex items-center gap-2 px-1.5 py-0.5">
        {about && <MemberFace member={about} size={16} />}
        <MemoryInput
          label="覚えさせること"
          onDone={(t) => {
            setOpen(false);
            if (t) void addMemory(rt, { characterId: member.id, kind, text: t, ...(about ? { aboutId: about.id } : {}) });
          }}
        />
      </div>
    );
  }
  const button = (onClick?: () => void) => (
    <button
      type="button"
      data-add-memory={kind}
      onClick={onClick}
      className="flex h-7 items-center gap-1.5 rounded-sm px-1.5 text-meta text-fg-3 hover:bg-hover hover:text-fg-2"
    >
      <Plus size={12} strokeWidth={1.75} aria-hidden />
      覚えさせる
    </button>
  );
  if (kind !== 'relation') return button(() => start(null));
  return (
    <Menu>
      <MenuTrigger asChild>{button()}</MenuTrigger>
      <MenuContent className="min-w-40">
        {others.map((o) => (
          <MenuItem key={o.id} icon={<MemberFace member={o} size={16} />} onSelect={() => start(o)}>
            {o.name}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

const SECTIONS: { kind: MemoryKind; label: string; icon: ReactNode }[] = [
  { kind: 'self', label: '自分', icon: <UserRound size={12} strokeWidth={1.75} aria-hidden /> },
  { kind: 'relation', label: '関係', icon: <UsersRound size={12} strokeWidth={1.75} aria-hidden /> },
  { kind: 'you', label: 'あなた', icon: <HeartHandshake size={12} strokeWidth={1.75} aria-hidden /> },
];

/**
 * What a member remembers (snapshot 20261104_members-spec.md §6): about itself, its ties with
 * other members (with their faces) and the person. Every line can be corrected or forgotten;
 * what the person wrote is marked and kept by the daemon's sorting.
 */
export function Memories({ member, memories, off }: { member: Character; memories: CharacterMemory[]; off: boolean }) {
  const others = useAllMembers().filter((c) => c.id !== member.id && !c.archivedAt);
  const byId = new Map(useAllMembers().map((c) => [c.id, c]));
  return (
    <section aria-label="覚えたこと" data-memories className={cn('flex flex-col gap-3', off && 'opacity-60')}>
      {SECTIONS.map((s) => {
        const list = memories.filter((m) => m.kind === s.kind);
        return (
          <div key={s.kind} className="flex flex-col">
            <h2 className="flex h-6 items-center gap-1.5 px-1.5 text-micro text-fg-3">
              {s.icon}
              {s.label}
              {off && s.kind === 'self' && <span className="ml-1">· 記憶はオフ</span>}
            </h2>
            <ul className="flex flex-col">
              {list.map((m) => (
                <MemoryRow key={m.id} memory={m} about={m.aboutId ? byId.get(m.aboutId) : undefined} />
              ))}
            </ul>
            <AddMemory member={member} kind={s.kind} others={others} />
          </div>
        );
      })}
    </section>
  );
}

const CHANGE_MARK: Record<MemoryChange['change'], { sign: string; className: string }> = {
  added: { sign: '＋', className: 'text-st-done' },
  removed: { sign: '−', className: 'text-st-failed' },
  changed: { sign: '✎', className: 'text-fg-2' },
};

/** The latest changes of a member's memories, newest first. */
export function MemoryChanges({ changes }: { changes: MemoryChange[] }) {
  if (changes.length === 0) return null;
  return (
    <ul aria-label="最近の変化" data-memory-changes className="flex flex-col">
      {changes.map((c, i) => (
        <li key={i} className="flex h-6 min-w-0 items-center gap-1.5 text-meta text-fg-2">
          <span aria-label={c.change === 'added' ? '覚えた' : c.change === 'removed' ? '忘れた' : '直した'} className={cn('w-3 shrink-0 text-center', CHANGE_MARK[c.change].className)}>
            {CHANGE_MARK[c.change].sign}
          </span>
          <span className="min-w-0 flex-1 truncate">{c.text}</span>
        </li>
      ))}
    </ul>
  );
}

const DIGEST_TONE: Record<DigestTone, string> = {
  muted: 'text-fg-3',
  warn: 'text-st-awaiting_approval',
  fail: 'text-st-failed',
};

/**
 * How sorting this member's memories stands, in one line, and 今すぐ整理: the page says why
 * nothing was remembered yet (no model, a failure, a limit, too little) or when it will be.
 * Without a model to sort with, the line opens the settings.
 */
export function DigestState({ member }: { member: Character }) {
  const rt = useRuntime();
  const status = useDigestStatus(member.id).data;
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const [busy, setBusy] = useState(false);
  const now = useNow();
  // An older daemon has no status: nothing to show.
  if (!status) return null;
  const line = digestLine(status, now);
  const last = status.last ? `前回 ${formatTimestamp(status.last.at, now, true)}` : null;
  const hint = [line.hint, last].filter(Boolean).join('\n') || null;
  const text = (
    <span className={cn('min-w-0 truncate', DIGEST_TONE[line.tone])} data-digest-tone={line.tone}>
      {line.text}
    </span>
  );
  return (
    <div className="mt-4 flex flex-col" data-digest-state>
      <div className="mb-1 flex h-5 items-center justify-between">
        <span className="text-micro text-fg-3">記憶の整理</span>
        {status.enabled && !member.archivedAt && (
          <Tooltip content="今すぐ整理">
            <button
              type="button"
              aria-label="今すぐ整理"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void digestNow(rt, member).finally(() => setBusy(false));
              }}
              className="flex size-5 items-center justify-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg disabled:opacity-50"
            >
              <RefreshCw size={12} strokeWidth={2} className={cn(busy && 'animate-spin')} />
            </button>
          </Tooltip>
        )}
      </div>
      <Tooltip content={hint}>
        {status.offline && status.enabled ? (
          <button
            type="button"
            onClick={() => setSettingsOpen(true, 'general')}
            className="flex min-w-0 text-left text-meta hover:underline"
          >
            {text}
          </button>
        ) : (
          <span className="flex min-w-0 text-meta">{text}</span>
        )}
      </Tooltip>
    </div>
  );
}
