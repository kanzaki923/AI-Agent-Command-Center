import { ChevronLeft, FileDiff, FileMinus2, FilePlus2 } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import type { DiffFile } from '../../model/diff';

function FileIcon({ f }: { f: DiffFile }) {
  if (f.deletions === 0 && f.additions > 0 && f.lines.every((l) => l.kind !== 'context'))
    return <FilePlus2 size={13} strokeWidth={1.5} className="shrink-0 text-st-completed" />;
  if (f.additions === 0 && f.deletions > 0)
    return <FileMinus2 size={13} strokeWidth={1.5} className="shrink-0 text-st-failed" />;
  return <FileDiff size={13} strokeWidth={1.5} className="shrink-0 text-fg-3" />;
}

export function DiffStatText({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-meta tabular">
      {/* Zero sides stay quiet: colour is for change. */}
      <span className={additions > 0 ? 'text-st-completed' : 'text-fg-4'}>+{additions}</span>{' '}
      <span className={deletions > 0 ? 'text-st-failed' : 'text-fg-4'}>{`−${deletions}`}</span>
    </span>
  );
}

/** Unified diff of one file: mono 12.5px, line numbers in tertiary (§5.2). */
export function FileDiffView({ file }: { file: DiffFile }) {
  if (file.binary) return <div className="px-3 py-4 text-ui text-fg-3">バイナリファイル</div>;
  return (
    <div className="selectable overflow-x-auto font-mono text-code">
      <table className="w-full border-collapse">
        <tbody>
          {file.lines.map((l, i) => (
            <tr
              key={i}
              className={cn(
                l.kind === 'add' && 'bg-[color-mix(in_oklch,var(--st-completed)_10%,transparent)]',
                l.kind === 'del' && 'bg-[color-mix(in_oklch,var(--st-failed)_10%,transparent)]',
                l.kind === 'hunk' && 'bg-hover',
              )}
            >
              {l.kind === 'hunk' ? (
                <td colSpan={3} className="px-3 py-0.5 text-fg-3">
                  {l.text}
                </td>
              ) : (
                <>
                  <td className="w-9 pr-1 text-right align-top text-fg-3 select-none tabular">
                    {l.oldNo ?? ''}
                  </td>
                  <td className="w-9 pr-2 text-right align-top text-fg-3 select-none tabular">
                    {l.newNo ?? ''}
                  </td>
                  <td
                    className={cn(
                      'pr-3 whitespace-pre',
                      l.kind === 'add' ? 'text-fg' : 'text-fg-2',
                    )}
                  >
                    <span className="inline-block w-3 text-fg-4 select-none">
                      {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                    </span>
                    {l.text}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The code viewer of the outputs panel: the changed files (+/−); choosing one shows its
 * unified diff. A change of one file opens on it at once.
 */
export function DiffBrowser({ files }: { files: DiffFile[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const file = files.length === 1 ? files[0]! : (files.find((f) => f.path === selected) ?? null);
  if (file) {
    return (
      <div className="flex min-h-0 flex-col">
        {files.length > 1 ? (
          <button
            type="button"
            onClick={() => setSelected(null)}
            aria-label="ファイルの一覧へ"
            className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line-subtle px-2 text-left text-fg-2 hover:text-fg"
          >
            <ChevronLeft size={14} strokeWidth={1.5} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate font-mono text-meta">{file.path}</span>
            <DiffStatText additions={file.additions} deletions={file.deletions} />
          </button>
        ) : (
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line-subtle px-3">
            <FileIcon f={file} />
            <span className="min-w-0 flex-1 truncate font-mono text-meta text-fg-2">
              {file.path}
            </span>
            <DiffStatText additions={file.additions} deletions={file.deletions} />
          </div>
        )}
        <FileDiffView file={file} />
      </div>
    );
  }
  return (
    <div className="flex flex-col py-1">
      {files.map((f) => (
        <button
          key={f.path}
          type="button"
          onClick={() => setSelected(f.path)}
          className="flex h-7 items-center gap-2 px-3 text-left hover:bg-hover"
        >
          <FileIcon f={f} />
          <span className="min-w-0 flex-1 truncate font-mono text-meta text-fg-2">{f.path}</span>
          <DiffStatText additions={f.additions} deletions={f.deletions} />
        </button>
      ))}
    </div>
  );
}
