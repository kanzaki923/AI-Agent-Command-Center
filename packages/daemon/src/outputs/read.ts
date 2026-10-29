import { closeSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Artifact, Params, Result } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { ApiError, invalidParams } from '../core/errors';
import { toCsv } from './csv';
import { insideWorkspace, mimeTypeOf } from './paths';

type ReadResult = Result<'artifact.read'>;

/**
 * `artifact.read` (spec 20261029 §2.2): the content of an output in pages of `limit` bytes
 * (UTF-8, never cutting a character) from `offset`. Documents, notes, diffs and test output
 * come from the stored row; data as CSV; a link is its URL; one file of a `files` output is
 * read from the workspace (it must still lie inside it).
 */
export function readArtifact(ctx: DaemonContext, p: Params<'artifact.read'>): ReadResult {
  const a = ctx.service('artifacts').getStored(p.artifactId);
  if (a.kind === 'files' || (a.kind === 'file' && a.data.content === null)) {
    return readWorkspaceFile(ctx, a, p);
  }
  const { content, mimeType } = storedContent(a);
  return page(Buffer.from(content, 'utf8'), p.offset, p.limit, mimeType);
}

function storedContent(a: Artifact): { content: string; mimeType: string | null } {
  switch (a.kind) {
    case 'document':
      return {
        content: a.data.content,
        mimeType: a.data.format === 'markdown' ? 'text/markdown' : 'text/plain',
      };
    case 'note':
      return { content: a.data.text, mimeType: 'text/markdown' };
    case 'data':
      return { content: toCsv(a.data.columns, a.data.rows), mimeType: 'text/csv' };
    case 'link':
      return { content: a.data.url, mimeType: 'text/uri-list' };
    case 'diff':
      return { content: a.data.patch, mimeType: 'text/x-diff' };
    case 'commit':
      return { content: a.data.message, mimeType: 'text/plain' };
    case 'test_result':
      return { content: a.data.output ?? a.data.summary, mimeType: 'text/plain' };
    case 'file':
      return {
        content: a.data.content ?? '',
        mimeType: a.data.mimeType ?? mimeTypeOf(a.data.path),
      };
    case 'files':
      throw new Error('files are read from the workspace');
  }
}

function readWorkspaceFile(
  ctx: DaemonContext,
  a: Extract<Artifact, { kind: 'files' | 'file' }>,
  p: Params<'artifact.read'>,
): ReadResult {
  const entries =
    a.kind === 'files'
      ? a.data.files.map((f) => ({
          rel: a.data.root ? `${a.data.root}/${f.path}` : f.path,
          path: f.path,
          mimeType: f.mimeType,
        }))
      : [{ rel: a.data.path, path: a.data.path, mimeType: a.data.mimeType }];
  let entry: (typeof entries)[number] | undefined;
  if (p.path === undefined) {
    if (entries.length !== 1) {
      const names = entries.slice(0, 5).map((e) => e.path);
      throw invalidParams(
        `どのファイルを読むか path で指定してください（例: ${names.join('、')}${entries.length > 5 ? ' ほか' : ''}）`,
      );
    }
    entry = entries[0];
  } else {
    const want = p.path.split('\\').join('/').replace(/^\.\//, '');
    entry = entries.find((e) => e.path === want || e.rel === want);
    if (!entry) throw invalidParams(`この成果物に「${p.path}」は含まれていません`);
  }
  const ws = a.workspaceId ? ctx.repos.workspaces.get(a.workspaceId) : undefined;
  if (!ws || ws.status === 'removed' || ws.status === 'removing') {
    throw new ApiError('not_found', '作業場所が削除されたため、このファイルは読めません', {
      kind: 'workspace',
      id: a.workspaceId,
    });
  }
  if (!insideWorkspace(ws.path, entry!.rel)) {
    throw invalidParams(`「${entry!.path}」は作業場所の外を指しているため読めません`);
  }
  const abs = path.resolve(ws.path, entry!.rel);
  let size: number;
  try {
    const st = statSync(abs);
    if (!st.isFile()) throw new Error('not a file');
    size = st.size;
  } catch {
    throw new ApiError('not_found', `「${entry!.path}」は作業場所から削除されています`, {
      kind: 'file',
      id: entry!.path,
    });
  }
  // Read only the window (plus a few bytes to finish a character at its end).
  const start = Math.min(p.offset, size);
  const len = Math.min(size - start, p.limit + 3);
  const buf = Buffer.alloc(len);
  const fd = openSync(abs, 'r');
  try {
    readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  return page(buf, 0, p.limit, entry!.mimeType ?? mimeTypeOf(entry!.path), size - start);
}

/**
 * `limit` bytes of `buf` from `offset`, moved to UTF-8 character boundaries. `total` is the
 * length of the whole content from the start of `buf` (when `buf` is only a window of it).
 */
export function page(
  buf: Buffer,
  offset: number,
  limit: number,
  mimeType: string | null,
  total = buf.length,
): ReadResult {
  let start = Math.min(offset, buf.length);
  while (start < buf.length && isContinuation(buf[start]!)) start++;
  let end = Math.min(start + limit, buf.length);
  if (end < buf.length) {
    while (end > start && isContinuation(buf[end]!)) end--;
  }
  const slice = buf.subarray(start, end);
  if (slice.includes(0)) {
    throw invalidParams('テキストではないファイルは読めません（binary file）');
  }
  return { content: slice.toString('utf8'), mimeType, truncated: end < total };
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}
