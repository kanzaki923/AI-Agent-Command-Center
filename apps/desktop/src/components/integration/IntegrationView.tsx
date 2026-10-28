import type { Integration, IntegrationStep, WorkspaceDiff } from '@acc/protocol';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CircleX,
  GitBranch,
  GitMerge,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { approveIntegration, rejectIntegration, rerunIntegration } from '../../daemon/orchestration';
import { useArtifact, useIntegrations, useProjects, useTasks } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { useWindowKeydown } from '../../hooks/useWindowKeydown';
import { cn } from '../../lib/cn';
import { formatClock } from '../../lib/format';
import { overlayOpen } from '../../lib/overlay';
import { isTypingTarget } from '../../lib/shortcuts';
import { formatDuration } from '../../model/chat';
import { parsePatch } from '../../model/diff';
import {
  INTEGRATION_STATUS_LABEL,
  applyPlan,
  canApprove,
  canReject,
  canRerun,
  integrationState,
  isIntegrationActive,
  stepDurationMs,
  stepState,
} from '../../model/integration';
import { useUi } from '../../store/ui';
import { DiffStatText } from '../panel/DiffViewer';
import { Button } from '../ui/Button';
import { Dialog, inputClass } from '../ui/Dialog';
import { Kbd } from '../ui/Kbd';
import { Skeleton } from '../ui/Meta';
import { StatusIcon, stateColor } from '../ui/StatusIcon';
import { CombinedDiff, FileIndex, useCombinedDiffState } from './CombinedDiff';

const NONE: never[] = [];

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
 * The combined diff: the integration branch's diff artifact (recorded after verification),
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
          ...(integ.baseSha ? { baseRef: integ.baseSha } : integ.targetRef ? { baseRef: integ.targetRef } : {}),
        })
        .catch(() => null);
      return d ? { patch: d.patch, stats: d.stats } : null;
    },
    // Merging changes the branch; fetch once the merges are done.
    enabled: !!integ.workspaceId && integ.status !== 'pending' && integ.status !== 'running',
    staleTime: Infinity,
  });
}

