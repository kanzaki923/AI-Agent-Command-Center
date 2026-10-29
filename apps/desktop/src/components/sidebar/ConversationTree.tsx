import type { Project } from '@acc/protocol';
import { ChevronRight, Folder, FolderGit2, FolderPlus, MoreHorizontal, Pencil, Plus } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useState } from 'react';
import { newChat } from '../../app/commands';
import { useHomeSelect } from '../../daemon/home';
import { useProjects, useSessions } from '../../daemon/queries';
import { useDeferredReorder } from '../../hooks/useDeferredReorder';
import { useSlowNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { useUi } from '../../store/ui';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu';
import { type TreeNode, ancestorsOf, buildForest, groupKeyOf, groupTrees, visibleRows } from './model';
import { TreeRow } from './TreeRow';

const NONE: never[] = [];
const NO_RUNS: Record<string, string> = {};

/** Key of a conversation's folded state in `ui.collapsed` (folded unless the user opened it). */
export const foldKey = (sessionId: string) => `sb:${sessionId}`;
export const projectKey = (projectId: string) => `sb:project:${projectId}`;
export const OLDER_KEY = 'sb:older';

/** Next scheduled run per session: the owner of an upcoming firing, and each tree's root. */
function useNextRuns(): Record<string, string> {
  return (
    useHomeSelect((snap) => {
      const out: Record<string, string> = {};
      const keep = (id: string, at: string | null) => {
        if (at && (!out[id] || at < out[id])) out[id] = at;
      };
      for (const t of snap.trees) keep(t.root.id, t.nextRunAt);
      for (const u of snap.upcoming) keep(u.sessionId, u.at);
      return out;
    }) ?? NO_RUNS
  );
}

/** Small group heading (project name, 以前): press to fold. */
function GroupHeading({
  icon,
  label,
  open,
  onToggle,
  count,
  menu,
}: {
  icon: ReactNode;
  label: string;
  open: boolean;
  onToggle: () => void;
  count?: number;
  menu?: ReactNode;
}) {
  return (
    <div className="group relative mt-3 flex h-6 shrink-0 items-center gap-1.5 rounded-sm pr-1 pl-2 text-meta text-fg-3 hover:text-fg-2" data-sidebar-group={label}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="absolute inset-0 rounded-sm focus-inset"
        aria-label={label}
      />
      <span className="pointer-events-none relative flex w-[13px] justify-center">{icon}</span>
      <span className="pointer-events-none relative min-w-0 flex-1 truncate font-medium">{label}</span>
      {!open && count != null && count > 0 && (
        <span className="pointer-events-none relative text-micro text-fg-3 tabular">{count}</span>
      )}
      <ChevronRight
        size={12}
        strokeWidth={2}
        aria-hidden
        className={cn(
          'pointer-events-none relative text-fg-4 transition-transform duration-150',
          open && 'invisible rotate-90 group-hover:visible',
        )}
      />
      {menu}
    </div>
  );
}

function ProjectMenu({ project }: { project: Project }) {
  const setProjectDialog = useUi((s) => s.setProjectDialog);
  const setProject = useUi((s) => s.setProject);
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          aria-label={`${project.name} の操作`}
          className="relative hidden size-6 shrink-0 items-center justify-center rounded-sm text-fg-3 group-hover:flex hover:bg-selected hover:text-fg data-[state=open]:flex"
        >
          <MoreHorizontal size={14} strokeWidth={1.5} />
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem
          icon={<Plus size={14} strokeWidth={1.5} />}
          onSelect={() => {
            setProject(project.id);
            newChat();
          }}
        >
          新しい会話
        </MenuItem>
        <MenuItem
          icon={<Pencil size={14} strokeWidth={1.5} />}
          onSelect={() => setProjectDialog({ kind: 'edit', projectId: project.id })}
        >
          プロジェクトを編集
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<FolderPlus size={14} strokeWidth={1.5} />} onSelect={() => setProjectDialog({ kind: 'new' })}>
          プロジェクトを追加
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** Rows of the sidebar, in DOM order (keyboard moves between them). */
function rowButtons(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-sidebar-row], [data-sidebar-group] > button[aria-expanded]')];
}

/**
 * The conversation tree of the sidebar (spec §4): every conversation with its children,
 * folded by default; the ancestors of the open conversation unfold by themselves. With two
 * or more projects the trees are grouped under the project names; conversations settled for
 * a week fold into 「以前」. Rows hold still while the pointer is over the list.
 */
