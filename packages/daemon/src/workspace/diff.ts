import { randomUUID } from 'node:crypto';
import { copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DiffFileStat, DiffStats } from '@acc/protocol';
import { invalidParams } from '../core/errors';
import { git, gitOut, resolveCommit } from './git';

/** SHA-1 of the empty tree: the base for a diff when nothing has been committed yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Patches larger than this are cut (the per-file stats stay complete). */
export const MAX_PATCH_CHARS = 2_000_000;

export interface ComputedDiff {
  /** Commit the diff is taken against (merge-base with the base ref), null = empty tree. */
  baseSha: string | null;
  headSha: string | null;
  patch: string;
  truncated: boolean;
  files: DiffFileStat[];
  stats: DiffStats;
}

const STATUS: Record<string, DiffFileStat['status']> = {
  A: 'added',
  M: 'modified',
  T: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
};

/**
 * Diff of the working tree of `cwd` — committed, staged, unstaged AND untracked files —
 * against the merge-base of HEAD and `baseRef` (HEAD itself when no baseRef).
 *
 * Untracked files are included by staging everything into a throwaway copy of the index
 * (GIT_INDEX_FILE), so the agent's real index is never touched.
 */
export async function computeDiff(cwd: string, baseRef: string | null): Promise<ComputedDiff> {
  const head = await resolveCommit(cwd, 'HEAD');
  let base: string | null = head;
  if (baseRef) {
    const b = await resolveCommit(cwd, baseRef);
    if (!b) throw invalidParams(`比較元の ref「${baseRef}」が見つかりません`);
    base = head ? await gitOut(cwd, ['merge-base', b, head]).catch(() => b) : b;
  }

  const realIndex = resolve(cwd, await gitOut(cwd, ['rev-parse', '--git-path', 'index']));
  const tmpIndex = join(tmpdir(), `acc-index-${randomUUID()}`);
  try {
    // Copying keeps the stat cache, so `add -A` only re-hashes files that changed.
    await copyFile(realIndex, tmpIndex).catch(() => undefined);
    const env = { GIT_INDEX_FILE: tmpIndex };
    await git(cwd, ['add', '-A'], { env });
    const range = base ?? EMPTY_TREE;
    const common = ['diff', '--cached', '-M', '--no-color', '--no-ext-diff', '--no-textconv'];
    const [patchRes, numstatRes, nameStatusRes] = await Promise.all([
      git(cwd, [...common, range], { env }),
      git(cwd, [...common, '--numstat', '-z', range], { env }),
      git(cwd, [...common, '--name-status', '-z', range], { env }),
    ]);
    const files = mergeStats(
      parseNumstatZ(numstatRes.stdout),
      parseNameStatusZ(nameStatusRes.stdout),
    );
    let patch = patchRes.stdout;
    const truncated = patch.length > MAX_PATCH_CHARS;
    if (truncated) {
      patch = `${patch.slice(0, MAX_PATCH_CHARS)}\n… (差分が大きいため省略しました)\n`;
    }
    return {
      baseSha: base,
      headSha: head,
      patch,
      truncated,
      files,
      stats: {
        files: files.length,
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
      },
    };
  } finally {
    await rm(tmpIndex, { force: true }).catch(() => undefined);
  }
}

export interface NumstatEntry {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** Parse `git diff --numstat -z` (renames: `a\td\t\0old\0new\0`; binary: `-\t-\tpath`). */
export function parseNumstatZ(out: string): NumstatEntry[] {
  const tokens = out.split('\0');
  const entries: NumstatEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === '') continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(t);
    if (!m) continue;
    const binary = m[1] === '-';
    const additions = binary ? 0 : Number(m[1]);
    const deletions = binary ? 0 : Number(m[2]);
    if (m[3] === '') {
      const oldPath = tokens[++i] ?? '';
      const path = tokens[++i] ?? '';
      entries.push({ path, oldPath, additions, deletions, binary });
    } else {
      entries.push({ path: m[3]!, additions, deletions, binary });
    }
  }
  return entries;
}

export interface NameStatusEntry {
  status: DiffFileStat['status'];
  path: string;
  oldPath?: string;
}

/** Parse `git diff --name-status -z` (`M\0path\0`, `R100\0old\0new\0`). */
export function parseNameStatusZ(out: string): NameStatusEntry[] {
  const tokens = out.split('\0');
  const entries: NameStatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i]!;
    if (code === '') continue;
    const letter = code[0]!;
    const status = STATUS[letter] ?? 'unknown';
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[++i] ?? '';
      const path = tokens[++i] ?? '';
      entries.push({ status, path, oldPath });
    } else {
      entries.push({ status, path: tokens[++i] ?? '' });
    }
  }
  return entries;
}

export function mergeStats(numstat: NumstatEntry[], nameStatus: NameStatusEntry[]): DiffFileStat[] {
  const byPath = new Map(numstat.map((n) => [n.path, n]));
  return nameStatus.map((s) => {
    const n = byPath.get(s.path);
    const file: DiffFileStat = {
      path: s.path,
      status: s.status,
      additions: n?.additions ?? 0,
      deletions: n?.deletions ?? 0,
    };
    if (s.oldPath) file.oldPath = s.oldPath;
    return file;
  });
}
