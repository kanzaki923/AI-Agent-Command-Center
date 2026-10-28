import type { CapabilityGrant, Event, Project, Run, Session } from '@acc/protocol';
import { CheckCircle2, CircleX, GitMerge, X } from 'lucide-react';
import { motion } from 'motion/react';
import { Tabs } from 'radix-ui';
import { type ReactNode, useMemo } from 'react';
import {
  useArtifacts,
  useDiff,
  useEventHistory,
  useEventLogVersion,
  useProjects,
  useRuns,
  useSessions,
  useWorkspace,
} from '../../daemon/queries';
import { describeGrant } from '../../model/grant';
import { INTEGRATION_STATUS_LABEL, stepState } from '../../model/integration';
import { flattenTasks, taskDisplay } from '../../model/tasks';
import { useTaskGroups } from '../command/TaskTree';
import { OrchestratorMark, useSessionGrants } from '../grant/Grant';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { useRuntime } from '../../daemon/runtime';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { cn } from '../../lib/cn';
import { formatClockSeconds, sumUsage } from '../../lib/format';
import { RUN_STATUS_LABEL, TASK_STATUS_LABEL, runStatusToState } from '../../lib/status';
import { describeApproval } from '../../model/approval';
import { type BoardItem, elapsedRange, untitled } from '../../model/board';
import { parsePatch } from '../../model/diff';
import { describeEvent } from '../../model/timeline';
import { useBoard } from '../../model/useBoard';
import { PANEL_TABS, type PanelTab, useUi } from '../../store/ui';
import { IconButton } from '../ui/Button';
import { Kbd } from '../ui/Kbd';
import { Cost, ElapsedTime, TimeStamp } from '../ui/Meta';
import { ResizeHandle } from '../ui/ResizeHandle';
import { StatusIcon, StatusLabel } from '../ui/StatusIcon';
import { useTimelineSelection } from '../timeline/TimelineView';
import { DiffBrowser, DiffStatText } from './DiffViewer';
import { TaskDetail } from './TaskDetail';

const NONE: never[] = [];

const TAB_LABEL: Record<PanelTab, string> = { overview: '概要', changes: '変更', tests: 'テスト', logs: 'ログ' };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-start gap-3 py-1">
      <div className="w-16 shrink-0 pt-px text-meta text-fg-3">{label}</div>
      <div className="min-w-0 flex-1 text-ui text-fg">{children}</div>
    </div>
  );
}

function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-12 text-center">
      <div className="text-ui font-medium text-fg-2">{title}</div>
      {body && <div className="text-meta text-fg-3">{body}</div>}
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="selectable max-h-96 overflow-auto rounded-sm bg-canvas px-2.5 py-2 font-mono text-code text-fg-2 whitespace-pre-wrap">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}


/** What a grant lets the session do, in words (raw patterns in the tooltip). */
function GrantSummaryField({ grant, projects }: { grant: CapabilityGrant; projects: Project[] }) {
  const v = describeGrant(grant, projects);
  return (
    <div className="flex flex-col gap-0.5">
      <Tooltip content={<span className="font-mono">{grant.permissions.join(', ')}</span>}>
        <span className="flex items-center gap-1.5">
          {v.orchestrates && <OrchestratorMark size={11} />}
          {v.title}
          {v.workers && <span className="text-meta text-fg-3">· {v.workers}</span>}
        </span>
      </Tooltip>
      <span className="text-meta text-fg-3">
        {v.lifetime} · {v.projects ? v.projects.join('、') : 'すべてのプロジェクト'}
      </span>
    </div>
  );
}

function RunHistory({ runs }: { runs: Run[] }) {
  if (runs.length === 0) return <span className="text-fg-3">まだ実行していません</span>;
  return (
    <div className="flex flex-col gap-0.5">
      {runs.slice(0, 8).map((r) => (
        <div key={r.id} className="flex h-6 items-center gap-2 text-meta">
          <StatusIcon state={runStatusToState(r.status)} size={12} />
          <span className="text-fg-2">#{r.attempt}</span>
          <span className="text-fg-3">{RUN_STATUS_LABEL[r.status]}</span>
          <span className="flex-1" />
          <TimeStamp iso={r.createdAt} />
          <Cost usd={r.usage.costUsd} source={r.usage.costSource} className="w-14 text-right" />
        </div>
      ))}
    </div>
  );
}

