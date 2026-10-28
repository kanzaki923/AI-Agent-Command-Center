import type { Integration } from '@acc/protocol';
import { ChevronRight, GitBranch, GitMerge, Play } from 'lucide-react';
import { memo, useMemo } from 'react';
import { spawnWorker, startIntegration } from '../../daemon/orchestration';
import {
  useIntegrations,
  useMessages,
  useMethods,
  useProjectArtifacts,
  useRuns,
  useSessions,
  useTasks,
  useWorkspaces,
} from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { cn } from '../../lib/cn';
import { INTEGRATION_STATUS_LABEL, integrationState } from '../../model/integration';
import {
  type TaskGroup,
  type TaskNode,
  buildTaskGroups,
  canSpawn,
  goalFromMessages,
  integrableTasks,
  taskDisplay,
  workerLabel,
} from '../../model/tasks';
import { useUi } from '../../store/ui';
import { OrchestratorMark } from '../grant/Grant';
import { DiffStatText } from '../panel/DiffViewer';
import { Button } from '../ui/Button';
import { StatusIcon } from '../ui/StatusIcon';
import { Tooltip } from '../ui/Tooltip';

const NONE: never[] = [];
/** Finished plans kept on the board (collapsed), newest first. */
const FINISHED_SHOWN = 2;

export function useTaskGroups(): TaskGroup[] {
  const projectId = useUi((s) => s.projectId);
  const tasks = useTasks().data ?? NONE;
  const sessions = useSessions().data ?? NONE;
  const runs = useRuns().data ?? NONE;
  const workspaces = useWorkspaces().data ?? NONE;
  const diffs = useProjectArtifacts(projectId, 'diff').data ?? NONE;
  return useMemo(
    () => buildTaskGroups({ tasks, sessions, runs, workspaces, diffs, projectId }),
    [tasks, sessions, runs, workspaces, diffs, projectId],
  );
}

/** The integration that covers a group's tasks (latest first), if any. */
export function groupIntegration(
  group: TaskGroup,
  integrations: readonly Integration[],
): Integration | null {
  const ids = new Set<string>();
  const walk = (n: TaskNode) => {
    ids.add(n.task.id);
    n.children.forEach(walk);
  };
  group.roots.forEach(walk);
  return integrations.find((i) => i.taskIds.some((t) => ids.has(t))) ?? null;
}

