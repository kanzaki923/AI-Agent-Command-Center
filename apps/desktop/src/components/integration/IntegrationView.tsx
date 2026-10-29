import type { Artifact, Integration, SessionState, WorkspaceDiff } from '@acc/protocol';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Bot, CircleCheck, GitMerge, RotateCcw, TriangleAlert } from 'lucide-react';
import { motion } from 'motion/react';
import { type ReactNode, useMemo, useRef } from 'react';
import {
  approveIntegration,
  rejectIntegration,
  rerunIntegration,
  resolveWithAgent,
} from '../../daemon/orchestration';
import { useOutputs } from '../../daemon/outputs';
import { useArtifact, useIntegrations, useProjects } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { useSessionTree } from '../../daemon/tree';
import { useWindowKeydown } from '../../hooks/useWindowKeydown';
import { overlayOpen } from '../../lib/overlay';
import { isTypingTarget } from '../../lib/shortcuts';
import { sessionTitle } from '../../lib/states';
import { type DiffFile, parsePatch } from '../../model/diff';
import { canResolveWithAgent, conflictStep, isResolving } from '../../model/integration';
import { useUi } from '../../store/ui';
import { DiffStatText } from '../outputs/DiffViewer';
import { ReviewBar } from '../outputs/ReviewBar';
import { Button } from '../ui/Button';
import { Skeleton } from '../ui/Meta';
import { OutputIcon } from '../ui/SemanticIcons';
import { StateIcon } from '../ui/StateIcon';
import { Tooltip } from '../ui/Tooltip';
import { CombinedDiff, FileIndex, useCombinedDiffState } from './CombinedDiff';

const NONE: never[] = [];

/**
 * The full view of code (ui-redesign spec §6: the panel's 「広げる」). It replaces the main area
 * until closed (Esc). `integrationId` names what is shown (the store's `reviewIntegrationId`):
 * - a code output (`art_…`): its change, file by file, and its decision (採用 / やり直す, then
 *   反映) — the same bar as the panel;
 * - an integration (`int_…`, from the timeline or a supervisor's combined change): its combined
 *   change and what is left to do (反映, やめる; on a conflict 解消を任せる; on a failure もう一度).
 * J / K move between files, O folds the current one.
 */
export function IntegrationView({ integrationId }: { integrationId: string }) {
  return integrationId.startsWith('art_') ? (
    <CodeOutputView key={integrationId} artifactId={integrationId} />
  ) : (
    <IntegrationById key={integrationId} id={integrationId} />
  );
}

// ---------------------------------------------------------------------------- shared frame

/** Header, file index + stacked diff, and the bottom bar, with J / K / O over the files. */
function ReviewFrame({
  head,
  side,
  files,
  loading,
  bar,
}: {
  head: ReactNode;
  side?: ReactNode;
  files: DiffFile[];
  loading: boolean;
  bar: ReactNode;
}) {
  const state = useCombinedDiffState(files);
  const scroller = useRef<HTMLDivElement | null>(null);
  const jump = (path: string) => {
    state.setCurrent(path);
    scroller.current
      ?.querySelector<HTMLElement>(`[data-diff-file="${CSS.escape(path)}"]`)
      ?.scrollIntoView({ block: 'start' });
  };
  useWindowKeydown((e) => {
    if (e.defaultPrevented || overlayOpen() || isTypingTarget(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || files.length === 0) return;
    const i = files.findIndex((f) => f.path === state.current);
    if (e.key === 'j' || e.key === 'k') {
      e.preventDefault();
      const next =
        e.key === 'j' ? Math.min(files.length - 1, i + 1) : Math.max(0, i === -1 ? 0 : i - 1);
      jump(files[next]!.path);
    } else if (e.key === 'o' && state.current) {
      e.preventDefault();
      state.toggle(state.current);
    }
  });
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="flex h-full min-h-0 flex-col"
      data-testid="integration-view"
    >
      <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-line-subtle px-3">
        {head}
      </header>
      <div className="flex min-h-0 flex-1">
        <aside
          className="flex w-[280px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-line-subtle p-2"
          aria-label="ファイル"
        >
          {side}
          <FileIndex files={files} state={state} onJump={jump} />
        </aside>
        <div
          ref={scroller}
          className="min-w-0 flex-1 overflow-y-auto px-6 py-4"
          data-region="main"
          tabIndex={-1}
        >
          {loading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : (
            <CombinedDiff files={files} state={state} />
          )}
        </div>
      </div>
      {bar}
    </motion.div>
  );
}