function SessionOverview({ session, runs }: { session: Session; runs: Run[] }) {
  const sessions = useSessions().data ?? NONE;
  const { items } = useBoard();
  const item = items.find((i) => i.id === session.id);
  const workspace = useWorkspace(session.workspaceId).data;
  const diff = useDiff(session.workspaceId).data;
  const parent = session.parentSessionId ? sessions.find((s) => s.id === session.parentSessionId) : null;
  const usage = sumUsage(runs.map((r) => r.usage));
  const openSession = useUi((s) => s.openSession);
  const projects = useProjects().data ?? NONE;
  const { active, orchestrator } = useSessionGrants(session.id);
  const activeGrant = orchestrator ?? active[0] ?? null;
  const run = item?.run ?? runs[0] ?? null;
  const range = item ? elapsedRange(item) : { start: null, end: null };
  // The tasks this chat created as an orchestrator (its plan, visible from the chat).
  const plan = useTaskGroups().find((g) => g.id === session.id) ?? null;
  return (
    <div className="flex flex-col px-4 py-3">
      <Field label="状態">
        {item ? (
          <span className="flex items-center gap-2">
            <StatusIcon state={item.state} size={13} />
            <StatusLabel state={item.state} />
            <ElapsedTime start={range.start} end={item.state === 'running' ? null : range.end} />
          </span>
        ) : (
          '—'
        )}
      </Field>
      {item?.task && (
        <Field label="Task">
          <div>{item.task.title}</div>
          <div className="text-meta text-fg-3">{TASK_STATUS_LABEL[item.task.status]}</div>
        </Field>
      )}
      {parent && (
        <Field label="親">
          <button type="button" className="text-left text-accent hover:underline" onClick={() => openSession(parent.id)}>
            {untitled(parent)}
          </button>
        </Field>
      )}
      {plan && (
        <Field label="Task">
          <div className="mb-1 text-meta text-fg-3 tabular">
            {plan.counts.done}/{plan.counts.total} 完了
            {plan.counts.review > 0 && ` · レビュー待ち ${plan.counts.review}`}
            {plan.counts.running > 0 && ` · 進行中 ${plan.counts.running}`}
          </div>
          <ul className="flex flex-col">
            {flattenTasks([plan])
              .slice(0, 8)
              .map((n) => (
                <li key={n.task.id}>
                  <button
                    type="button"
                    onClick={() => {
                      const ui = useUi.getState();
                      ui.setMode('command');
                      ui.select(n.task.id);
                      ui.setPanelOpen('command', true);
                    }}
                    className="flex h-6 w-full items-center gap-1.5 rounded-xs text-left text-ui text-fg-2 hover:text-fg"
                  >
                    <StatusIcon state={taskDisplay(n).state} size={12} />
                    <span className="truncate">{n.task.title}</span>
                  </button>
                </li>
              ))}
          </ul>
        </Field>
      )}
      <Field label="権限">
        {activeGrant ? (
          <GrantSummaryField grant={activeGrant} projects={projects} />
        ) : (
          <span className="text-fg-3">{session.kind === 'agent' ? 'worktree 内 · 既定の権限' : 'なし'}</span>
        )}
      </Field>
      <Field label="コスト">
        <Cost usd={usage.costUsd} source={usage.costSource} className="text-ui text-fg" />
        {run && run.usage.inputTokens + run.usage.outputTokens > 0 && (
          <div className="text-meta text-fg-3 tabular">
            入力 {run.usage.inputTokens.toLocaleString()} · 出力 {run.usage.outputTokens.toLocaleString()} トークン
          </div>
        )}
      </Field>
      {workspace && (
        <Field label="worktree">
          <div className="font-mono text-meta break-all text-fg-2">{workspace.branch ?? workspace.path}</div>
        </Field>
      )}
      {diff && diff.stats.files > 0 && (
        <Field label="変更">
          <span className="flex items-center gap-2">
            {diff.stats.files} ファイル <DiffStatText additions={diff.stats.additions} deletions={diff.stats.deletions} />
          </span>
        </Field>
      )}
      <Field label="モデル">
        <span className="text-fg-2">{run?.model ?? session.model ?? '既定'}</span>
      </Field>
      <div className="mt-3 mb-1 text-micro text-fg-3">Run 履歴</div>
      <RunHistory runs={runs} />
    </div>
  );
}

function ChangesTab({ session }: { session: Session }) {
  const diffQ = useDiff(session.workspaceId);
  const artifacts = useArtifacts(session.workspaceId ? null : session.id, 'diff');
  const patch =
    diffQ.data?.patch ??
    (artifacts.data?.[0]?.kind === 'diff' ? artifacts.data[0].data.patch : null);
  const files = useMemo(() => (patch ? parsePatch(patch) : []), [patch]);
  if (files.length === 0) {
    return <Empty title="まだ変更はありません" body="このRunがファイルを編集すると、ここに差分が表示されます。" />;
  }
  return <DiffBrowser files={files} />;
}