const TaskRow = memo(function TaskRow({
  node,
  depth,
  last,
  selected,
  spawnable,
}: {
  node: TaskNode;
  depth: number;
  last: boolean;
  selected: boolean;
  spawnable: boolean;
}) {
  const rt = useRuntime();
  const select = useUi((s) => s.select);
  const setPanelOpen = useUi((s) => s.setPanelOpen);
  const openSession = useUi((s) => s.openSession);
  const connected = useConnectionState() === 'open';
  const t = node.task;
  const { state, label } = taskDisplay(node);
  const worker = workerLabel(node);
  const choose = () => {
    select(t.id);
    setPanelOpen('command', true);
  };
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-level={depth + 1}
      tabIndex={0}
      data-task-item={t.id}
      onClick={choose}
      onDoubleClick={() => node.worker && openSession(node.worker.id, { from: 'command' })}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          if (node.worker) openSession(node.worker.id, { from: 'command' });
          else choose();
        } else if (e.key === ' ') {
          e.preventDefault();
          choose();
        }
      }}
      className={cn(
        'group relative flex h-8 cursor-default items-center gap-2 rounded-sm pr-2 outline-none',
        'focus-visible:shadow-[inset_0_0_0_1px_var(--focus-ring)]',
        selected ? 'bg-selected' : 'hover:bg-hover',
      )}
      style={{ paddingLeft: 12 + depth * 18 }}
    >
      {selected && (
        <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-accent" />
      )}
      {/* Tree guide: a quiet elbow joins each task to its goal. */}
      <span aria-hidden="true" className="relative h-full w-3 shrink-0">
        <span className={cn('absolute left-1 w-px bg-line', last ? 'top-0 h-1/2' : 'inset-y-0')} />
        <span className="absolute top-1/2 left-1 h-px w-2 bg-line" />
      </span>
      <StatusIcon state={state} size={13} />
      <span className="min-w-0 flex-1 truncate text-ui text-fg">{t.title}</span>
      {node.waitsFor.length > 0 && (
        <Tooltip
          content={`先に終わる必要がある Task: ${node.waitsFor.map((d) => d.title).join('、')}`}
        >
          <span className="hidden max-w-48 shrink truncate text-meta text-fg-4 @[720px]:block">
            ← {node.waitsFor.map((d) => d.title).join('、')}
          </span>
        </Tooltip>
      )}
      {/* Fixed columns; the less important ones give way first as the board narrows. */}
      <span
        className={cn(
          'w-24 shrink-0 text-right text-meta whitespace-nowrap',
          state === 'awaiting_approval' ? 'text-st-awaiting_approval' : 'text-fg-3',
        )}
      >
        {label}
      </span>
      <span className="hidden w-36 shrink-0 truncate text-meta text-fg-2 @[560px]:block">
        {worker ? `Worker · ${worker}` : <span className="text-fg-4">未割り当て</span>}
      </span>
      <span className="hidden w-48 shrink-0 items-center gap-1 font-mono text-meta text-fg-3 @[760px]:flex">
        {node.workspace?.branch ? (
          <>
            <GitBranch size={11} strokeWidth={1.75} className="shrink-0" />
            <span className="truncate">{node.workspace.branch}</span>
          </>
        ) : (
          <span className="text-fg-4">—</span>
        )}
      </span>
      <span className="w-16 shrink-0 text-right">
        {node.diff && node.diff.files > 0 ? (
          <DiffStatText additions={node.diff.additions} deletions={node.diff.deletions} />
        ) : (
          <span className="text-meta text-fg-4">—</span>
        )}
      </span>
      {spawnable && canSpawn(t) && !node.worker && (
        // Hover action floats over the row's right edge (no reserved column).
        <span
          className="absolute inset-y-0 right-0 flex items-center rounded-r-sm pr-1 pl-8 opacity-0 [mask-image:linear-gradient(to_right,transparent,black_28px)] group-hover:opacity-100 group-focus-within:opacity-100"
          // The row's own surface (card + hover tint), so the fade blends into it.
          style={{ background: 'linear-gradient(var(--bg-hover), var(--bg-hover)), var(--bg-surface)' }}
        >
          <Button
            size="sm"
            variant="secondary"
            icon={<Play size={10} strokeWidth={2} fill="currentColor" />}
            disabled={!connected}
            onClick={(e) => {
              e.stopPropagation();
              void spawnWorker(rt, t);
            }}
          >
            このTaskを実行
          </Button>
        </span>
      )}
    </div>
  );
});

function Nodes({
  nodes,
  depth,
  selectedId,
  spawnable,
}: {
  nodes: TaskNode[];
  depth: number;
  selectedId: string | null;
  spawnable: boolean;
}) {
  return (
    <>
      {nodes.map((n, i) => (
        <div key={n.task.id} role="group">
          <TaskRow
            node={n}
            depth={depth}
            last={i === nodes.length - 1}
            selected={selectedId === n.task.id}
            spawnable={spawnable}
          />
          {n.children.length > 0 && (
            <Nodes
              nodes={n.children}
              depth={depth + 1}
              selectedId={selectedId}
              spawnable={spawnable}
            />
          )}
        </div>
      ))}
    </>
  );
}

function Progress({ group }: { group: TaskGroup }) {
  const { total, done, review } = group.counts;
  return (
    <Tooltip content={`完了 ${done} · レビュー待ち ${review} · 全 ${total} 件`}>
      <span className="flex items-center gap-2 text-meta text-fg-3 tabular">
        Task {done}/{total}
        <span
          className="flex h-1.5 w-16 overflow-hidden rounded-full bg-selected"
          aria-hidden="true"
        >
          <span
            className="h-full bg-st-completed"
            style={{ width: `${(done / Math.max(1, total)) * 100}%` }}
          />
          <span
            className="h-full bg-st-review"
            style={{ width: `${(review / Math.max(1, total)) * 100}%` }}
          />
        </span>
      </span>
    </Tooltip>
  );
}

/**
 * The goal in the human's words: the request that started the orchestration (the
 * orchestrator chat's first message of yours), else the plan's own title.
 */
function GoalText({ group }: { group: TaskGroup }) {
  const messages = useMessages(group.orchestrator?.id).data ?? NONE;
  const asked = goalFromMessages(messages);
  return <span className="font-medium text-fg">{asked ?? group.goal}</span>;
}

