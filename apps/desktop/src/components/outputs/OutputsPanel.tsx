import type { Integration, SessionCard } from '@acc/protocol';
import { Circle, CircleCheck, Maximize2, PanelRightClose } from 'lucide-react';
import { useState } from 'react';
import { useOutputs } from '../../daemon/outputs';
import { useIntegrations, useSessions } from '../../daemon/queries';
import { treeRelations, useSessionTree } from '../../daemon/tree';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { cn } from '../../lib/cn';
import { OUTPUT_META, sessionTitle } from '../../lib/states';
import { useUi } from '../../store/ui';
import { IconButton } from '../ui/Button';
import { CopyButton } from '../ui/CopyButton';
import { ResizeHandle } from '../ui/ResizeHandle';
import { OutputIcon } from '../ui/SemanticIcons';
import { StateIcon } from '../ui/StateIcon';
import { Tooltip } from '../ui/Tooltip';
import { DiffStatText } from './DiffViewer';
import { type Output, type ReviewPhase, dockedPanelQuery, doneWhenMet, panelOutputs, reviewPhase } from './model';
import { OutputBody } from './OutputViewer';
import { PhaseMark, ReviewBar } from './ReviewBar';

const NONE_A: never[] = [];
const NONE_I: Integration[] = [];

/**
 * Outputs beside a conversation (ui-redesign spec §6). Only when the conversation or one of
 * its descendants has outputs; nothing otherwise. Open: the completion conditions of the
 * request (✓ once the work produced its outputs), the outputs (icon, title, who made it,
 * where the decision stands; waiting for you first) and the chosen one below with its
 * decision (採用 / やり直す; code: 反映). Closed (Ctrl+.): a thin rail of the outputs' icons.
 *
 * Owned by track U4; the entry point keeps its props fixed: `sessionId` (the open conversation).
 */
export function OutputsPanel({ sessionId }: { sessionId: string }) {
  const open = useUi((s) => s.panelOpen);
  const setOpen = useUi((s) => s.setPanelOpen);
  const tree = useSessionTree(sessionId).data;
  const rel = treeRelations(tree, sessionId);
  const all = useOutputs(tree ? { rootSessionId: tree.rootSessionId } : null).data ?? NONE_A;
  const outputs = panelOutputs(all, rel.subtree);
  // The choice belongs to one conversation: another conversation starts on its own first output.
  const [picked, setPicked] = useState<{ sessionId: string; id: string } | null>(null);
  if (outputs.length === 0) return null;
  const selected =
    outputs.find((o) => picked?.sessionId === sessionId && o.id === picked.id) ?? outputs[0]!;
  const pick = (id: string) => setPicked({ sessionId, id });
  if (!open) {
    return (
      <OutputsRail
        outputs={outputs}
        onPick={(id) => {
          pick(id);
          setOpen(true);
        }}
      />
    );
  }
  return (
    <Panel
      sessionId={sessionId}
      nodes={tree?.nodes ?? NONE_A}
      self={rel.self}
      outputs={outputs}
      selected={selected}
      onPick={pick}
    />
  );
}