function TestsTab({ session }: { session: Session }) {
  const tests = useArtifacts(session.id, 'test_result').data ?? NONE;
  const latest = tests[0];
  if (!latest || latest.kind !== 'test_result') {
    return <Empty title="テスト結果はまだありません" body="エージェントがテストを実行すると、ここに結果が表示されます。" />;
  }
  const d = latest.data;
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-center gap-2">
        {d.passed ? (
          <CheckCircle2 size={16} strokeWidth={1.75} className="text-st-completed" />
        ) : (
          <CircleX size={16} strokeWidth={1.75} className="text-st-failed" />
        )}
        <span className="text-ui font-medium text-fg">{d.passed ? '成功' : '失敗'}</span>
        <span className="text-meta text-fg-3">{d.summary}</span>
      </div>
      <div className="font-mono text-meta text-fg-2">$ {d.command}</div>
      {d.output && (
        <pre className="selectable max-h-96 overflow-auto rounded-sm bg-canvas px-2.5 py-2 font-mono text-code text-fg-2 whitespace-pre-wrap">
          {d.output}
        </pre>
      )}
      {tests.length > 1 && <div className="text-meta text-fg-3">過去の結果 {tests.length - 1} 件</div>}
    </div>
  );
}

function LogsTab({ session }: { session: Session }) {
  const rt = useRuntime();
  useEventHistory();
  const version = useEventLogVersion();
  const events = rt.streams.events.events;
  const mine = useMemo(
    () => events.filter((e) => e.sessionId === session.id).slice(-500),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the log is mutable; `version` tracks it
    [version, events, session.id],
  );
  if (mine.length === 0) return <Empty title="ログはまだありません" />;
  return (
    <div className="flex flex-col py-1 font-sans">
      {mine.map((e) => {
        const v = describeEvent(e);
        return (
          <div key={e.seq} className="flex min-h-6 items-start gap-2 px-3 py-0.5 text-meta">
            <span className="w-14 shrink-0 text-fg-4 tabular">{formatClockSeconds(e.ts)}</span>
            <span className={cn('w-16 shrink-0 truncate', v.isError ? 'text-st-failed' : v.isDecision ? 'text-accent' : 'text-fg-3')}>
              {v.label}
            </span>
            <span className="min-w-0 flex-1 text-fg-2">{v.summary}</span>
          </div>
        );
      })}
    </div>
  );
}

function FocusPanel() {
  const focusSessionId = useUi((s) => s.focusSessionId);
  const tab = useUi((s) => s.panelTab);
  const setTab = useUi((s) => s.setPanelTab);
  const session = (useSessions().data ?? NONE).find((s) => s.id === focusSessionId);
  const runs = (useRuns().data ?? NONE).filter((r) => r.sessionId === focusSessionId);
  if (!session) return <Empty title="セッションが選ばれていません" />;
  return (
    <Tabs.Root value={tab} onValueChange={(v) => setTab(v as PanelTab)} className="flex h-full min-h-0 flex-col">
      <Tabs.List aria-label="詳細" className="flex h-11 shrink-0 items-end gap-4 border-b border-line-subtle px-4">
        {PANEL_TABS.map((t) => (
          <Tabs.Trigger
            key={t}
            value={t}
            className="relative h-9 text-ui text-fg-3 hover:text-fg-2 data-[state=active]:text-fg data-[state=active]:after:absolute data-[state=active]:after:right-0 data-[state=active]:after:bottom-[-1px] data-[state=active]:after:left-0 data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-accent"
          >
            {TAB_LABEL[t]}
          </Tabs.Trigger>
        ))}
        <span className="flex-1" />
        <span className="mb-2.5 flex items-center gap-1 text-micro text-fg-4">
          <Kbd id="prevTab" />
          <Kbd id="nextTab" />
        </span>
      </Tabs.List>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Tabs.Content value="overview">
          <SessionOverview session={session} runs={runs} />
        </Tabs.Content>
        <Tabs.Content value="changes">
          <ChangesTab session={session} />
        </Tabs.Content>
        <Tabs.Content value="tests">
          <TestsTab session={session} />
        </Tabs.Content>
        <Tabs.Content value="logs">
          <LogsTab session={session} />
        </Tabs.Content>
      </div>
    </Tabs.Root>
  );
}

