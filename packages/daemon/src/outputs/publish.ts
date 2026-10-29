import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type Actor, type Artifact, OUTPUT_LIMITS, type Params } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { invalidParams } from '../core/errors';
import { parseCsv } from './csv';
import {
  commonFolder,
  listFolder,
  mimeTypeOf,
  relTo,
  resolveInWorkspace,
  workspaceOfRun,
} from './paths';

type PublishParams = Params<'artifact.publish'>;
type DataTable = { columns: string[]; rows: unknown[][] };

/**
 * `artifact.publish` (spec 20261029 §2.2): an agent leaves an output of its run. It belongs to
 * the calling run (session, task, workspace); paths must lie inside that run's workspace and
 * are checked like the tool gate checks writes (as written and after resolving links, never
 * `.git`). Limits: documents 1 MB, tables 5,000 rows / 2 MB, 500 files.
 */
export function publishArtifact(ctx: DaemonContext, p: PublishParams, actor: Actor): Artifact {
  if (actor.kind !== 'agent') {
    throw invalidParams(
      'artifact.publish はエージェントの実行から呼び出してください（成果物を残す会話が決まらないため）',
    );
  }
  const run = ctx.repos.runs.require(actor.runId);
  const ws = workspaceOfRun(ctx, run);
  const root = ws && ws.status === 'ready' ? ws.path : null;
  const needRoot = (): string => {
    if (root) return root;
    throw invalidParams(
      'この会話には作業場所がないため path は使えません。content（data は columns と rows）で渡してください（no workspace）',
    );
  };
  const base = {
    title: p.title.trim(),
    summary: oneLine(p.summary),
    sessionId: run.sessionId,
    runId: run.id,
    taskId: run.taskId,
    workspaceId: ws?.id ?? null,
    projectId: run.projectId ?? ws?.projectId ?? null,
    source: 'published' as const,
    createdBy: actor,
  };
  const artifacts = ctx.service('artifacts');

  switch (p.kind) {
    case 'document': {
      if ((p.content === undefined) === (p.path === undefined)) {
        throw invalidParams('document には content か path のどちらか一方を指定してください');
      }
      const format = documentFormat(p.format, p.path);
      if (p.content !== undefined) {
        return artifacts.record({
          ...base,
          kind: 'document',
          data: { format, content: p.content, path: null },
        });
      }
      const file = resolveFile(needRoot(), p.path!, OUTPUT_LIMITS.documentChars, '1 MB');
      return artifacts.record({
        ...base,
        kind: 'document',
        data: { format, content: readText(file.abs, p.path!), path: file.rel },
      });
    }

    case 'data': {
      const hasInline = p.columns !== undefined || p.rows !== undefined;
      if (hasInline === (p.path !== undefined)) {
        throw invalidParams('data には columns と rows か、path のどちらか一方を指定してください');
      }
      let format: 'csv' | 'json';
      let table: DataTable;
      let rel: string | null = null;
      if (p.path !== undefined) {
        const file = resolveFile(needRoot(), p.path, OUTPUT_LIMITS.dataBytes, '2 MB');
        format = dataFormat(p.format, p.path);
        const text = readText(file.abs, p.path);
        table = format === 'csv' ? tableFromCsv(text) : tableFromJson(text);
        rel = file.rel;
      } else {
        if (!p.columns || !p.rows)
          throw invalidParams('data には columns と rows の両方が必要です');
        format = p.format === 'csv' ? 'csv' : 'json';
        table = { columns: p.columns, rows: p.rows };
      }
      const checked = checkTable(table);
      return artifacts.record({
        ...base,
        kind: 'data',
        data: { format, columns: checked.columns, rows: checked.rows, path: rel },
      });
    }

    case 'link': {
      if (!p.url) throw invalidParams('link には url を指定してください');
      return artifacts.record({
        ...base,
        kind: 'link',
        data: { url: checkUrl(p.url), label: null },
      });
    }

    case 'files': {
      if (!p.paths || p.paths.length === 0) {
        throw invalidParams(
          'files には paths（作業場所の中のファイルかフォルダ）を指定してください',
        );
      }
      const wsRoot = needRoot();
      const found = new Map<string, { rel: string; size: number }>();
      for (const raw of p.paths) {
        const hit = resolveInWorkspace(wsRoot, raw);
        const files = hit.isDirectory
          ? listFolder(wsRoot, hit.abs, OUTPUT_LIMITS.files)
          : [{ abs: hit.abs, rel: hit.rel, size: hit.size }];
        for (const f of files) {
          found.set(f.rel, { rel: f.rel, size: f.size });
          if (found.size > OUTPUT_LIMITS.files) {
            throw invalidParams(
              `ファイルが多すぎます（${OUTPUT_LIMITS.files} 件まで）。公開するフォルダやファイルを絞ってください（too many files）`,
            );
          }
        }
      }
      if (found.size === 0) throw invalidParams('公開できるファイルがありません（no files）');
      const rels = [...found.keys()].sort();
      const folder = commonFolder(rels);
      return artifacts.record({
        ...base,
        kind: 'files',
        data: {
          root: folder,
          files: rels.map((r) => ({
            path: relTo(folder, r),
            size: found.get(r)!.size,
            mimeType: mimeTypeOf(r),
          })),
        },
      });
    }
  }
}

