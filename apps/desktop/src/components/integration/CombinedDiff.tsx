import { ChevronRight, FileDiff, FileMinus2, FilePlus2 } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { cn } from '../../lib/cn';
import type { DiffFile } from '../../model/diff';
import { DiffStatText, FileDiffView } from '../panel/DiffViewer';

/** Files larger than this start collapsed (the page stays fast; one click shows them). */
export const LARGE_FILE_LINES = 400;

export function initiallyCollapsed(f: DiffFile): boolean {
  return f.binary || f.lines.length > LARGE_FILE_LINES;
}

export function fileKind(f: DiffFile): 'added' | 'deleted' | 'modified' {
  if (f.deletions === 0 && f.additions > 0 && f.lines.every((l) => l.kind !== 'context')) return 'added';
  if (f.additions === 0 && f.deletions > 0 && f.lines.every((l) => l.kind !== 'context')) return 'deleted';
  return 'modified';
}

export function FileKindIcon({ f }: { f: DiffFile }) {
  const k = fileKind(f);
  if (k === 'added') return <FilePlus2 size={13} strokeWidth={1.5} className="shrink-0 text-st-completed" />;
  if (k === 'deleted') return <FileMinus2 size={13} strokeWidth={1.5} className="shrink-0 text-st-failed" />;
  return <FileDiff size={13} strokeWidth={1.5} className="shrink-0 text-fg-3" />;
}

/** Split `src/auth/session.ts` into a quiet directory and a readable file name. */
export function PathLabel({ path, className }: { path: string; className?: string }) {
  const i = path.lastIndexOf('/');
  return (
    <span className={cn('min-w-0 truncate font-mono text-meta', className)}>
      {i >= 0 && <span className="text-fg-3">{path.slice(0, i + 1)}</span>}
      <span className="text-fg">{path.slice(i + 1)}</span>
    </span>
  );
}

const FileSection = memo(function FileSection({
  file,
  collapsed,
  current,
  onToggle,
  onFocus,
}: {
  file: DiffFile;
  collapsed: boolean;
  current: boolean;
  onToggle: (path: string) => void;
  onFocus: (path: string) => void;
}) {
  return (
    <section
      data-diff-file={file.path}
      className={cn(
        'overflow-hidden rounded-md border bg-surface',
        current ? 'border-line-strong' : 'border-line-subtle',
      )}
    >
      <button
        type="button"
        onClick={() => {
          onFocus(file.path);
          onToggle(file.path);
        }}
        aria-expanded={!collapsed}
        className="sticky top-0 z-10 flex h-9 w-full items-center gap-2 border-b border-line-subtle bg-surface px-3 text-left hover:bg-hover"
      >
        <ChevronRight
          size={13}
          strokeWidth={1.75}
          className={cn('shrink-0 text-fg-4 transition-transform duration-[120ms]', !collapsed && 'rotate-90')}
        />
        <FileKindIcon f={file} />
        <PathLabel path={file.path} className="flex-1" />
        {file.oldPath && file.oldPath !== file.path && (
          <span className="truncate font-mono text-meta text-fg-4">← {file.oldPath}</span>
        )}
        <DiffStatText additions={file.additions} deletions={file.deletions} />
      </button>
      {!collapsed ? (
        <FileDiffView file={file} />
      ) : (
        initiallyCollapsed(file) && (
          <div className="px-3 py-2 text-meta text-fg-3">
            {file.binary ? 'バイナリファイル' : `大きな差分のため折りたたんでいます（${file.lines.length} 行）`}
          </div>
        )
      )}
    </section>
  );
});

export interface CombinedDiffState {
  current: string | null;
  setCurrent: (path: string | null) => void;
  collapsed: Record<string, boolean>;
  toggle: (path: string) => void;
  setAll: (collapsed: boolean) => void;
  isCollapsed: (f: DiffFile) => boolean;
}

/** Collapse + "current file" state, shared by the file index and the stacked diffs. */
export function useCombinedDiffState(files: DiffFile[]): CombinedDiffState {
  const [current, setCurrent] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const isCollapsed = (f: DiffFile) => collapsed[f.path] ?? initiallyCollapsed(f);
  // Stable callbacks: the memoized file sections only re-render when their own file changes.
  const toggle = useCallback(
    (path: string) =>
      setCollapsed((c) => {
        const f = files.find((x) => x.path === path);
        const cur = c[path] ?? (f ? initiallyCollapsed(f) : false);
        return { ...c, [path]: !cur };
      }),
    [files],
  );
  const setAll = useCallback(
    (v: boolean) => setCollapsed(Object.fromEntries(files.map((f) => [f.path, v]))),
    [files],
  );
  return { current, setCurrent, collapsed, isCollapsed, toggle, setAll };
}

/** Every changed file, stacked, each collapsible (GitHub-style review page). */
export function CombinedDiff({ files, state }: { files: DiffFile[]; state: CombinedDiffState }) {
  return (
    <div className="flex flex-col gap-3">
      {files.map((f) => (
        <FileSection
          key={f.path}
          file={f}
          collapsed={state.isCollapsed(f)}
          current={state.current === f.path}
          onToggle={state.toggle}
          onFocus={state.setCurrent}
        />
      ))}
    </div>
  );
}

/** Compact file index (left column): click to jump, current file highlighted. */
export function FileIndex({ files, state, onJump }: { files: DiffFile[]; state: CombinedDiffState; onJump: (path: string) => void }) {
  return (
    <ul className="flex flex-col">
      {files.map((f) => (
        <li key={f.path}>
          <button
            type="button"
            onClick={() => onJump(f.path)}
            className={cn(
              'flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left',
              state.current === f.path ? 'bg-selected' : 'hover:bg-hover',
            )}
          >
            <FileKindIcon f={f} />
            <PathLabel path={f.path} className="flex-1" />
            <DiffStatText additions={f.additions} deletions={f.deletions} />
          </button>
        </li>
      ))}
    </ul>
  );
}