function StepRow({ step, n }: { step: IntegrationStep; n: number }) {
  const state = stepState(step);
  const dur = stepDurationMs(step);
  const running = step.status === 'running';
  return (
    <li className="relative flex gap-3 py-2" data-step={step.kind} data-status={step.status}>
      <span className="flex w-5 shrink-0 flex-col items-center pt-0.5">
        <StatusIcon state={state} size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-micro text-fg-4 tabular">{n}</span>
          <span className={cn('min-w-0 flex-1 truncate text-ui', step.status === 'pending' || step.status === 'skipped' ? 'text-fg-3' : 'text-fg')}>
            {step.title}
          </span>
          {dur != null && <span className="text-meta text-fg-4 tabular">{formatDuration(dur)}</span>}
        </div>
        {running && (
          <div className="mt-1.5 h-0.5 overflow-hidden rounded-full bg-selected" aria-hidden="true">
            <div className="acc-progress h-full w-2/5 rounded-full" style={{ background: stateColor('running') }} />
          </div>
        )}
        {step.detail && (
          <p className={cn('mt-0.5 text-meta whitespace-pre-line', step.status === 'failed' ? 'text-st-failed' : 'text-fg-3')}>{step.detail}</p>
        )}
        {step.conflictFiles.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-0.5 rounded-sm border border-[color-mix(in_oklch,var(--st-failed)_30%,transparent)] bg-canvas px-2 py-1.5">
            {step.conflictFiles.map((f) => (
              <li key={f} className="flex items-center gap-1.5 font-mono text-meta text-fg-2">
                <AlertTriangle size={11} strokeWidth={1.75} className="shrink-0 text-st-failed" />
                {f}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function TestResult({ integ }: { integ: Integration }) {
  const verify = integ.steps.find((s) => s.kind === 'verify');
  const art = useArtifact(verify?.artifactId).data;
  if (!verify) return null;
  if (verify.status === 'skipped') {
    return <p className="text-meta text-fg-3">テストコマンドが設定されていないため、検証を省略しました。</p>;
  }
  if (verify.status === 'pending') return <p className="text-meta text-fg-4">マージが終わるとテストを実行します。</p>;
  if (verify.status === 'running') return <p className="text-meta text-fg-3">テストを実行しています…</p>;
  if (!art || art.kind !== 'test_result') return <Skeleton className="h-16 w-full" />;
  const d = art.data;
  return (
    <div className="flex flex-col gap-2" data-testid="integration-tests">
      <div className="flex items-center gap-2">
        {d.passed ? (
          <CheckCircle2 size={15} strokeWidth={1.75} className="text-st-completed" />
        ) : (
          <CircleX size={15} strokeWidth={1.75} className="text-st-failed" />
        )}
        {/* The summary already starts with 成功 / 失敗 (daemon wording); do not repeat it. */}
        <span className="text-ui font-medium text-fg">{d.summary || (d.passed ? '成功' : '失敗')}</span>
      </div>
      <div className="font-mono text-meta text-fg-3">$ {d.command}</div>
      {d.output && (
        <pre
          ref={(el) => {
            // The tail matters most (failures print last): start scrolled to the end.
            if (el) el.scrollTop = el.scrollHeight;
          }}
          className="selectable max-h-56 overflow-auto rounded-sm border border-line-subtle bg-canvas px-2.5 py-2 font-mono text-code whitespace-pre-wrap text-fg-2"
        >
          {d.output}
        </pre>
      )}
    </div>
  );
}

function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex h-6 items-center gap-2">
        <h3 className="text-micro text-fg-3">{title}</h3>
        <span className="flex-1" />
        {extra}
      </div>
      {children}
    </section>
  );
}

function ApplyDialog({ integ, open, onClose, stats }: { integ: Integration; open: boolean; onClose: () => void; stats: WorkspaceDiff['stats'] | null }) {
  const rt = useRuntime();
  const tasks = useTasks().data ?? NONE;
  const [note, setNote] = useState('');
  const plan = applyPlan(integ, { tasks, stats });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={plan.title} className="w-[520px]">
      <div className="flex flex-col gap-3" data-testid="apply-dialog">
        <ul className="flex flex-col gap-1.5">
          {plan.lines.map((l) => (
            <li key={l} className="flex gap-2 text-ui text-fg-2">
              <span className="mt-[9px] size-1 shrink-0 rounded-full bg-fg-4" />
              {l}
            </li>
          ))}
        </ul>
        {plan.caution && (
          <p className="flex items-center gap-2 rounded-sm px-2.5 py-2 text-ui text-st-awaiting_approval" style={{ background: 'color-mix(in oklch, var(--st-awaiting_approval) 10%, transparent)' }}>
            <AlertTriangle size={14} strokeWidth={1.75} className="shrink-0" />
            {plan.caution}
          </p>
        )}
        <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="メモ（任意）· 承認の記録に残ります" />
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            autoFocus
            icon={<GitMerge size={13} strokeWidth={1.75} />}
            onClick={() => {
              onClose();
              void approveIntegration(rt, integ, note.trim() || undefined);
            }}
          >
            {plan.confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function RejectDialog({ integ, open, onClose }: { integ: Integration; open: boolean; onClose: () => void }) {
  const rt = useRuntime();
  const [note, setNote] = useState('');
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="この統合候補を却下しますか？"
      description={`${integ.targetRef ?? '反映先'} は変更されません。各 Task の worktree とブランチは残ります。`}
      className="w-[480px]"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          onClose();
          void rejectIntegration(rt, integ, note.trim() || undefined);
        }}
      >
        <input autoFocus className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="却下の理由（任意）· Orchestrator にも伝わります" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" variant="secondary">
            却下する
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Bottom decision bar: what is being decided, and the two human-only actions. */
function DecisionBar({
  integ,
  stats,
  onApply,
  onReject,
}: {
  integ: Integration;
  stats: WorkspaceDiff['stats'] | null;
  onApply: () => void;
  onReject: () => void;
}) {
  const rt = useRuntime();
  const connected = useConnectionState() === 'open';
  const verify = integ.steps.find((s) => s.kind === 'verify');
  let body: ReactNode;
  if (integ.status === 'applied') {
    body = (
      <span className="flex items-center gap-2 text-ui text-fg-2">
        <CheckCircle2 size={15} strokeWidth={1.75} className="text-st-completed" />
        {integ.targetRef} に反映しました
        {integ.decidedAt && <span className="text-meta text-fg-3 tabular">· {formatClock(integ.decidedAt)}</span>}
        {integ.decisionNote && <span className="text-meta text-fg-3">· {integ.decisionNote}</span>}
      </span>
    );
  } else if (integ.status === 'rejected') {
    body = (
      <span className="flex items-center gap-2 text-ui text-fg-3">
        <CircleX size={15} strokeWidth={1.75} />
        却下しました{integ.decisionNote ? ` · ${integ.decisionNote}` : ''}
      </span>
    );
  } else if (isIntegrationActive(integ)) {
    body = <span className="text-ui text-fg-3">{integ.status === 'verifying' ? 'テストを実行しています。終わると反映できます' : '変更を順番にマージしています…'}</span>;
  } else if (integ.status === 'awaiting_approval') {
    body = (
      <span className="flex min-w-0 items-center gap-2 text-ui text-fg-2">
        <ShieldCheck size={15} strokeWidth={1.75} className="shrink-0 text-st-review" />
        <span className="truncate">
          {verify?.status === 'succeeded' ? 'テスト成功' : verify?.status === 'skipped' ? 'テストなし' : 'テスト未完了'}
          {stats && ` · ${stats.files} ファイル`}
          {` · ${integ.targetRef} へ早送りで反映`}
        </span>
      </span>
    );
  } else {
    body = (
      <span className="flex min-w-0 items-center gap-2 text-ui text-st-failed">
        <AlertTriangle size={15} strokeWidth={1.75} className="shrink-0" />
        <span className="truncate">{integ.error?.message ?? '統合に失敗しました'}</span>
      </span>
    );
  }
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-t border-line-subtle bg-canvas px-6">
      <div className="min-w-0 flex-1">{body}</div>
      {canRerun(integ) && integ.status !== 'awaiting_approval' && (
        <Button icon={<RotateCcw size={12} strokeWidth={1.75} />} disabled={!connected} onClick={() => void rerunIntegration(rt, integ)}>
          再実行
        </Button>
      )}
      {canReject(integ) && (
        <Button variant="ghost" disabled={!connected} onClick={onReject}>
          却下
        </Button>
      )}
      {canApprove(integ) && (
        <Button variant="primary" size="lg" shortcutKeys="Mod+Enter" icon={<GitMerge size={14} strokeWidth={1.75} />} disabled={!connected} onClick={onApply} data-testid="approve-integration">
          承認して反映
        </Button>
      )}
    </div>
  );
}

/**
 * Review & integrate (concept §6, §12.1 steps 7–9). Replaces the main area: ordered steps
 * with live progress on the left, the combined diff on the right, the human decision at the
 * bottom. j / k move between files, o toggles the current file, Esc goes back.
 */
export function IntegrationView({ integrationId }: { integrationId: string }) {
  const integ = useIntegration(integrationId);
  const close = useUi((s) => s.closeIntegration);
  if (!integ) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <Skeleton className="h-6 w-64" />
      </div>
    );
  }
  return <IntegrationReview key={integ.id} integ={integ} onClose={close} />;
}

function IntegrationReview({ integ, onClose }: { integ: Integration; onClose: () => void }) {
  const projects = useProjects().data ?? NONE;
  const project = projects.find((p) => p.id === integ.projectId) ?? null;
  const diff = useIntegrationDiff(integ);
  const patch = diff.data?.patch;
  const files = useMemo(() => (patch ? parsePatch(patch) : []), [patch]);
  const state = useCombinedDiffState(files);
  const scroller = useRef<HTMLDivElement | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const stats = diff.data?.stats ?? null;
  const st = integrationState(integ.status);

  const jump = (path: string) => {
    state.setCurrent(path);
    const el = scroller.current?.querySelector<HTMLElement>(`[data-diff-file="${CSS.escape(path)}"]`);
    el?.scrollIntoView({ block: 'start' });
  };

  useWindowKeydown((e) => {
    if (e.defaultPrevented || overlayOpen() || isTypingTarget(e.target)) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canApprove(integ)) {
      e.preventDefault();
      setApplyOpen(true);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const i = files.findIndex((f) => f.path === state.current);
    if (e.key === 'j' || e.key === 'k') {
      if (files.length === 0) return;
      e.preventDefault();
      const next = e.key === 'j' ? Math.min(files.length - 1, i + 1) : Math.max(0, i === -1 ? 0 : i - 1);
      jump(files[next]!.path);
    } else if ((e.key === 'o' || e.key === 'Enter') && state.current && !(e.target instanceof HTMLButtonElement)) {
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
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line-subtle px-4">
        <Button size="sm" variant="ghost" icon={<ArrowLeft size={13} strokeWidth={1.75} />} onClick={onClose} shortcutKeys="Escape">
          司令室
        </Button>
        <span className="h-4 w-px bg-line" />
        <StatusIcon state={st} size={14} />
        <h1 className="min-w-0 truncate text-title text-fg">{integ.title}</h1>
        <span className="shrink-0 rounded-xs px-1.5 text-micro" style={{ color: stateColor(st), background: `color-mix(in oklch, ${stateColor(st)} 14%, transparent)` }}>
          {INTEGRATION_STATUS_LABEL[integ.status]}
        </span>
        <span className="flex-1" />
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-meta text-fg-3">
          <GitBranch size={12} strokeWidth={1.75} className="shrink-0" />
          <span className="truncate">{integ.branch ?? '—'}</span>
          <span className="text-fg-4">→</span>
          <span className="text-fg-2">{integ.targetRef ?? project?.defaultBranch ?? '—'}</span>
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[320px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-line-subtle px-4 py-4" aria-label="手順とテスト">
          <Section title="手順">
            <ol className="flex flex-col">
              {integ.steps.map((s, i) => (
                <StepRow key={s.index} step={s} n={i + 1} />
              ))}
            </ol>
          </Section>
          <Section title="テスト結果">
            <TestResult integ={integ} />
          </Section>
          {files.length > 0 && (
            <Section title={`ファイル ${files.length}`} extra={stats && <DiffStatText additions={stats.additions} deletions={stats.deletions} />}>
              <FileIndex files={files} state={state} onJump={jump} />
            </Section>
          )}
        </aside>

        <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto px-6 py-4" data-region="main" tabIndex={-1}>
          <div className="mb-3 flex h-7 items-center gap-3">
            <h2 className="text-ui font-medium text-fg">統合後の差分</h2>
            {stats && (
              <span className="flex items-center gap-2 text-meta text-fg-3">
                {stats.files} ファイル <DiffStatText additions={stats.additions} deletions={stats.deletions} />
              </span>
            )}
            <span className="flex-1" />
            {files.length > 0 && (
              <span className="flex items-center gap-3 text-meta text-fg-4">
                <span className="flex items-center gap-1">
                  <Kbd keys="J" />
                  <Kbd keys="K" /> ファイル移動
                </span>
                <span className="flex items-center gap-1">
                  <Kbd keys="O" /> 開閉
                </span>
                <button type="button" className="text-fg-3 hover:text-fg-2" onClick={() => state.setAll(false)}>
                  すべて展開
                </button>
                <button type="button" className="text-fg-3 hover:text-fg-2" onClick={() => state.setAll(true)}>
                  すべて折りたたむ
                </button>
              </span>
            )}
          </div>
          <AnimatePresence initial={false}>
            {diff.isPending && integ.workspaceId && !isIntegrationActive(integ) ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-40 w-full" />
              </div>
            ) : files.length > 0 ? (
              <CombinedDiff files={files} state={state} />
            ) : (
              <div className="flex flex-col items-center gap-1 py-16 text-center">
                <div className="text-ui font-medium text-fg-2">
                  {isIntegrationActive(integ) ? 'マージが終わると差分が表示されます' : '差分はありません'}
                </div>
                <div className="text-meta text-fg-3">各 Task のブランチを統合ブランチへ順番にマージしています。</div>
              </div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <DecisionBar integ={integ} stats={stats} onApply={() => setApplyOpen(true)} onReject={() => setRejectOpen(true)} />
      <ApplyDialog integ={integ} open={applyOpen} onClose={() => setApplyOpen(false)} stats={stats} />
      <RejectDialog integ={integ} open={rejectOpen} onClose={() => setRejectOpen(false)} />
    </motion.div>
  );
}
