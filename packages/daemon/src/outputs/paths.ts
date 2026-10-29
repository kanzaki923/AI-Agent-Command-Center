import { lstatSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Run, Workspace } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { invalidParams } from '../core/errors';
import { isInside, realpathDeep, touchesGitDir } from '../runtime/policy';

/** The workspace a run works in: the run's, else its session's, else its task's. */
export function workspaceOfRun(ctx: DaemonContext, run: Run): Workspace | null {
  const session = ctx.repos.sessions.get(run.sessionId);
  const task = run.taskId ? ctx.repos.tasks.get(run.taskId) : undefined;
  const id = run.workspaceId ?? session?.workspaceId ?? task?.workspaceId ?? null;
  return id ? (ctx.repos.workspaces.get(id) ?? null) : null;
}

/** Workspace-relative posix path ('' for the root itself). */
export function toRel(root: string, abs: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  return rel.split(path.sep).join('/');
}

/**
 * Whether `target` lies in `root` both as written and after resolving symlinks / junctions,
 * and does not touch a `.git` directory (the same test the tool gate applies to writes).
 */
export function insideWorkspace(root: string, target: string): boolean {
  const abs = path.resolve(root, target);
  if (!isInside(abs, root) || touchesGitDir(abs, root)) return false;
  return isInside(realpathDeep(abs), realpathDeep(root));
}

/**
 * Resolve a path an agent named (absolute, or relative to its workspace) to an existing file
 * or folder inside the workspace. Throws invalid_params with a reason the agent can act on.
 */
export function resolveInWorkspace(
  root: string,
  p: string,
): { abs: string; rel: string; isDirectory: boolean; size: number } {
  if (p.startsWith('~') || !insideWorkspace(root, p)) {
    throw invalidParams(
      `「${p}」は作業場所の外です。成果物にできるのは作業場所の中のファイルだけです（path is outside your workspace）`,
    );
  }
  const abs = path.resolve(root, p);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw invalidParams(`「${p}」が見つかりません（no such file in your workspace）`);
  }
  return { abs, rel: toRel(root, abs), isDirectory: st.isDirectory(), size: st.size };
}

/**
 * Files under a folder (depth first, sorted), skipping `.git` and symlinks (never followed out
 * of the workspace). Stops with invalid_params past `max` files.
 */
export function listFolder(
  root: string,
  absDir: string,
  max: number,
  out: { abs: string; rel: string; size: number }[] = [],
): { abs: string; rel: string; size: number }[] {
  const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const e of entries) {
    if (e.name === '.git' || e.isSymbolicLink()) continue;
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) {
      listFolder(root, abs, max, out);
    } else if (e.isFile()) {
      if (out.length >= max) {
        throw invalidParams(
          `ファイルが多すぎます（${max} 件まで）。公開するフォルダやファイルを絞ってください（too many files）`,
        );
      }
      out.push({ abs, rel: toRel(root, abs), size: lstatSync(abs).size });
    }
  }
  return out;
}

/** Longest common folder of workspace-relative posix paths ('' when they share none). */
export function commonFolder(rels: string[]): string {
  if (rels.length === 0) return '';
  const split = rels.map((r) => r.split('/').slice(0, -1));
  const first = split[0]!;
  let n = first.length;
  for (const parts of split.slice(1)) {
    let i = 0;
    while (i < n && i < parts.length && parts[i] === first[i]) i++;
    n = i;
  }
  return first.slice(0, n).join('/');
}

/** Path relative to `folder` (both workspace-relative posix). */
export function relTo(folder: string, rel: string): string {
  return folder ? rel.slice(folder.length + 1) : rel;
}

const MIME: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/x-typescript',
  tsx: 'text/x-typescript',
  jsx: 'text/javascript',
  py: 'text/x-python',
  rs: 'text/x-rust',
  go: 'text/x-go',
  java: 'text/x-java',
  sh: 'text/x-shellscript',
  sql: 'application/sql',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** MIME type by file extension; null when unknown. */
export function mimeTypeOf(p: string): string | null {
  const ext = path.extname(p).slice(1).toLowerCase();
  return MIME[ext] ?? null;
}
