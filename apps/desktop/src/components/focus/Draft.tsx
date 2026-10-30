import type { Project, WorkspaceSpec } from '@acc/protocol';
import { HomeComposer } from '../home/HomeComposer';

/** Key of the draft's text in the UI store (it survives leaving and coming back). */
export const DRAFT_KEY = '__new__';

export type DraftPlace = 'none' | 'folder' | 'worktree';

/** The workspace a new conversation gets for a place, or why it cannot have it. */
export function workspaceFor(place: DraftPlace, project: Project | null): WorkspaceSpec | null {
  if (place === 'folder') return project?.folderPath ? { kind: 'folder', path: project.folderPath } : null;
  if (place === 'worktree') return project?.repoPath ? { kind: 'worktree', projectId: project.id } : null;
  return { kind: 'none' };
}

/**
 * Ctrl+N (ui-rework spec §3.4, right-hand spec §2.1): the same field as the empty home, in the
 * middle. The first send goes to the assistant (with the chosen place to work as a hint) and
 * opens its conversation, where the answer or the new work shows up.
 */
export function Draft() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8" data-draft>
      <div className="w-full max-w-xl -translate-y-8">
        <HomeComposer center open draftKey={DRAFT_KEY} demo={false} />
      </div>
    </div>
  );
}
