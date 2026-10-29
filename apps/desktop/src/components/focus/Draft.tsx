import type { Project, WorkspaceSpec } from '@acc/protocol';
import { ArrowUp, Check, ChevronDown, Layers, MessageSquare } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { startConversation } from '../../daemon/actions';
import { useProjects } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { cn } from '../../lib/cn';
import { WORKSPACE_META } from '../../lib/states';
import { useUi } from '../../store/ui';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';
import { composerKeyAction } from './Composer';

const NONE: never[] = [];
/** Key of the draft's text in the UI store (it survives leaving and coming back). */
export const DRAFT_KEY = '__new__';

export type DraftPlace = 'none' | 'folder' | 'worktree';

/** The workspace a new conversation gets for a place, or why it cannot have it. */
export function workspaceFor(place: DraftPlace, project: Project | null): WorkspaceSpec | null {
  if (place === 'folder') return project?.folderPath ? { kind: 'folder', path: project.folderPath } : null;
  if (place === 'worktree') return project?.repoPath ? { kind: 'worktree', projectId: project.id } : null;
  return { kind: 'none' };
}

function Segment({
  active,
  disabled,
  label,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label}>
      <span className="inline-flex">
        <button
          type="button"
          role="radio"
          aria-checked={active}
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            'flex size-7 items-center justify-center rounded-sm transition-colors duration-[120ms]',
            active ? 'bg-selected text-fg' : 'text-fg-3 hover:bg-hover hover:text-fg',
            'disabled:pointer-events-none disabled:text-fg-4',
          )}
        >
          {children}
        </button>
      </span>
    </Tooltip>
  );
}

/**
 * A new conversation before its first message (Ctrl+N, spec §5.3). Nothing exists yet: the
 * first send creates the session (with the chosen project and place to work) and opens it.
 * Only two things sit beside the input: the project chip and where it works (none / folder /
 * code), and only when there is a project to choose.
 */
export function Draft() {
  const rt = useRuntime();
  const connected = useConnectionState() === 'open';
  const projects = (useProjects().data ?? NONE).filter((p) => !p.archivedAt);
  const projectId = useUi((s) => s.projectId);
  const setProject = useUi((s) => s.setProject);
  const text = useUi((s) => s.drafts[DRAFT_KEY] ?? '');
  const setDraft = useUi((s) => s.setDraft);
  const [place, setPlace] = useState<DraftPlace>('none');
  const [sending, setSending] = useState(false);
  const composing = useRef(false);
  const project = projects.find((p) => p.id === projectId) ?? null;
  // A place the chosen project cannot offer falls back to none (derived, not stored).
  const effective: DraftPlace = workspaceFor(place, project) ? place : 'none';

  const send = async () => {
    const t = text.trim();
    if (!t || sending || !connected) return;
    setSending(true);
    const workspace = workspaceFor(effective, project) ?? undefined;
    const s = await startConversation(rt, { text: t, projectId: project?.id ?? null, workspace });
    setSending(false);
    if (!s) return;
    setDraft(DRAFT_KEY, '');
    useUi.getState().openSession(s.id);
  };

  return (
    <div className="flex h-full flex-col items-center justify-center px-8" data-draft>
      <div className="flex w-full max-w-2xl flex-col gap-2">
        <div className="rounded-md border border-line bg-surface focus-within:border-line-strong">
          <textarea
            autoFocus
            data-composer-input
            value={text}
            rows={3}
            placeholder="何を頼みますか"
            aria-label="何を頼みますか"
            onChange={(e) => setDraft(DRAFT_KEY, e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(e) => {
              const action = composerKeyAction(
                {
                  key: e.key,
                  shiftKey: e.shiftKey,
                  ctrlKey: e.ctrlKey,
                  metaKey: e.metaKey,
                  altKey: e.altKey,
                  isComposing: e.nativeEvent.isComposing,
                  keyCode: e.nativeEvent.keyCode,
                },
                composing.current,
              );
              if (action === 'send') {
                e.preventDefault();
                void send();
              }
            }}
            className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-chat text-fg placeholder:text-fg-4"
          />
          <div className="flex h-9 items-center gap-1 px-2 pb-1">
            {projects.length > 0 && (
              <>
                <Menu>
                  <MenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="プロジェクト"
                      data-testid="draft-project"
                      className="flex h-7 max-w-56 items-center gap-1.5 rounded-sm px-2 text-meta text-fg-2 hover:bg-hover hover:text-fg"
                    >
                      <Layers size={13} strokeWidth={1.75} aria-hidden />
                      <span className="truncate">{project?.name ?? 'プロジェクトなし'}</span>
                      <ChevronDown size={12} strokeWidth={1.75} className="text-fg-3" aria-hidden />
                    </button>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem icon={!project ? <Check size={13} /> : undefined} onSelect={() => setProject(null)}>
                      プロジェクトなし
                    </MenuItem>
                    <MenuSeparator />
                    {projects.map((p) => (
                      <MenuItem
                        key={p.id}
                        icon={p.id === project?.id ? <Check size={13} /> : undefined}
                        onSelect={() => setProject(p.id)}
                      >
                        {p.name}
                      </MenuItem>
                    ))}
                  </MenuContent>
                </Menu>
                <span role="radiogroup" aria-label="作業場所" className="flex items-center gap-0.5">
                  <Segment active={effective === 'none'} disabled={false} label="なし" onClick={() => setPlace('none')}>
                    <MessageSquare size={14} strokeWidth={1.75} />
                  </Segment>
                  {(['folder', 'worktree'] as const).map((k) => {
                    const Icon = WORKSPACE_META[k].icon;
                    return (
                      <Segment
                        key={k}
                        active={effective === k}
                        disabled={!workspaceFor(k, project)}
                        label={WORKSPACE_META[k].label}
                        onClick={() => setPlace(k)}
                      >
                        <Icon size={14} strokeWidth={1.75} />
                      </Segment>
                    );
                  })}
                </span>
              </>
            )}
            <span className="flex-1" />
            <button
              type="button"
              aria-label="送信"
              disabled={!connected || sending || !text.trim()}
              onClick={() => void send()}
              className="flex size-7 items-center justify-center rounded-sm bg-accent text-accent-fg hover:bg-accent-hover disabled:bg-selected disabled:text-fg-4"
            >
              <ArrowUp size={14} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
