/**
 * What `project.inspectRepo` (a newer daemon method) says about a folder, normalized. The
 * method is probed via system.info and its result shape is read tolerantly: the UI only
 * needs "is it a repository, where is its root, which branch, is the tree dirty, how is
 * it tested".
 */
export interface RepoInspection {
  /** The folder is (inside) a git repository. */
  isRepo: boolean;
  /** Repository root, when the daemon reports it. */
  root: string | null;
  /** Suggested project name (folder / package name). */
  name: string | null;
  /** Checked-out (or default) branch. */
  branch: string | null;
  /** Uncommitted changes: a count, `true` when only known to be dirty, 0 / false when clean. */
  dirty: number | boolean;
  /** Detected test command (`pnpm test`, `cargo test`, ...). */
  testCommand: string | null;
  /** Why it is not usable, in the daemon's words. */
  error: string | null;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function pickStr(o: Obj, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function pickBool(o: Obj, ...keys: string[]): boolean | null {
  for (const k of keys) if (typeof o[k] === 'boolean') return o[k];
  return null;
}

export function normalizeInspection(raw: unknown): RepoInspection {
  const o = isObj(raw) ? raw : {};
  const git = isObj(o.git) ? o.git : {};
  const status = isObj(o.status) ? o.status : {};
  const all: Obj = { ...git, ...status, ...o };
  const root = pickStr(all, 'root', 'repoRoot', 'toplevel', 'gitRoot', 'repoPath');
  const error = pickStr(all, 'error', 'reason', 'message');
  const isRepo = pickBool(all, 'isRepo', 'isGitRepo', 'isRepository', 'git', 'valid', 'ok') ?? (!!root && !error);

  let dirty: number | boolean = false;
  for (const k of ['uncommittedFiles', 'uncommittedCount', 'dirtyFiles', 'changes', 'changedFiles']) {
    const v = all[k];
    if (typeof v === 'number') {
      dirty = v;
      break;
    }
    if (Array.isArray(v)) {
      dirty = v.length;
      break;
    }
  }
  if (dirty === false) dirty = pickBool(all, 'dirty', 'isDirty', 'hasUncommittedChanges') ?? false;
  const testCmd = all.testCommand ?? all.suggestedTestCommand ?? all.detectedTestCommand;
  const testCommand = typeof testCmd === 'string' && testCmd.trim() ? testCmd.trim() : isObj(testCmd) ? pickStr(testCmd, 'command') : null;

  return {
    isRepo,
    root,
    name: pickStr(all, 'name', 'suggestedName', 'packageName'),
    branch: pickStr(all, 'branch', 'currentBranch', 'defaultBranch', 'head'),
    dirty,
    testCommand,
    error: isRepo ? null : (error ?? 'git リポジトリではありません'),
  };
}

/** `3 件の未コミットの変更` / `未コミットの変更` / null when clean. */
export function dirtyText(dirty: number | boolean): string | null {
  if (dirty === false || dirty === 0) return null;
  return typeof dirty === 'number' ? `未コミットの変更が ${dirty} 件あります` : '未コミットの変更があります';
}