export function ConversationTree() {
  const sessions = useSessions().data ?? NONE;
  const projects = (useProjects().data ?? NONE).filter((p) => !p.archivedAt);
  const mode = useUi((s) => s.mode);
  const focusSessionId = useUi((s) => s.focusSessionId);
  const collapsed = useUi((s) => s.collapsed);
  const toggleCollapsed = useUi((s) => s.toggleCollapsed);
  const nextRuns = useNextRuns();
  const now = useSlowNow();
  // Ancestors the user folded while this conversation was open: { ancestorId: focusId }.
  // A different open conversation unfolds its ancestors again.
  const [foldedUnder, setFoldedUnder] = useState<Record<string, string>>({});

  const forest = buildForest(sessions);
  const grouped = projects.length >= 2;
  const projectIds = new Set(projects.map((p) => p.id));
  const held = useDeferredReorder(
    forest,
    (t) => t.session.id,
    (t) => groupKeyOf(t, now, grouped, projectIds),
  );
  const { groups, older } = groupTrees(held.items, projects, held.groupOf);

  const ancestors = ancestorsOf(sessions, focusSessionId);
  const autoOpen = (id: string) => ancestors.has(id) && foldedUnder[id] !== focusSessionId;
  const isOpen = (id: string) => autoOpen(id) || collapsed[foldKey(id)] === false;
  const activeId = mode === 'session' ? focusSessionId : null;

  const toggle = (id: string) => {
    const key = foldKey(id);
    if (isOpen(id)) {
      if (ancestors.has(id) && focusSessionId) setFoldedUnder((m) => ({ ...m, [id]: focusSessionId }));
      if (collapsed[key] === false) toggleCollapsed(key, true);
    } else {
      if (foldedUnder[id]) {
        setFoldedUnder((m) => {
          const rest = { ...m };
          delete rest[id];
          return rest;
        });
        if (ancestors.has(id)) return;
      }
      toggleCollapsed(key, true);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const id = target.getAttribute('data-sidebar-row');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const rows = rowButtons(e.currentTarget);
      const i = rows.indexOf(target);
      const next = rows[e.key === 'ArrowDown' ? i + 1 : i < 0 ? rows.length - 1 : i - 1];
      if (next) {
        e.preventDefault();
        held.noteKeyboard();
        next.focus();
      }
      return;
    }
    if (!id || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
    e.preventDefault();
    const expandable = target.getAttribute('aria-expanded');
    if (e.key === 'ArrowRight' && expandable === 'false') toggle(id);
    else if (e.key === 'ArrowLeft' && expandable === 'true') toggle(id);
    else if (e.key === 'ArrowLeft') {
      // On a child: up to its parent's row.
      const parent = sessions.find((s) => s.id === id)?.parentSessionId;
      if (parent) e.currentTarget.querySelector<HTMLElement>(`[data-sidebar-row="${parent}"]`)?.focus();
    }
  };

  const renderTree = (t: TreeNode) =>
    visibleRows(t, isOpen).map((row) => (
      <TreeRow
        key={row.node.session.id}
        row={row}
        active={activeId === row.node.session.id}
        nextRunAt={nextRuns[row.node.session.id] ?? null}
        onToggle={toggle}
      />
    ));

  const olderOpen = collapsed[OLDER_KEY] === false;
  return (
    <div className="flex flex-col gap-px" onKeyDown={onKeyDown} {...held.bind}>
      {groups.map((g) => {
        if (!g.project) return <div key="" className="contents">{g.trees.map(renderTree)}</div>;
        const p = g.project;
        const open = collapsed[projectKey(p.id)] !== true;
        return (
          <div key={p.id} className="contents">
            <GroupHeading
              icon={p.repoPath ? <FolderGit2 size={13} strokeWidth={1.75} /> : <Folder size={13} strokeWidth={1.75} />}
              label={p.name}
              open={open}
              count={g.trees.length}
              onToggle={() => toggleCollapsed(projectKey(p.id), false)}
              menu={<ProjectMenu project={p} />}
            />
            {open && g.trees.map(renderTree)}
          </div>
        );
      })}
      {older.length > 0 && (
        <>
          <GroupHeading
            icon={null}
            label="以前"
            open={olderOpen}
            count={older.length}
            onToggle={() => toggleCollapsed(OLDER_KEY, true)}
          />
          {olderOpen && older.map(renderTree)}
        </>
      )}
    </div>
  );
}
