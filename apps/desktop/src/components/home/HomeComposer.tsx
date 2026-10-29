import type { Project, WorkspaceSpec } from '@acc/protocol';
import { ChevronDown, Diamond, MessageSquare } from 'lucide-react';
import { useState } from 'react';
import { startConversation } from '../../daemon/actions';
import { useProjects } from '../../daemon/queries';
import { useRuntime } from '../../daemon/runtime';
import { cn } from '../../lib/cn';
import { WORKSPACE_META, type WorkspaceKind } from '../../lib/states';
import { useUi } from '../../store/ui';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';

const NO_PROJECTS: Project[] = [];

/** Projects a workspace kind can use: a folder needs a folder, code a git repository. */
function candidates(projects: readonly Project[], kind: WorkspaceKind): Project[] {
  if (kind === 'folder') return projects.filter((p) => !!p.folderPath);
  if (kind === 'worktree') return projects.filter((p) => !!p.repoPath);
  return [];
}

/** The workspace a new conversation gets, or none. */
export function workspaceSpec(kind: WorkspaceKind, project: Project | null): WorkspaceSpec | undefined {
  if (kind === 'folder' && project?.folderPath) return { kind: 'folder', path: project.folderPath };
  if (kind === 'worktree' && project?.repoPath) return { kind: 'worktree', projectId: project.id };
  return undefined;
}

/**
 * 何を頼みますか (spec §3.1–3.2): the home screen's one-line request. Enter starts a new
 * conversation and stays on home; Ctrl+Enter starts it and opens it. The diamond makes it
 * delegated from the start (create → delegate → send). The empty home (`center`) is this
 * field alone in the middle, a little larger; elsewhere it sits at the bottom. The workspace
 * toggle (none / folder / code) picks where the work happens.
 */
export function HomeComposer({ center = false }: { center?: boolean }) {
  const rt = useRuntime();
  const projects = useProjects().data ?? NO_PROJECTS;
  const uiProjectId = useUi((s) => s.projectId);
  const [text, setText] = useState('');
  const [delegate, setDelegate] = useState(false);
  const [kind, setKind] = useState<WorkspaceKind>('none');
  const [pickedProjectId, setPickedProjectId] = useState<string | null>(null);

  // The project the workspace comes from: the one picked here, else the current one, else the first that fits.
  const fits = candidates(projects, kind);
  const project =
    fits.find((p) => p.id === pickedProjectId) ?? fits.find((p) => p.id === uiProjectId) ?? fits[0] ?? null;

  const send = async (open: boolean) => {
    const t = text.trim();
    if (!t) return;
    setText('');
    const workspace = workspaceSpec(kind, project);
    const s = await startConversation(rt, {
      text: t,
      projectId: workspace ? project!.id : uiProjectId,
      ...(workspace ? { workspace } : {}),
      delegate,
    });
    if (!s) {
      // Nothing was started: give the words back.
      setText((cur) => cur || t);
      return;
    }
    setDelegate(false);
    if (open) useUi.getState().openSession(s.id);
  };

  const toggle = (
    <WorkspaceToggle
      kind={kind}
      projects={projects}
      project={project}
      large={center}
      onKind={setKind}
      onProject={(id) => setPickedProjectId(id)}
    />
  );

  const field = (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1 rounded-md border border-line bg-surface pr-1.5 pl-1.5 focus-within:border-[var(--focus-ring)]',
        center ? 'h-12 w-full' : 'h-10 flex-1',
      )}
    >
      <Tooltip content="任せる">
        <button
          type="button"
          aria-label="任せる"
          aria-pressed={delegate}
          data-delegate-toggle
          onClick={() => setDelegate((v) => !v)}
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-sm transition-colors duration-[120ms] hover:bg-hover',
            delegate ? 'text-st-supervising' : 'text-fg-3 hover:text-fg',
          )}
        >
          <Diamond size={15} strokeWidth={1.75} fill={delegate ? 'currentColor' : 'none'} fillOpacity={delegate ? 0.35 : undefined} />
        </button>
      </Tooltip>
      <input
        autoFocus={center}
        value={text}
        placeholder="何を頼みますか"
        aria-label="何を頼みますか"
        data-composer-input
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            void send(e.ctrlKey || e.metaKey);
          }
        }}
        className={cn('h-full min-w-0 flex-1 bg-transparent px-1 text-fg placeholder:text-fg-4', center ? 'text-[15px]' : 'text-chat')}
      />
      {!center && toggle}
    </div>
  );

  if (!center) return field;
  // The empty home: the field, and where the work happens right under it.
  return (
    <div className="flex w-full flex-col items-center gap-3">
      {field}
      {toggle}
    </div>
  );
}

const KINDS: { kind: WorkspaceKind; label: string }[] = [
  { kind: 'none', label: '作業場所なし' },
  { kind: 'folder', label: WORKSPACE_META.folder.label },
  { kind: 'worktree', label: WORKSPACE_META.worktree.label },
];

/**
 * Where the new conversation works: nothing (a plain conversation), a folder, or a project's
 * code. A folder or code shows the project it comes from (a menu when there are several).
 * Code without any repository yet opens 「プロジェクトを追加」.
 */
function WorkspaceToggle({
  kind,
  projects,
  project,
  large,
  onKind,
  onProject,
}: {
  kind: WorkspaceKind;
  projects: readonly Project[];
  project: Project | null;
  large: boolean;
  onKind: (k: WorkspaceKind) => void;
  onProject: (projectId: string) => void;
}) {
  const fits = candidates(projects, kind);
  return (
    <span className="flex shrink-0 items-center gap-1">
      {kind !== 'none' && project && (
        <Menu>
          <MenuTrigger asChild disabled={fits.length < 2}>
            <button
              type="button"
              data-workspace-project
              className="flex h-6 max-w-40 items-center gap-1 rounded-sm bg-selected px-1.5 text-meta text-fg-2 hover:text-fg disabled:hover:text-fg-2"
            >
              <span className="truncate">{project.name}</span>
              {fits.length > 1 && <ChevronDown size={12} strokeWidth={1.75} className="shrink-0" />}
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            {fits.map((p) => (
              <MenuItem key={p.id} checked={p.id === project.id} onSelect={() => onProject(p.id)}>
                {p.name}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
      <span role="radiogroup" aria-label="作業場所" className={cn('flex items-center rounded-sm p-0.5', large ? 'gap-0.5 border border-line-subtle bg-surface' : 'bg-canvas')}>
        {KINDS.map(({ kind: k, label }) => {
          const Icon = k === 'none' ? MessageSquare : WORKSPACE_META[k].icon;
          const none = k !== 'none' && candidates(projects, k).length === 0;
          const unavailable = none && k === 'folder';
          const on = kind === k;
          return (
            <Tooltip key={k} content={unavailable ? `${label}のプロジェクトがありません` : label}>
              <button
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={label}
                aria-disabled={unavailable || undefined}
                data-workspace={k}
                onClick={() => {
                  if (unavailable) return;
                  if (none) {
                    useUi.getState().setProjectDialog({ kind: 'new' });
                    return;
                  }
                  onKind(k);
                }}
                className={cn(
                  'flex items-center justify-center rounded-[3px] transition-colors duration-[120ms]',
                  large ? 'size-8' : 'size-6',
                  on ? 'bg-selected text-fg' : 'text-fg-3 hover:text-fg aria-disabled:text-fg-4 aria-disabled:opacity-50',
                )}
              >
                <Icon size={large ? 16 : 13} strokeWidth={1.75} />
              </button>
            </Tooltip>
          );
        })}
      </span>
    </span>
  );
}