function BackButton({ label }: { label: string }) {
  const back = useUi((s) => s.closeIntegration);
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={<ArrowLeft size={13} strokeWidth={1.75} />}
      onClick={back}
      shortcutKeys="Escape"
      className="max-w-60 min-w-0"
    >
      <span className="min-w-0 truncate">{label}</span>
    </Button>
  );
}

function Stats({ files }: { files: DiffFile[] }) {
  if (files.length === 0) return null;
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <span className="flex shrink-0 items-center gap-2 text-meta text-fg-3 tabular">
      {files.length} ファイル
      <DiffStatText additions={add} deletions={del} />
    </span>
  );
}

/** Where 反映 goes (`main`), for code only. */
function Target({ branch }: { branch: string | null | undefined }) {
  if (!branch) return null;
  return (
    <Tooltip content="反映先">
      <span
        className="flex shrink-0 items-center gap-1 font-mono text-meta text-fg-3"
        data-testid="target"
      >
        <GitMerge size={12} strokeWidth={1.75} aria-hidden />
        {branch}
      </span>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------- a code output

/** The freshest copy of an output: from its conversation's outputs (kept current by events). */
function useOutput(artifactId: string): Artifact | null {
  const base = useArtifact(artifactId).data ?? null;
  const list = useOutputs(base?.sessionId ? { sessionId: base.sessionId } : null).data ?? NONE;
  return list.find((a) => a.id === artifactId) ?? base;
}

function CodeOutputView({ artifactId }: { artifactId: string }) {
  const output = useOutput(artifactId);
  const tree = useSessionTree(output?.sessionId).data;
  const maker = tree?.nodes.find((n) => n.id === output?.sessionId) ?? null;
  const project = (useProjects().data ?? NONE).find((p) => p.id === output?.projectId) ?? null;
  const patch = output?.kind === 'diff' ? output.data.patch : '';
  const files = useMemo(() => parsePatch(patch), [patch]);
  if (!output) {
    return (
      <div className="flex h-full items-center justify-center">
        <Skeleton className="h-6 w-64" />
      </div>
    );
  }
  return (
    <ReviewFrame
      files={files}
      loading={false}
      head={
        <>
          <BackButton label={maker ? sessionTitle(maker) : '戻る'} />
          <span className="h-4 w-px shrink-0 bg-line" />
          <OutputIcon kind="code" className="text-fg-2" />
          <h1 className="min-w-0 truncate text-title text-fg">{output.title}</h1>
          <span className="flex-1" />
          <Stats files={files} />
          <Target branch={project?.defaultBranch} />
        </>
      }
      bar={<ReviewBar output={output} size="full" />}
    />
  );
}

// ---------------------------------------------------------------------------- an integration

function useIntegration(id: string): Integration | null {
  const rt = useRuntime();
  const fromList = (useIntegrations().data ?? NONE).find((i) => i.id === id) ?? null;
  const q = useQuery<Integration>({
    queryKey: ['integration.get', id],
    queryFn: () => rt.client.call('integration.get', { integrationId: id }),
    enabled: !fromList,
  });
  return fromList ?? q.data ?? null;
}

/**
 * The combined change: the integration branch's diff artifact (recorded after verification),
 * else the live diff of the integration worktree against the target it started from.
 */
function useIntegrationDiff(integ: Integration) {
  const rt = useRuntime();
  return useQuery<{ patch: string; stats: WorkspaceDiff['stats'] } | null>({
    queryKey: ['integration.diff', integ.id, integ.headSha ?? integ.updatedAt],
    queryFn: async () => {
      if (!integ.workspaceId) return null;
      const arts = await rt.callOr(
        'artifact.list',
        { workspaceId: integ.workspaceId, kind: 'diff', limit: 1 },
        { items: [], nextCursor: null },
      );
      const a = arts.items[0];
      if (a?.kind === 'diff') return { patch: a.data.patch, stats: a.data.stats };
      const d = await rt.client
        .call('workspace.diff', {
          workspaceId: integ.workspaceId,
          ...(integ.baseSha
            ? { baseRef: integ.baseSha }
            : integ.targetRef
              ? { baseRef: integ.targetRef }
              : {}),
        })
        .catch(() => null);
      return d ? { patch: d.patch, stats: d.stats } : null;
    },
    // Merging changes the branch; fetch once the merges are done.
    enabled: !!integ.workspaceId && integ.status !== 'pending' && integ.status !== 'running',
    staleTime: Infinity,
  });
}

/** An integration's status in the session-state vocabulary (shape + colour). */
export function integrationShape(i: Integration): SessionState {
  switch (i.status) {
    case 'pending':
      return 'queued';
    case 'running':
    case 'verifying':
      return 'working';
    case 'awaiting_approval':
      return 'review';
    case 'conflict':
    case 'failed':
      return 'failed';
    case 'applied':
      return 'done';
    case 'rejected':
    case 'cancelled':
      return 'stopped';
  }
}

/** One noun phrase for where an integration stands. */
export function integrationLabel(i: Integration): string {
  if (isResolving(i)) return '競合を解消中';
  switch (i.status) {
    case 'pending':
      return '準備中';
    case 'running':
    case 'verifying':
      return '反映中';
    case 'awaiting_approval':
      return '反映待ち';
    case 'conflict':
      return '競合';
    case 'failed':
      return i.error?.code === 'tests_failed' || i.error?.code === 'tests_timed_out'
        ? 'テスト失敗'
        : '反映できません';
    case 'applied':
      return '反映済み';
    case 'rejected':
    case 'cancelled':
      return 'やめました';
  }
}

function IntegrationById({ id }: { id: string }) {
  const integ = useIntegration(id);
  if (!integ) {
    return (
      <div className="flex h-full items-center justify-center">
        <Skeleton className="h-6 w-64" />
      </div>
    );
  }
  return <IntegrationReview integ={integ} />;
}

function IntegrationReview({ integ }: { integ: Integration }) {
  const diff = useIntegrationDiff(integ);
  const patch = diff.data?.patch ?? '';
  const files = useMemo(() => parsePatch(patch), [patch]);
  const conflict = integ.status === 'conflict' ? conflictStep(integ) : null;
  return (
    <ReviewFrame
      files={files}
      loading={
        diff.isPending &&
        !!integ.workspaceId &&
        integ.status !== 'pending' &&
        integ.status !== 'running'
      }
      head={
        <>
          <BackButton label="戻る" />
          <span className="h-4 w-px shrink-0 bg-line" />
          <StateIcon state={integrationShape(integ)} size={14} />
          <h1 className="min-w-0 truncate text-title text-fg">{integ.title}</h1>
          <span className="flex-1" />
          <Stats files={files} />
          <Target branch={integ.targetRef} />
        </>
      }
      side={
        <>
          {conflict && conflict.conflictFiles.length > 0 && (
            <ul
              aria-label="競合したファイル"
              className="flex shrink-0 flex-col gap-0.5 rounded-sm border border-[color-mix(in_oklch,var(--st-failed)_30%,transparent)] px-2 py-1.5"
            >
              {conflict.conflictFiles.map((f) => (
                <li key={f} className="flex items-center gap-1.5 font-mono text-meta text-fg-2">
                  <TriangleAlert
                    size={11}
                    strokeWidth={1.75}
                    className="shrink-0 text-st-failed"
                    aria-hidden
                  />
                  <span className="truncate">{f}</span>
                </li>
              ))}
            </ul>
          )}
          <FailedTests integ={integ} />
        </>
      }
      bar={<IntegrationBar integ={integ} />}
    />
  );
}

/** The tail of a failed test run (failures print last). */
function FailedTests({ integ }: { integ: Integration }) {
  const verify = integ.steps.find((s) => s.kind === 'verify' && s.status === 'failed');
  const art = useArtifact(verify?.artifactId).data;
  if (!verify || !art || art.kind !== 'test_result' || !art.data.output) return null;
  return (
    <pre
      aria-label="テストの出力"
      ref={(el) => {
        // The tail matters most (failures print last): start scrolled to the end.
        if (el) el.scrollTop = el.scrollHeight;
      }}
      className="selectable max-h-56 shrink-0 overflow-auto rounded-sm border border-line-subtle bg-canvas px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-fg-2"
    >
      {art.data.output}
    </pre>
  );
}

function IntegrationBar({ integ }: { integ: Integration }) {
  const rt = useRuntime();
  const connected = useConnectionState() === 'open';
  const state = integrationShape(integ);
  const canApply = integ.status === 'awaiting_approval';
  const canStop =
    integ.status === 'awaiting_approval' ||
    integ.status === 'conflict' ||
    integ.status === 'failed';
  const resolve = canResolveWithAgent(integ);
  const retry = integ.status === 'failed' || (integ.status === 'conflict' && !resolve);
  useWindowKeydown((e) => {
    // The bar's one primary action, as on the buttons.
    if (
      !connected ||
      e.defaultPrevented ||
      overlayOpen() ||
      e.key !== 'Enter' ||
      !(e.ctrlKey || e.metaKey)
    )
      return;
    if (canApply) {
      e.preventDefault();
      void approveIntegration(rt, integ);
    } else if (resolve) {
      e.preventDefault();
      void resolveWithAgent(rt, integ);
    }
  });
  return (
    <div
      className="flex h-14 shrink-0 items-center gap-2 border-t border-line-subtle bg-canvas px-6"
      data-integration-status={integ.status}
    >
      <span className="flex min-w-0 flex-1">
        <Tooltip content={integ.status === 'applied' ? null : integ.error?.message}>
          <span
            className="flex min-w-0 items-center gap-1.5 text-ui text-fg-2"
            data-testid="integration-status"
          >
            {state === 'done' ? (
              <CircleCheck
                size={14}
                strokeWidth={2}
                className="shrink-0 text-st-done"
                aria-hidden
              />
            ) : (
              <StateIcon state={state} size={14} />
            )}
            <span className={state === 'failed' ? 'text-st-failed' : undefined}>
              {integrationLabel(integ)}
            </span>
          </span>
        </Tooltip>
      </span>
      {canStop && (
        <Button
          variant="ghost"
          size="lg"
          disabled={!connected}
          onClick={() => void rejectIntegration(rt, integ)}
        >
          やめる
        </Button>
      )}
      {retry && (
        <Button
          size="lg"
          icon={<RotateCcw size={13} strokeWidth={1.75} />}
          disabled={!connected}
          onClick={() => void rerunIntegration(rt, integ)}
        >
          もう一度
        </Button>
      )}
      {resolve && (
        <Button
          variant="primary"
          size="lg"
          icon={<Bot size={14} strokeWidth={1.75} />}
          shortcutKeys="Mod+Enter"
          hint="エージェントに競合の解消を任せる"
          disabled={!connected}
          onClick={() => void resolveWithAgent(rt, integ)}
          data-testid="resolve-with-agent"
        >
          解消を任せる
        </Button>
      )}
      {canApply && (
        <Button
          variant="primary"
          size="lg"
          icon={<GitMerge size={14} strokeWidth={1.75} />}
          shortcutKeys="Mod+Enter"
          disabled={!connected}
          onClick={() => void approveIntegration(rt, integ)}
          data-testid="approve-integration"
        >
          反映
        </Button>
      )}
    </div>
  );
}