function ItemDetail({ item }: { item: BoardItem }) {
  const runs = item.runs;
  const view = item.approval ? describeApproval(item.approval) : null;
  return (
    <div className="flex flex-col">
      <div className="px-4 pt-3 pb-2">
        <div className="text-meta text-fg-3">{item.role}</div>
        <div className="text-title text-fg">{item.title}</div>
      </div>
      {item.approval && view && (
        <div className="mx-4 mb-2 flex flex-col gap-1.5 rounded-md border border-line bg-surface p-3">
          <div className="text-ui font-medium text-fg">{view.question}</div>
          {view.target && <div className="font-mono text-code break-all text-fg-2">{view.target}</div>}
          <div className="text-micro text-fg-3">要求内容</div>
          <JsonBlock value={item.approval.payload} />
        </div>
      )}
      {item.session ? (
        <SessionOverview session={item.session} runs={runs} />
      ) : item.integration ? (
        <div className="flex flex-col px-4 py-3">
          <Button
            variant="primary"
            icon={<GitMerge size={13} strokeWidth={1.75} />}
            className="mb-2 self-start"
            onClick={() => useUi.getState().openIntegration(item.integration!.id)}
          >
            レビューを開始
          </Button>
          <Field label="状態">{INTEGRATION_STATUS_LABEL[item.integration.status]}</Field>
          <Field label="ブランチ">
            <span className="font-mono text-meta">
              {item.integration.branch ?? '—'} → {item.integration.targetRef ?? '—'}
            </span>
          </Field>
          <div className="mt-2 mb-1 text-micro text-fg-3">手順</div>
          {item.integration.steps.map((s) => (
            <div key={s.index} className="flex h-6 items-center gap-2 text-meta">
              <StatusIcon state={stepState(s)} size={12} />
              <span className="truncate text-fg-2">{s.title}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CommandPanel() {
  const selectedId = useUi((s) => s.selectedId);
  const { items } = useBoard();
  if (selectedId?.startsWith('tsk_')) return <TaskDetail taskId={selectedId} />;
  const item = items.find((i) => i.id === selectedId);
  if (!item) return <Empty title="項目を選んでください" body="j / k で移動、Space で詳細を開閉します。" />;
  return <ItemDetail item={item} />;
}

function EventDetail({ event }: { event: Event }) {
  const v = describeEvent(event);
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="text-meta text-fg-3">{event.type}</div>
      <div className="text-title text-fg">{v.summary}</div>
      {v.detail && <div className="text-ui text-fg-2">{v.isDecision ? `「${v.detail}」` : v.detail}</div>}
      <Field label="時刻">
        <TimeStamp iso={event.ts} />
      </Field>
      <Field label="seq">
        <span className="tabular">{event.seq}</span>
      </Field>
      <div className="text-micro text-fg-3">内容</div>
      <JsonBlock value={event.payload} />
    </div>
  );
}

function TimelinePanel() {
  const { event, run } = useTimelineSelection();
  const sessions = useSessions().data ?? NONE;
  if (event) return <EventDetail event={event} />;
  if (run) {
    const s = sessions.find((x) => x.id === run.sessionId);
    return (
      <div className="flex flex-col px-4 py-3">
        <div className="text-title text-fg">{s ? untitled(s) : run.id}</div>
        <Field label="状態">{RUN_STATUS_LABEL[run.status]}</Field>
        <Field label="コスト">
          <Cost usd={run.usage.costUsd} source={run.usage.costSource} />
        </Field>
        <Field label="モデル">{run.model ?? '—'}</Field>
        {run.error && <Field label="エラー">{run.error.message}</Field>}
      </div>
    );
  }
  return <Empty title="イベントを選んでください" body="行を選ぶと、イベントの全内容がここに出ます。" />;
}

/**
 * Right detail panel (§4.4). The width is reserved instantly; only the content slides
 * 16px + fades (180ms in / 120ms out). Narrow windows show it as an overlay (§4.5).
 */
export function DetailPanel() {
  const mode = useUi((s) => s.mode);
  const open = useUi((s) => s.panelOpen[s.mode] && !s.reviewIntegrationId);
  const width = useUi((s) => s.panelWidth);
  const setWidth = useUi((s) => s.setPanelWidth);
  const setPanelOpen = useUi((s) => s.setPanelOpen);
  const wide = useMediaQuery('(min-width: 1440px)');
  const overlay = !useMediaQuery('(min-width: 1100px)');
  if (!open) return null;
  // Below 1440px the panel defaults to 320px unless the user widened it (§4.5).
  const w = wide || width > 360 ? width : 320;
  const content =
    mode === 'focus' ? <FocusPanel /> : mode === 'timeline' ? <TimelinePanel /> : <CommandPanel />;
  return (
    <aside
      aria-label="詳細パネル"
      data-region="panel"
      data-overlay={overlay ? 'true' : undefined}
      className={cn(
        'relative z-20 flex h-full shrink-0 flex-col border-l border-line-subtle bg-surface',
        overlay && 'absolute top-0 right-0 bottom-0 shadow-float',
      )}
      style={{ width: w }}
    >
      {mode !== 'focus' && (
        <div className="absolute top-2 right-2 z-10">
          <IconButton label="詳細パネルを閉じる" size="sm" shortcut="togglePanel" onClick={() => setPanelOpen(mode, false)}>
            <X size={14} strokeWidth={1.5} />
          </IconButton>
        </div>
      )}
      <motion.div
        key={mode}
        initial={{ opacity: 0, x: 16 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        {content}
      </motion.div>
      <ResizeHandle edge="left" width={width} onResize={setWidth} label="詳細パネルの幅" />
    </aside>
  );
}
