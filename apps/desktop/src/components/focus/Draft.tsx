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
 * A new conversation before its first message (Ctrl+N, ui-rework spec §3.4): the same field
 * as the empty home, in the middle. Nothing exists until the first send, which creates the
 * conversation (with the chosen place to work) and opens it.
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
