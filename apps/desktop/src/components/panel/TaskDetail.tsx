import { ArrowRight, Check, Circle, GitBranch, GitMerge, Play } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import { spawnWorker, startIntegration } from '../../daemon/orchestration';
import { useDiff, useIntegrations, useMethods } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { TASK_STATUS_LABEL } from '../../lib/status';
import { parsePatch } from '../../model/diff';
import { INTEGRATION_STATUS_LABEL } from '../../model/integration';
import { type TaskNode, canSpawn, flattenTasks, taskState } from '../../model/tasks';
import { useUi } from '../../store/ui';
import { useTaskGroups } from '../command/TaskTree';
import { Button } from '../ui/Button';
import { TimeStamp } from '../ui/Meta';
import { StatusIcon } from '../ui/StatusIcon';
import { DiffBrowser, DiffStatText } from './DiffViewer';

const NONE: never[] = [];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-start gap-3 py-1">
      <div className="w-16 shrink-0 pt-px text-meta text-fg-3">{label}</div>
      <div className="min-w-0 flex-1 text-ui text-fg">{children}</div>
    </div>
  );
}

/** Command Mode detail panel for a task selected in the task tree. */
export function TaskDetail({ taskId }: { taskId: string }) {
  const rt = useRuntime();
  const groups = useTaskGroups();
  const methods = useMethods();
  const connected = useConnectionState() === 'open';
  const openSession = useUi((s) => s.openSession);
  const openIntegration = useUi((s) => s.openIntegration);
  const integrations = useIntegrations().data ?? NONE;
  const all = useMemo(() => flattenTasks(groups), [groups]);
  const node: TaskNode | undefined = all.find((n) => n.task.id === taskId);
  const diff = useDiff(node?.workspace?.id);
  const patch = diff.data?.patch;
  const files = useMemo(() => (patch ? parsePatch(patch) : []), [patch]);
  if (!node) return <div className="px-4 py-12 text-center text-meta text-fg-3">Task が見つかりません</div>;
  const t = node.task;
  const deps = t.dependsOn.map((id) => all.find((n) => n.task.id === id)?.task).filter((x) => !!x);
  const spawnSupported = !methods || methods.has('task.spawnWorker');
  const integ = integrations.find((i) => i.taskIds.includes(t.id) && !['rejected', 'cancelled'].includes(i.status));

  return (
    <div className="flex flex-col" data-testid="task-detail">
      <div className="px-4 pt-3 pb-2">
        <div className="text-meta text-fg-3">Task</div>
        <div className="text-title text-fg">{t.title}</div>
      </div>
      <div className="flex flex-wrap gap-2 px-4 pb-2">
        {canSpawn(t) && !node.worker && (
          <Button
            variant="primary"
            icon={<Play size={11} strokeWidth={2} fill="currentColor" />}
            disabled={!connected || !spawnSupported}
            hint={spawnSupported ? 'worktree を作り、Worker を起動します' : 'この Core Daemon は task.spawnWorker に未対応です'}
            onClick={() => void spawnWorker(rt, t).then((r) => r && openSession(r.sessionId, { from: 'command' }))}
          >
            このTaskを実行
          </Button>
        )}
        {node.worker && (
          <Button icon={<ArrowRight size={12} strokeWidth={1.75} />} onClick={() => openSession(node.worker!.id, { from: 'command' })}>
            Worker を開く
          </Button>
        )}
        {integ ? (
          <Button icon={<GitMerge size={12} strokeWidth={1.75} />} onClick={() => openIntegration(integ.id)}>
            統合: {INTEGRATION_STATUS_LABEL[integ.status]}
          </Button>
        ) : (
          t.status === 'review' &&
          node.workspace && (
            <Button
              icon={<GitMerge size={12} strokeWidth={1.75} />}
              disabled={!connected}
              onClick={() => void startIntegration(rt, t.projectId, [t.id]).then((i) => i && openIntegration(i.id))}
            >
              統合する
            </Button>
          )
        )}
      </div>
      <div className="flex flex-col px-4 py-2">
        <Field label="状態">
          <span className="flex items-center gap-2">
            <StatusIcon state={taskState(t.status)} size={13} />
            {TASK_STATUS_LABEL[t.status]}
            {t.statusReason && <span className="text-meta text-fg-3">（{t.statusReason}）</span>}
          </span>
        </Field>
        <Field label="Worker">
          {node.worker ? (
            <button type="button" className="text-left text-accent hover:underline" onClick={() => openSession(node.worker!.id, { from: 'command' })}>
              {node.worker.title || 'Worker'}
            </button>
          ) : (
            <span className="text-fg-3">未割り当て</span>
          )}
        </Field>
        {node.workspace?.branch && (
          <Field label="worktree">
            <span className="flex items-center gap-1 font-mono text-meta break-all text-fg-2">
              <GitBranch size={12} strokeWidth={1.75} className="shrink-0" />
              {node.workspace.branch}
            </span>
          </Field>
        )}
        {node.diff && (
          <Field label="変更">
            <span className="flex items-center gap-2">
              {node.diff.files} ファイル <DiffStatText additions={node.diff.additions} deletions={node.diff.deletions} />
            </span>
          </Field>
        )}
        {deps.length > 0 && (
          <Field label="依存">
            <ul className="flex flex-col gap-0.5">
              {deps.map((d) => (
                <li key={d.id} className="flex items-center gap-1.5 text-ui">
                  <StatusIcon state={taskState(d.status)} size={12} />
                  <span className={d.status === 'done' ? 'text-fg-3' : 'text-fg'}>{d.title}</span>
                </li>
              ))}
            </ul>
          </Field>
        )}
        <Field label="作成">
          <span className="flex items-center gap-1.5 text-meta text-fg-3">
            {t.createdBy.kind === 'human' ? 'あなた' : t.createdBy.kind === 'agent' ? 'Orchestrator' : 'システム'}
            <span>·</span>
            <TimeStamp iso={t.createdAt} />
          </span>
        </Field>
      </div>
      {t.description && (
        <div className="px-4 py-2">
          <div className="mb-1 text-micro text-fg-3">目的</div>
          <p className="text-ui whitespace-pre-wrap text-fg-2">{t.description}</p>
        </div>
      )}
      {t.acceptanceCriteria.length > 0 && (
        <div className="px-4 py-2">
          <div className="mb-1 text-micro text-fg-3">完了条件</div>
          <ul className="flex flex-col gap-1">
            {t.acceptanceCriteria.map((c) => (
              <li key={c} className="flex items-start gap-2 text-ui text-fg-2">
                {t.status === 'done' ? (
                  <Check size={13} strokeWidth={2} className="mt-[3px] shrink-0 text-st-completed" />
                ) : (
                  <Circle size={11} strokeWidth={1.75} className="mt-[4px] shrink-0 text-fg-4" />
                )}
                {c}
              </li>
            ))}
          </ul>
        </div>
      )}
      {t.resultSummary && (
        <div className="px-4 py-2">
          <div className="mb-1 text-micro text-fg-3">結果</div>
          <p className="text-ui whitespace-pre-wrap text-fg-2">{t.resultSummary}</p>
        </div>
      )}
      {files.length > 0 && (
        <div className="mt-1 border-t border-line-subtle">
          <div className="px-4 pt-2 text-micro text-fg-3">変更ファイル</div>
          <DiffBrowser files={files} />
        </div>
      )}
    </div>
  );
}
