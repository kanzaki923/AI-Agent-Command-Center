import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { buildBoardSections, buildTaskGroups } from '../../model/tasks';
import { useConfirm } from '../../store/confirm';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { run, session, task } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { CommandView } from './CommandView';

function mount(handlers: Parameters<typeof createFakeClient>[0]) {
  const fake = createFakeClient(handlers);
  const rt = createRuntime(fake.client);
  render(
    <RuntimeProvider runtime={rt}>
      <TooltipProvider>
        <CommandView />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return { fake, rt };
}

const orch = session({ kind: 'chat', title: '設計チャット' });
const r0 = run(orch, { kind: 'orchestrator', status: 'completed' });
const by = { kind: 'agent' as const, sessionId: orch.id, runId: r0.id };
const projectId = 'prj_00000000000000000000000077';
const worker = session({ kind: 'agent', title: 'Worker: テスト', workspaceId: 'wsp_00000000000000000000000001' });

function scenario() {
  const ready = task({ projectId, title: 'README を整える', status: 'ready', createdBy: by });
  const review = task({
    projectId,
    title: 'テストを追加する',
    status: 'review',
    createdBy: by,
    assigneeSessionId: worker.id,
    workspaceId: 'wsp_00000000000000000000000001',
  });
  const waiting = task({ projectId, title: '節を足す', status: 'pending', createdBy: by, dependsOn: [ready.id] });
  const done = task({ projectId, title: '調査', status: 'done', createdBy: { kind: 'human', client: 'test' } });
  return { ready, review, waiting, done };
}

function base(tasks: ReturnType<typeof task>[], extra: Parameters<typeof createFakeClient>[0] = {}) {
  return {
    'session.list': () => ({ items: [orch, worker], nextCursor: null }),
    'run.list': () => ({ items: [r0], nextCursor: null }),
    'task.list': () => ({ items: tasks, nextCursor: null }),
    'session.messages': () => ({ items: [], hasMore: false }),
    'project.list': () => ({ items: [] }),
    ...extra,
  };
}

describe('task board model', () => {
  it('sections tasks by status, what needs you first, finished ones folded', () => {
    const { ready, review, waiting, done } = scenario();
    const groups = buildTaskGroups({ tasks: [ready, review, waiting, done], sessions: [orch, worker], runs: [r0], workspaces: [], diffs: [] });
    const sections = buildBoardSections(groups, null);
    expect(sections.map((s) => [s.status, s.tasks.map((t) => t.task.title)])).toEqual([
      ['review', ['テストを追加する']],
      ['ready', ['README を整える']],
      ['pending', ['節を足す']],
      ['done', ['調査']],
    ]);
    expect(sections.find((s) => s.status === 'done')?.collapsedByDefault).toBe(true);
    // One goal only.
    expect(buildBoardSections(groups, 'human').flatMap((s) => s.tasks.map((t) => t.task.title))).toEqual(['調査']);
  });
});

describe('<TaskBoard> (Command Mode → Task)', () => {
  beforeEach(() => {
    useUi.setState({ selectedId: null, collapsed: {}, projectId: null, commandView: 'agents', taskGoal: null });
    useConfirm.setState({ request: null });
  });

  it('lists tasks without workers and starts one with R', async () => {
    const { ready, review, waiting, done } = scenario();
    let spawned: unknown = null;
    mount(
      base([ready, review, waiting, done], {
        'task.spawnWorker': (p) => {
          spawned = p;
          return { sessionId: worker.id, runId: 'run_x', workspaceId: 'wsp_x', budgetId: null };
        },
      }),
    );
    await screen.findByText('司令室');
    // T switches the room to the task view.
    fireEvent.keyDown(window, { key: 't' });
    const board = await screen.findByTestId('task-board');
    expect(within(board).getByRole('region', { name: 'レビュー待ち' })).toHaveTextContent('テストを追加する');
    expect(within(board).getByRole('region', { name: '着手可能' })).toHaveTextContent('README を整える');
    // Done is folded by default.
    expect(within(board).queryByText('調査')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'j' });
    expect(useUi.getState().selectedId).toBe(ready.id);
    const row = screen.getByRole('option', { name: /README を整える/ });
    expect(within(row).getByRole('button', { name: /このTaskを実行/ })).toBeInTheDocument();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'r' });
    });
    expect(spawned).toEqual({ taskId: ready.id });
    // Opens the new worker.
    await waitFor(() => expect(useUi.getState().focusSessionId).toBe(worker.id));
  });

  it('sends a reviewed task back to its worker with feedback (contract fallback)', async () => {
    const { review } = scenario();
    const calls: { method: string; params: unknown }[] = [];
    const { fake } = mount(
      base([review], {
        'task.update': (p) => {
          calls.push({ method: 'task.update', params: p });
          return { ...review, status: p.status };
        },
        'task.spawnWorker': (p) => {
          calls.push({ method: 'task.spawnWorker', params: p });
          return { sessionId: worker.id, runId: 'run_y', workspaceId: 'wsp_y', budgetId: null };
        },
      }),
    );
    useUi.setState({ commandView: 'tasks' });
    await screen.findByTestId('task-board');
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'f' });
    const box = await screen.findByLabelText('差し戻しの指示');
    fireEvent.change(box, { target: { value: '境界値のテストが足りません' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toEqual({ method: 'task.update', params: { taskId: review.id, status: 'ready' } });
    expect(calls[1]!.method).toBe('task.spawnWorker');
    expect((calls[1]!.params as { instructions: string }).instructions).toContain('境界値のテストが足りません');
    expect(fake.calls.some((c) => c.method === 'task.retry')).toBe(false);
  });

  it('uses task.retry when the daemon offers it', async () => {
    const { review } = scenario();
    let retried: unknown = null;
    mount(
      base([review], {
        'system.info': () => ({ methods: ['task.retry', 'task.spawnWorker'], stats: { lastEventSeq: 0 } }),
        'task.retry': (p) => {
          retried = p;
          return { sessionId: worker.id };
        },
      }),
    );
    useUi.setState({ commandView: 'tasks' });
    await screen.findByTestId('task-board');
    // Wait for system.info (the method probe) before acting.
    await waitFor(() => expect(screen.getByRole('option', { name: /テストを追加する/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('option', { name: /テストを追加する/ }));
    fireEvent.click(screen.getByRole('button', { name: /Worker に差し戻す/ }));
    const box = await screen.findByLabelText('差し戻しの指示');
    fireEvent.change(box, { target: { value: 'ログを残して' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^差し戻す/ }));
    });
    await waitFor(() => expect(retried).toEqual({ taskId: review.id, feedback: 'ログを残して' }));
  });

  it('asks before cancelling a task (Ctrl+Shift+Backspace)', async () => {
    const { ready } = scenario();
    let cancelled: unknown = null;
    mount(
      base([ready], {
        'task.cancel': (p) => {
          cancelled = p;
          return { ...ready, status: 'cancelled' };
        },
      }),
    );
    useUi.setState({ commandView: 'tasks' });
    await screen.findByTestId('task-board');
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'Backspace', ctrlKey: true, shiftKey: true });
    const req = useConfirm.getState().request;
    expect(req?.title).toBe('Task「README を整える」を中止しますか？');
    expect(cancelled).toBeNull();
    await act(async () => req!.onConfirm());
    expect(cancelled).toMatchObject({ taskId: ready.id });
  });

  it('says what to do when there are no tasks', async () => {
    mount(base([]));
    useUi.setState({ commandView: 'tasks' });
    expect(await screen.findByText('Task はまだありません')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Orchestrator に依頼/ })).toBeInTheDocument();
  });
});
