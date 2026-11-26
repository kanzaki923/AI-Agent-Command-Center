import type { Project } from '@acc/protocol';
import { ChevronLeft, ChevronRight, Folder, FolderGit2, GitBranch, Plus } from 'lucide-react';
import { useProjects } from '../../daemon/queries';
import type { ProjectsView } from '../../store/ui';
import { Button } from '../ui/Button';
import { EditProjectForm, NewProjectForm } from './ProjectDialog';

const NONE: Project[] = [];

function ProjectRow({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const Icon = project.repoPath ? FolderGit2 : Folder;
  const place = project.repoPath ?? project.folderPath;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-project-row={project.id}
      aria-label={`${project.name} の設定`}
      className="group flex h-12 w-full items-center gap-3 rounded-sm px-2 text-left hover:bg-hover focus-inset"
    >
      <Icon size={16} strokeWidth={1.75} className="shrink-0 text-fg-3" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui text-fg">{project.name}</span>
        {/* Long paths lose their start, not the folder's own name at the end. */}
        {place && (
          <span
            className="truncate text-left font-mono text-micro text-fg-3 [direction:rtl]"
            title={place}
          >
            <bdi dir="ltr">{place}</bdi>
          </span>
        )}
      </span>
      {project.repoPath && (
        <span className="flex shrink-0 items-center gap-1 font-mono text-meta text-fg-3">
          <GitBranch size={12} strokeWidth={2} />
          {project.defaultBranch ?? '未設定'}
        </span>
      )}
      <ChevronRight
        size={14}
        strokeWidth={1.75}
        className="shrink-0 text-fg-3"
      />
    </button>
  );
}

/**
 * The projects tab of the settings: every project in one place, to add one or change one
 * (name, default branch, test command, permissions). The add and edit forms open in the tab
 * itself, with a way back to the list.
 */
export function ProjectsPanel({
  view,
  onView,
}: {
  view: ProjectsView;
  onView: (v: ProjectsView) => void;
}) {
  const projects = (useProjects().data ?? NONE).filter((p) => !p.archivedAt);
  const toList = () => onView({ kind: 'list' });
  const editing =
    view.kind === 'edit' ? (projects.find((p) => p.id === view.projectId) ?? null) : null;

  if (view.kind === 'new' || editing) {
    return (
      <div className="flex flex-col gap-3 pt-2 pb-1">
        <button
          type="button"
          onClick={toList}
          className="-ml-1 flex h-7 w-fit items-center gap-0.5 rounded-sm pr-2 text-ui text-fg-3 hover:text-fg"
        >
          <ChevronLeft size={15} strokeWidth={1.75} />
          {editing ? editing.name : 'プロジェクトを追加'}
        </button>
        {editing ? (
          <EditProjectForm key={editing.id} project={editing} onDone={toList} removable />
        ) : (
          <NewProjectForm onDone={toList} />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-px pt-2 pb-1" data-testid="projects-panel">
      {projects.map((p) => (
        <ProjectRow
          key={p.id}
          project={p}
          onOpen={() => onView({ kind: 'edit', projectId: p.id })}
        />
      ))}
      <div className={projects.length > 0 ? 'mt-2 border-t border-line-subtle pt-3' : 'pt-1'}>
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus size={13} strokeWidth={2} />}
          onClick={() => onView({ kind: 'new' })}
        >
          プロジェクトを追加
        </Button>
      </div>
    </div>
  );
}