function GroupCard({
  group,
  selectedId,
  spawnable,
}: {
  group: TaskGroup;
  selectedId: string | null;
  spawnable: boolean;
}) {
  const rt = useRuntime();
  const openSession = useUi((s) => s.openSession);
  const openIntegration = useUi((s) => s.openIntegration);
  const collapsed = useUi((s) => s.collapsed[`tasks.${group.id}`] ?? group.finished);
  const toggle = useUi((s) => s.toggleCollapsed);
  const integrations = useIntegrations().data ?? NONE;
  const connected = useConnectionState() === 'open';
  const integ = groupIntegration(group, integrations);
  const ready = integrableTasks(group);
  const canIntegrate =
    ready.length > 0 && (!integ || ['rejected', 'cancelled', 'applied'].includes(integ.status));
  return (
    <section
      aria-label={`目標: ${group.goal}`}
      className="@container rounded-md border border-line-subtle bg-surface"
    >
      <div className="flex h-10 items-center gap-2.5 pr-2 pl-3">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Task を表示' : 'Task を隠す'}
          onClick={() => toggle(`tasks.${group.id}`, group.finished)}
          className="flex size-5 items-center justify-center rounded-xs text-fg-4 hover:text-fg-2"
        >
          <ChevronRight
            size={13}
            strokeWidth={1.75}
            className={cn('transition-transform duration-[120ms]', !collapsed && 'rotate-90')}
          />
        </button>
        {group.orchestrator ? <OrchestratorMark size={12} /> : <span className="size-3" />}
        <span className="min-w-0 flex-1 truncate text-ui">
          <span className="text-fg-3">目標: </span>
          <GoalText group={group} />
          {group.orchestrator && (
            <button
              type="button"
              onClick={() => openSession(group.orchestrator!.id, { from: 'command' })}
              className="ml-2 text-meta text-fg-3 hover:text-fg-2 hover:underline"
            >
              Orchestrator · {group.orchestrator.title || '新しいチャット'}
            </button>
          )}
        </span>
        <Progress group={group} />
        {integ && !['rejected', 'cancelled'].includes(integ.status) ? (
          <Button
            size="sm"
            variant={integ.status === 'awaiting_approval' ? 'primary' : 'secondary'}
            icon={<StatusIcon state={integrationState(integ.status)} size={11} />}
            onClick={() => openIntegration(integ.id)}
          >
            統合: {INTEGRATION_STATUS_LABEL[integ.status]}
          </Button>
        ) : canIntegrate ? (
          <Tooltip
            content={`レビュー待ちの ${ready.length} 件を統合ブランチにマージしてテストします`}
          >
            <Button
              size="sm"
              variant="secondary"
              icon={<GitMerge size={12} strokeWidth={1.75} />}
              disabled={!connected}
              onClick={() =>
                void startIntegration(
                  rt,
                  group.projectId,
                  ready.map((t) => t.id),
                ).then((i) => i && openIntegration(i.id))
              }
            >
              統合する
            </Button>
          </Tooltip>
        ) : null}
      </div>
      {!collapsed && (
        <div role="tree" aria-label="Task" className="pb-1.5">
          <Nodes nodes={group.roots} depth={0} selectedId={selectedId} spawnable={spawnable} />
        </div>
      )}
    </section>
  );
}

/**
 * Command Mode: the orchestrators' plans as compact trees (goal → tasks), shown above the
 * agent list while work is in progress. Finished plans fold away (only the latest stay).
 */
export function TaskTree() {
  const groups = useTaskGroups();
  const selectedId = useUi((s) => s.selectedId);
  const methods = useMethods();
  // Show the spawn affordance unless the daemon positively lacks the method.
  const spawnable = !methods || methods.has('task.spawnWorker');
  // Active plans, plus the most recently finished ones (collapsed; the outcome stays in view).
  const finished = groups.filter((g) => g.finished).slice(0, FINISHED_SHOWN);
  const visible = groups.filter((g) => !g.finished || finished.includes(g));
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-6 pb-3" data-testid="task-tree">
      {visible.map((g) => (
        <GroupCard key={g.id} group={g} selectedId={selectedId} spawnable={spawnable} />
      ))}
    </div>
  );
}
