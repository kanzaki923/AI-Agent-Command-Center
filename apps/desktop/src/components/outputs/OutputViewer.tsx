import type { Artifact } from '@acc/protocol';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { ExternalLink, File, FolderOpen, Link } from 'lucide-react';
import { useState } from 'react';
import { useOutputContent } from '../../daemon/outputs';
import { useWorkspace } from '../../daemon/queries';
import { cn } from '../../lib/cn';
import { isTauri } from '../../lib/platform';
import { parsePatch } from '../../model/diff';
import { Markdown } from '../focus/Markdown';
import { Skeleton } from '../ui/Meta';
import { DiffBrowser } from './DiffViewer';
import { cellText, formatSize, isWebUrl, joinPath, parseCsv, previewKind } from './model';

/** Rows of a table shown at most (spec §6: the first 500). */
export const TABLE_ROWS = 500;

export function openWebUrl(url: string): void {
  if (!isWebUrl(url)) return;
  if (isTauri()) void openUrl(url).catch(() => {});
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/** The content of one output, by kind (document, data, files, link, code). */
export function OutputBody({ output }: { output: Artifact }) {
  switch (output.kind) {
    case 'document':
      return output.data.format === 'markdown' ? (
        <div className="selectable px-4 py-3">
          <Markdown text={output.data.content} />
        </div>
      ) : (
        <pre className="selectable px-4 py-3 text-ui whitespace-pre-wrap text-fg">
          {output.data.content}
        </pre>
      );
    case 'data':
      return <DataTable columns={output.data.columns} rows={output.data.rows} />;
    case 'link':
      return <LinkCard url={output.data.url} label={output.data.label ?? output.title} />;
    case 'files':
      return <FilesView output={output} />;
    case 'diff':
      return <DiffBrowser files={parsePatch(output.data.patch)} />;
    default:
      return null;
  }
}

/** A table: sticky header, numbers right-aligned, the first 500 rows. */
export function DataTable({
  columns,
  rows,
}: {
  columns: readonly string[];
  rows: readonly (readonly unknown[])[];
}) {
  const shown = rows.slice(0, TABLE_ROWS);
  const numeric = columns.map(
    (_, j) => shown.length > 0 && shown.every((r) => r[j] == null || typeof r[j] === 'number'),
  );
  // Short values stay on one line (the panel scrolls sideways); long text wraps in its column.
  const long = columns.map((_, j) => shown.some((r) => cellText(r[j]).length > 8));
  return (
    <div className="selectable w-max min-w-full">
      <table className="min-w-full border-separate border-spacing-0 text-meta">
        <thead>
          <tr>
            {columns.map((c, j) => (
              <th
                key={j}
                scope="col"
                className={cn(
                  'sticky top-0 border-b border-line bg-canvas px-3 py-1.5 font-medium whitespace-nowrap text-fg-2',
                  numeric[j] ? 'text-right' : 'text-left',
                )}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i} className="hover:bg-hover">
              {columns.map((_, j) => (
                <td
                  key={j}
                  className={cn(
                    'border-b border-line-subtle px-3 py-1 align-top text-fg',
                    numeric[j] && 'text-right tabular',
                    long[j] ? 'max-w-[18rem] min-w-[7rem]' : 'whitespace-nowrap',
                  )}
                >
                  {cellText(row[j])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && (
        <div className="px-3 py-2 text-meta text-fg-3 tabular" data-testid="rows-cut">
          {shown.length.toLocaleString()} / {rows.length.toLocaleString()} 行
        </div>
      )}
    </div>
  );
}

function LinkCard({ url, label }: { url: string; label: string }) {
  const web = isWebUrl(url);
  return (
    <div className="p-3">
      <button
        type="button"
        disabled={!web}
        onClick={() => openWebUrl(url)}
        className="group flex w-full items-start gap-3 rounded-md border border-line-subtle bg-surface px-3 py-2.5 text-left hover:border-line-strong hover:bg-hover"
      >
        <Link size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-accent" aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-ui font-medium text-fg">{label}</span>
          <span className="truncate font-mono text-meta text-fg-3">{url}</span>
        </span>
        {web && (
          <ExternalLink
            size={14}
            strokeWidth={1.75}
            className="mt-0.5 shrink-0 text-fg-3 group-hover:text-fg"
            aria-hidden
          />
        )}
      </button>
    </div>
  );
}

/**
 * Files in the workspace: the list (size; the folder button shows the file in the OS file
 * manager), and the chosen file's text below (Markdown rendered, CSV as a table). The first
 * file opens on its own.
 */
function FilesView({ output }: { output: Extract<Artifact, { kind: 'files' }> }) {
  const files = output.data.files;
  const [picked, setPicked] = useState<string | null>(null);
  const current = files.find((f) => f.path === picked) ?? files[0] ?? null;
  const ws = useWorkspace(output.workspaceId).data;
  const reveal =
    ws && isTauri()
      ? (path: string) =>
          void revealItemInDir(joinPath(ws.path, output.data.root, path)).catch(() => {})
      : null;
  return (
    <div className="flex flex-col">
      <ul
        className={cn(
          'flex flex-col py-1',
          current && files.length > 1 && 'border-b border-line-subtle',
        )}
      >
        {files.map((f) => {
          const i = f.path.lastIndexOf('/');
          return (
            <li key={f.path} className="group flex items-center">
              <button
                type="button"
                onClick={() => setPicked(f.path)}
                aria-current={current?.path === f.path ? 'true' : undefined}
                className={cn(
                  'flex h-7 min-w-0 flex-1 items-center gap-2 px-3 text-left',
                  current?.path === f.path && files.length > 1 ? 'bg-selected' : 'hover:bg-hover',
                )}
              >
                <File size={13} strokeWidth={1.5} className="shrink-0 text-fg-3" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono text-meta">
                  {i >= 0 && <span className="text-fg-3">{f.path.slice(0, i + 1)}</span>}
                  <span className="text-fg">{f.path.slice(i + 1)}</span>
                </span>
                <span className="shrink-0 text-meta text-fg-3 tabular">{formatSize(f.size)}</span>
              </button>
              {reveal && (
                <button
                  type="button"
                  aria-label="フォルダで表示"
                  title="フォルダで表示"
                  onClick={() => reveal(f.path)}
                  className="mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-3 opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100"
                >
                  <FolderOpen size={13} strokeWidth={1.75} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {current && (
        <FilePreview
          key={current.path}
          artifactId={output.id}
          path={current.path}
          mimeType={current.mimeType}
        />
      )}
    </div>
  );
}

function FilePreview({
  artifactId,
  path,
  mimeType,
}: {
  artifactId: string;
  path: string;
  mimeType: string | null;
}) {
  const kind = previewKind(path, mimeType);
  const q = useOutputContent(kind ? artifactId : null, path);
  if (!kind) return <p className="px-4 py-3 text-meta text-fg-3">この形式は表示できません</p>;
  if (q.isPending) return <Skeleton className="mx-4 my-3 h-24" />;
  if (q.isError || !q.data)
    return <p className="px-4 py-3 text-meta text-fg-3">読み込めませんでした</p>;
  const text = q.data.content;
  if (kind === 'csv') {
    const [head = [], ...rows] = parseCsv(text);
    return <DataTable columns={head} rows={rows} />;
  }
  return kind === 'markdown' ? (
    <div className="selectable px-4 py-3">
      <Markdown text={text} />
    </div>
  ) : (
    <pre className="selectable overflow-x-auto px-4 py-3 font-mono text-code whitespace-pre text-fg">
      {text}
    </pre>
  );
}
