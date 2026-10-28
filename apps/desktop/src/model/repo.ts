import type { RepoInspection } from '@acc/protocol';

/**
 * `project.inspectRepo` (protocol `RepoInspection`) as the project form reads it: whether
 * the folder can become a project, and what to prefill.
 */
export type { RepoInspection };

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

/**
 * The folder is inside a repository but is not its root: the daemon names the root, and
 * the form offers to use it instead (null otherwise).
 */
export function suggestedRoot(i: RepoInspection | null, typed: string): string | null {
  if (!i || i.ok || !i.repoRoot) return null;
  const norm = (p: string) => p.trim().replace(/[\\/]+$/, '').toLowerCase();
  return norm(i.repoRoot) === norm(typed) ? null : i.repoRoot;
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