function oneLine(s: string | undefined): string | null {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t ? t : null;
}

function documentFormat(format: string | undefined, p: string | undefined): 'markdown' | 'text' {
  if (format === undefined) return p && /\.txt$/i.test(p) ? 'text' : 'markdown';
  if (format === 'markdown' || format === 'text') return format;
  throw invalidParams(`document の format は markdown か text です（「${format}」は使えません）`);
}

function dataFormat(format: string | undefined, p: string): 'csv' | 'json' {
  const f = format ?? path.extname(p).slice(1).toLowerCase();
  if (f === 'csv' || f === 'json') return f;
  throw invalidParams(
    `data のファイルは CSV か JSON です。format に csv か json を指定してください（「${p}」）`,
  );
}

function resolveFile(root: string, p: string, maxBytes: number, shown: string) {
  const hit = resolveInWorkspace(root, p);
  if (hit.isDirectory) {
    throw invalidParams(`「${p}」はフォルダです。フォルダは files として公開してください`);
  }
  if (hit.size > maxBytes) {
    throw invalidParams(`「${p}」は大きすぎます（${shown} まで）。files として公開してください`);
  }
  return hit;
}

function readText(abs: string, shown: string): string {
  const buf = readFileSync(abs);
  if (buf.includes(0)) {
    throw invalidParams(`「${shown}」はテキストではありません。files として公開してください`);
  }
  return buf.toString('utf8');
}

function tableFromCsv(text: string): DataTable {
  const lines = parseCsv(text);
  const header = lines[0];
  if (!header || header.length === 0) throw invalidParams('CSV に見出しの行がありません');
  return { columns: header, rows: lines.slice(1) };
}

/** JSON tables: an array of objects, `{ columns, rows }`, or an array of arrays (header first). */
function tableFromJson(text: string): DataTable {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw invalidParams(`JSON を読み取れません: ${(err as Error).message}`);
  }
  if (Array.isArray(raw) && raw.every((r) => Array.isArray(r))) {
    const [header, ...rows] = raw as unknown[][];
    if (!header) throw invalidParams('JSON の表が空です');
    return { columns: header.map((c) => String(c)), rows };
  }
  if (Array.isArray(raw) && raw.every((r) => typeof r === 'object' && r !== null)) {
    const columns: string[] = [];
    for (const r of raw as Record<string, unknown>[]) {
      for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
    }
    const rows = (raw as Record<string, unknown>[]).map((r) => columns.map((c) => r[c] ?? null));
    return { columns, rows };
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const o = raw as { columns?: unknown; rows?: unknown };
    if (Array.isArray(o.columns) && Array.isArray(o.rows) && o.rows.every(Array.isArray)) {
      return { columns: o.columns.map((c) => String(c)), rows: o.rows as unknown[][] };
    }
  }
  throw invalidParams(
    'JSON の表は、オブジェクトの配列、{ columns, rows }、または見出しを先頭にした配列の配列にしてください',
  );
}

function checkTable(t: DataTable): DataTable {
  if (t.columns.length === 0) throw invalidParams('data の columns が空です');
  if (t.rows.length > OUTPUT_LIMITS.dataRows) {
    throw invalidParams(
      `表の行が多すぎます（${t.rows.length} 行。${OUTPUT_LIMITS.dataRows} 行まで）。files として公開してください`,
    );
  }
  const rows = t.rows.map((r, i) => {
    if (r.length > t.columns.length) {
      throw invalidParams(
        `${i + 1} 行目の値の数（${r.length}）が列の数（${t.columns.length}）より多いです`,
      );
    }
    return r.length < t.columns.length
      ? [...r, ...Array<null>(t.columns.length - r.length).fill(null)]
      : r;
  });
  const bytes = Buffer.byteLength(JSON.stringify({ columns: t.columns, rows }), 'utf8');
  if (bytes > OUTPUT_LIMITS.dataBytes) {
    throw invalidParams('表が大きすぎます（2 MB まで）。files として公開してください');
  }
  return { columns: t.columns, rows };
}

function checkUrl(raw: string): string {
  const s = raw.trim();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw invalidParams(`URL として読めません: ${s}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw invalidParams(`link に使えるのは http / https の URL だけです（${u.protocol}）`);
  }
  return s;
}