function Panel({
  sessionId,
  nodes,
  self,
  outputs,
  selected,
  onPick,
}: {
  sessionId: string;
  nodes: readonly SessionCard[];
  self: SessionCard | null;
  outputs: Output[];
  selected: Output;
  onPick: (id: string) => void;
}) {
  const width = useUi((s) => s.panelWidth);
  const setWidth = useUi((s) => s.setPanelWidth);
  const togglePanel = useUi((s) => s.togglePanel);
  const sidebarWidth = useUi((s) => (s.sidebarOpen ? s.sidebarWidth : 0));
  // No room beside the conversation: the panel floats over it (Esc closes).
  const narrow = !useMediaQuery(dockedPanelQuery(sidebarWidth, width));
  const integrations = useIntegrations().data ?? NONE_I;
  const brief = useSessions().data?.find((s) => s.id === sessionId)?.brief ?? null;
  const doneWhen = brief?.doneWhen ?? [];
  const mine = outputs.filter((o) => o.sessionId === sessionId);
  const met = doneWhenMet(self?.state, mine);
  /** The child that made an output (nothing for the open conversation's own). */
  const maker = (o: Output) =>
    o.sessionId && o.sessionId !== sessionId
      ? (nodes.find((n) => n.id === o.sessionId) ?? null)
      : null;

  return (
    <aside
      aria-label="成果物"
      data-region="panel"
      data-overlay={narrow ? 'true' : undefined}
      className={cn(
        'flex h-full shrink-0 flex-col border-t border-l border-line-subtle bg-canvas',
        narrow ? 'absolute top-0 right-0 bottom-0 z-20 shadow-float' : 'relative',
      )}
      style={{ width }}
    >
      <ResizeHandle edge="left" width={width} onResize={setWidth} label="成果物の幅" />
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line-subtle pr-1.5 pl-3">
        <span className="text-micro text-fg-3">成果物</span>
        {outputs.length > 1 && (
          <span className="text-micro text-fg-3 tabular">{outputs.length}</span>
        )}
        <span className="flex-1" />
        <IconButton label="閉じる" shortcut="togglePanel" size="sm" onClick={togglePanel}>
          <PanelRightClose size={14} strokeWidth={1.75} />
        </IconButton>
      </header>

      {doneWhen.length > 0 && (
        <ul
          aria-label="完了条件"
          className="flex shrink-0 flex-col gap-1 border-b border-line-subtle px-3 py-2"
        >
          {doneWhen.map((c) => (
            <li key={c} className="flex items-start gap-2 text-meta" data-met={met}>
              {met ? (
                <CircleCheck
                  size={13}
                  strokeWidth={2}
                  className="mt-px shrink-0 text-st-done"
                  aria-label="満たした"
                />
              ) : (
                <Circle
                  size={13}
                  strokeWidth={1.75}
                  className="mt-px shrink-0 text-fg-3"
                  aria-label="まだ"
                />
              )}
              <span className={met ? 'text-fg-2' : 'text-fg'}>{c}</span>
            </li>
          ))}
        </ul>
      )}

      {outputs.length > 1 ? (
        <ul
          aria-label="成果物の一覧"
          className="flex max-h-[40%] shrink-0 flex-col gap-px overflow-y-auto border-b border-line-subtle p-1.5"
        >
          {outputs.map((o) => (
            <li key={o.id}>
              <OutputRow
                output={o}
                by={maker(o)}
                phase={reviewPhase(o, integrations)}
                selected={o.id === selected.id}
                onPick={() => onPick(o.id)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <div className="shrink-0 border-b border-line-subtle px-1.5 py-1">
          <OutputRow
            output={selected}
            by={maker(selected)}
            phase={reviewPhase(selected, integrations)}
            selected
            single
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto" data-output-body={selected.uiKind}>
        <OutputBody key={selected.id} output={selected} />
      </div>
      {/* Deciding pins the choice: the decided output moves down the list, the view stays on it. */}
      <ReviewBar key={selected.id} output={selected} onDecide={() => onPick(selected.id)} />
    </aside>
  );
}

/**
 * One output: icon, title (the one-line summary on hover), code's +/−, the child that made it
 * (opens that conversation) and where its decision stands. The chosen one also carries its
 * actions (広げる for code, copy for a document; a link opens from its card). `single`: the only output,
 * shown as the viewer's heading (the bar below says where the decision stands).
 */
function OutputRow({
  output,
  by,
  phase,
  selected,
  single = false,
  onPick,
}: {
  output: Output;
  by: SessionCard | null;
  phase: ReviewPhase;
  selected: boolean;
  single?: boolean;
  onPick?: () => void;
}) {
  const openSession = useUi((s) => s.openSession);
  const openIntegration = useUi((s) => s.openIntegration);
  const head = (
    <>
      <OutputIcon kind={output.uiKind} className={selected ? 'text-fg-2' : 'text-fg-3'} />
      <Tooltip content={output.summary}>
        <span className={cn('min-w-0 flex-1 truncate', single && 'font-medium')}>
          {/* Named after the child beside it: say its kind instead of the same title twice. */}
          {by && output.title.trim() === sessionTitle(by).trim() ? OUTPUT_META[output.uiKind].label : output.title}
        </span>
      </Tooltip>
      {output.kind === 'diff' && !single && (
        <DiffStatText
          additions={output.data.stats.additions}
          deletions={output.data.stats.deletions}
        />
      )}
    </>
  );
  return (
    <div
      className={cn(
        'flex h-8 items-center gap-1 rounded-sm pr-1 text-ui',
        single
          ? 'text-fg'
          : selected
            ? 'bg-selected text-fg'
            : 'text-fg-2 hover:bg-hover hover:text-fg',
        phase.kind === 'sent_back' && !selected && 'text-fg-3',
      )}
      data-output={output.id}
    >
      {single ? (
        <h2 className="flex min-w-0 flex-1 items-center gap-2 pl-1.5">{head}</h2>
      ) : (
        <button
          type="button"
          onClick={onPick}
          aria-current={selected ? 'true' : undefined}
          className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 text-left"
        >
          {head}
        </button>
      )}
      {by && (
        <button
          type="button"
          onClick={() => openSession(by.id)}
          aria-label={`${sessionTitle(by)} を開く`}
          className="flex h-6 max-w-32 min-w-0 shrink items-center gap-1 rounded-sm px-1.5 text-meta text-fg-3 hover:bg-hover hover:text-fg"
        >
          <StateIcon state={by.state} size={11} />
          <span className="truncate">{sessionTitle(by)}</span>
        </button>
      )}
      {selected && output.kind === 'diff' && (
        <IconButton label="広げる" size="sm" onClick={() => openIntegration(output.id)}>
          <Maximize2 size={13} strokeWidth={1.75} />
        </IconButton>
      )}
      {selected && output.kind === 'document' && (
        <CopyButton text={output.data.content} iconOnly className="size-6 justify-center px-0" />
      )}
      {!single && (
        <span className="flex w-4 shrink-0 justify-center">
          <PhaseMark phase={phase} />
        </span>
      )}
    </div>
  );
}

/** The closed panel: one icon per output (waiting ones marked); pressing one opens it. */
function OutputsRail({ outputs, onPick }: { outputs: Output[]; onPick: (id: string) => void }) {
  const integrations = useIntegrations().data ?? NONE_I;
  const shown = outputs.slice(0, 8);
  return (
    <aside
      aria-label="成果物"
      data-region="panel-rail"
      className="flex h-full w-10 shrink-0 flex-col items-center gap-1 border-t border-l border-line-subtle bg-canvas py-2"
    >
      {shown.map((o) => {
        const phase = reviewPhase(o, integrations);
        return (
          <IconButton key={o.id} label={o.title} onClick={() => onPick(o.id)} className="relative">
            <OutputIcon kind={o.uiKind} />
            {phase.kind !== 'none' && phase.kind !== 'sent_back' && (
              <span className="absolute -right-0.5 -bottom-0.5 rounded-full bg-canvas">
                <PhaseMark phase={phase} size={9} />
              </span>
            )}
          </IconButton>
        );
      })}
      {outputs.length > shown.length && (
        <span className="text-micro text-fg-3 tabular">+{outputs.length - shown.length}</span>
      )}
    </aside>
  );
}
