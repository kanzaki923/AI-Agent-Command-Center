import { ChevronLeft, FileDiff, FileMinus2, FilePlus2, Maximize2, Minimize2 } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import { useUi } from '../../store/ui';
import type { DiffFile } from '../../model/diff';

function FileIcon({ f }: { f: DiffFile }) {
  if (f.deletions === 0 && f.additions > 0 && f.lines.every((l) => l.kind !== 'context'))
    return <FilePlus2 size={13} strokeWidth={1.5} className="text-st-completed" />;
  if (f.additions === 0 && f.deletions > 0) return <FileMinus2 size={13} strokeWidth={1.5} className="text-st-failed" />;
  return <FileDiff size={13} strokeWidth={1.5} className="text-fg-3" />;
}

export function DiffStatText({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="font-mono text-meta tabular">
      <span className="text-st-completed">+{additions}</span> <span className="text-st-failed">{`−${deletions}`}</span>
    </span>
  );
}

/** Unified diff of one file: mono 12.5px, line numbers in tertiary (§5.2). */
export function FileDiffView({ file }: { file: DiffFile }) {
  if (file.binary) return <div className="px-3 py-4 text-ui text-fg-3">バイナリファイルのため差分を表示できません</div>;
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
                  <td className="w-9 pr-1 text-right align-top text-fg-4 select-none tabular">{l.oldNo ?? ''}</td>
                  <td className="w-9 pr-2 text-right align-top text-fg-4 select-none tabular">{l.newNo ?? ''}</td>
                  <td
                    className={cn(
                      'pr-3 whitespace-pre',
                      l.kind === 'add' ? 'text-fg' : l.kind === 'del' ? 'text-fg-2' : 'text-fg-2',
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

/** File list (+/−) → selecting one shows its unified diff. */
export function DiffBrowser({ files }: { files: DiffFile[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const panelWidth = useUi((s) => s.panelWidth);
  const setPanelWidth = useUi((s) => s.setPanelWidth);
  const file = files.find((f) => f.path === selected) ?? null;
  if (file) {
    const wide = panelWidth >= 560;
    return (
      <div className="flex min-h-0 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line-subtle pr-2 pl-1">
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-sm px-2 text-left text-ui text-fg-2 hover:text-fg"
          >
            <ChevronLeft size={14} strokeWidth={1.5} />
            <span className="min-w-0 flex-1 truncate font-mono text-meta">{file.path}</span>
            <DiffStatText additions={file.additions} deletions={file.deletions} />
          </button>
          <button
            type="button"
            onClick={() => setPanelWidth(wide ? 360 : 560)}
            className="flex h-6 shrink-0 items-center gap-1 rounded-xs px-1.5 text-meta text-fg-3 hover:bg-hover hover:text-fg"
          >
            {wide ? <Minimize2 size={12} strokeWidth={1.75} /> : <Maximize2 size={12} strokeWidth={1.75} />}
            {wide ? '元に戻す' : '大きく開く'}
          </button>
        </div>
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
