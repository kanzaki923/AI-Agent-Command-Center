import type { Artifact } from '@acc/protocol';
import { useState } from 'react';
import { outputKind, useOutputContent, useOutputs } from '../../daemon/outputs';
import { treeRelations, useSessionTree } from '../../daemon/tree';
import { cn } from '../../lib/cn';
import { sessionTitle } from '../../lib/states';
import { parsePatch } from '../../model/diff';
import { useUi } from '../../store/ui';
import { Markdown } from '../focus/Markdown';
import { DiffBrowser } from '../panel/DiffViewer';
import { ResizeHandle } from '../ui/ResizeHandle';
import { OutputIcon } from '../ui/SemanticIcons';

/**
 * Outputs beside a conversation (spec §6): only when the conversation (or one of its
 * descendants) has outputs; nothing otherwise. Owned by track U4; this entry point keeps its
 * props fixed: `sessionId` (the open conversation). Minimal content: the list (icon, title,
 * who made it) and the selected output below it.
 */
export function OutputsPanel({ sessionId }: { sessionId: string }) {
  const open = useUi((s) => s.panelOpen);
  const width = useUi((s) => s.panelWidth);
  const setWidth = useUi((s) => s.setPanelWidth);
  const tree = useSessionTree(sessionId).data;
  const rel = treeRelations(tree, sessionId);
  const outputs = (useOutputs(tree ? { rootSessionId: tree.rootSessionId } : null).data ?? []).filter(
    (a) => outputKind(a) && a.sessionId && rel.subtree.has(a.sessionId),
  );
  const [picked, setPicked] = useState<string | null>(null);
  if (!open || outputs.length === 0) return null;
  const selected = outputs.find((a) => a.id === picked) ?? outputs[0]!;
  const who = (id: string | null) => {
    const n = tree?.nodes.find((x) => x.id === id);
    return n && n.id !== sessionId ? sessionTitle(n) : null;
  };
  return (
    <aside
      aria-label="成果物"
      data-region="panel"
      className="relative flex h-full shrink-0 flex-col border-t border-l border-line-subtle bg-canvas"
      style={{ width }}
    >
      <ResizeHandle edge="left" width={width} onResize={setWidth} label="成果物の幅" />
      <ul className="flex max-h-[40%] shrink-0 flex-col gap-px overflow-y-auto border-b border-line-subtle p-1.5">
        {outputs.map((a) => {
          const kind = outputKind(a)!;
          const by = who(a.sessionId);
          return (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => setPicked(a.id)}
                aria-current={a.id === selected.id ? 'true' : undefined}
                className={cn(
                  'flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-ui',
                  a.id === selected.id ? 'bg-selected text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg',
                )}
              >
                <OutputIcon kind={kind} className="text-fg-3" />
                <span className="min-w-0 flex-1 truncate">{a.title}</span>
                {by && <span className="max-w-28 shrink-0 truncate text-meta text-fg-3">{by}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <OutputBody key={selected.id} artifact={selected} />
      </div>
    </aside>
  );
}

function OutputBody({ artifact }: { artifact: Artifact }) {
  switch (artifact.kind) {
    case 'document':
      return artifact.data.format === 'markdown' ? (
        <Markdown text={artifact.data.content} />
      ) : (
        <pre className="selectable text-ui whitespace-pre-wrap text-fg">{artifact.data.content}</pre>
      );
    case 'data':
      return (
        <table className="selectable w-full text-meta">
          <thead>
            <tr>
              {artifact.data.columns.map((c) => (
                <th key={c} className="border-b border-line px-2 py-1 text-left font-medium text-fg-2">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {artifact.data.rows.slice(0, 500).map((row, i) => (
              <tr key={i}>
                {row.map((v, j) => (
                  <td key={j} className="border-b border-line-subtle px-2 py-1 text-fg">
                    {typeof v === 'string' ? v : JSON.stringify(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'link':
      return (
        <a href={artifact.data.url} target="_blank" rel="noreferrer" className="text-ui break-all text-accent">
          {artifact.data.label ?? artifact.data.url}
        </a>
      );
    case 'files':
      return (
        <ul className="selectable flex flex-col gap-1 font-mono text-meta text-fg-2">
          {artifact.data.files.map((f) => (
            <li key={f.path}>{f.path}</li>
          ))}
        </ul>
      );
    case 'diff':
      return <DiffBrowser files={parsePatch(artifact.data.patch)} />;
    default:
      return <FallbackContent artifactId={artifact.id} />;
  }
}

function FallbackContent({ artifactId }: { artifactId: string }) {
  const content = useOutputContent(artifactId).data;
  return <pre className="selectable text-ui whitespace-pre-wrap text-fg">{content?.content ?? ''}</pre>;
}
