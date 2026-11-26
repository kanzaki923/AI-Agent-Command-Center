import type { FolderInspection, RepoInspection } from '@acc/protocol';

/**
 * `project.inspectRepo` (protocol `RepoInspection`) as the project form reads it: whether
 * the folder can become a project, and what to prefill.
 */
export type { FolderInspection, RepoInspection };

/** A failed check in the protocol's shape (the call itself failed, e.g. a bad path). */
export function failedInspection(reason: string): RepoInspection {
  return {
    ok: false,
    reason,
    repoRoot: null,
    defaultBranch: null,
    currentBranch: null,
    isDirty: null,
    suggestedName: null,
    suggestedTestCommand: null,
    existingProjectId: null,
  };
}

/** A failed folder check in the protocol's shape. */
export function failedFolder(reason: string): FolderInspection {
  return {
    ok: false,
    reason,
    path: null,
    isGitRepo: false,
    repoRoot: null,
    defaultBranch: null,
    suggestedName: null,
    suggestedTestCommand: null,
    existingProjectId: null,
  };
}

/**
 * What a folder becomes as a project: the root of a git repository is code (agents work in
 * their own worktree), anything else an ordinary folder (agents write in it directly).
 */
export type ProjectKind = 'code' | 'folder';

const normPath = (p: string) =>
  p
    .trim()
    .replace(/[\\/]+$/, '')
    .toLowerCase();

export function projectKindOf(f: FolderInspection): ProjectKind {
  return f.isGitRepo && f.repoRoot && f.path && normPath(f.repoRoot) === normPath(f.path)
    ? 'code'
    : 'folder';
}

/** Warning for uncommitted changes (null when clean or unknown). */
export function dirtyText(isDirty: boolean | null): string | null {
  return isDirty ? '未コミットの変更があります' : null;
}

/** `main` / `feature-x（既定は main）`: the checked-out branch, and the default when it differs. */
export function branchText(i: RepoInspection): string | null {
  if (!i.currentBranch) return i.defaultBranch;
  if (i.defaultBranch && i.defaultBranch !== i.currentBranch)
    return `${i.currentBranch}（既定は ${i.defaultBranch}）`;
  return i.currentBranch;
}
