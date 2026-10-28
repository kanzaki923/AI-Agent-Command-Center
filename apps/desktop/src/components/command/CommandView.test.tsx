import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { approval, event, run, session, task } from '../../test/fixtures';
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

describe('<CommandView>', () => {
  beforeEach(() => {
    useUi.setState({ selectedId: null, collapsed: {}, projectId: null });
  });

  it('degrades to the empty state when list methods are not implemented', async () => {
    const { fake } = mount({ 'session.list': () => ({ items: [], nextCursor: null }) });
    expect(await screen.findByText('何を進めますか？')).toBeInTheDocument();
    // run.list / approval.list / task.list / integration.list answered not_implemented: no crash.
    expect(fake.calls.map((c) => c.method)).toEqual(
      expect.arrayContaining(['run.list', 'approval.list', 'task.list', 'integration.list']),
    );
  });

  it('shows approvals first and approves inline, optimistically', async () => {
    const s = session({ title: 'API のリファクタリング' });
    const r = run(s, { status: 'awaiting_approval' });
    s.activeRunId = r.id;
    const other = session({ title: 'テストの拡充' });
    const r2 = run(other, { status: 'running' });
    other.activeRunId = r2.id;
    const a = approval(r, { payload: { toolName: 'Bash', input: { command: 'pnpm db:migrate' } } });
    let responded: unknown = null;
    const { fake } = mount({
      'session.list': () => ({ items: [other, s], nextCursor: null }),
      'run.list': () => ({ items: [r, r2], nextCursor: null }),
      'approval.list': (p) => ({ items: (p.status as string[]).includes('pending') ? [a] : [], nextCursor: null }),
      'approval.respond': (p) => {
        responded = p;
        return { ...a, status: 'approved' };
      },
    });

    const card = await screen.findByRole('option', { name: /API のリファクタリング · 承認待ち/ });
    expect(screen.getByText('コマンドの実行を承認しますか？')).toBeInTheDocument();
    expect(screen.getByText('$ pnpm db:migrate')).toBeInTheDocument();
    // The attention card renders before the running row.
    const options = screen.getAllByRole('option');
    expect(options[0]).toBe(card);

    // Y on the focused card approves.
    card.focus();
    await act(async () => {
      fireEvent.keyDown(card, { key: 'y' });
    });
    expect(responded).toMatchObject({ approvalId: a.id, decision: 'approve' });
    await waitFor(() => expect(screen.getByText('承認しました')).toBeInTheDocument());

    // The daemon then moves the run back to running: the card leaves the attention zone.
    act(() => {
      fake.emit(event('run.status_changed', { runId: r.id, from: 'awaiting_approval', to: 'running', reason: null }));
    });
    await waitFor(() => expect(screen.queryByText('コマンドの実行を承認しますか？')).not.toBeInTheDocument());
  });

  it('moves a row into the attention zone when an approval arrives (live)', async () => {
    const s = session({ title: '認証機能の改善' });
    const r = run(s, { status: 'running' });
    s.activeRunId = r.id;
    const { fake } = mount({
      'session.list': () => ({ items: [s], nextCursor: null }),
      'run.list': () => ({ items: [r], nextCursor: null }),
      'approval.list': () => ({ items: [], nextCursor: null }),
    });
    await screen.findByText('認証機能の改善');
    expect(screen.getByText('すべて順調です。あなたの出番はまだありません。')).toBeInTheDocument();
    act(() => {
      fake.emit(event('approval.requested', { approval: approval(r) }));
    });
    expect(await screen.findByText('コマンドの実行を承認しますか？')).toBeInTheDocument();
  });

  it('requires Ctrl+Y for a high-risk approval (payload.risk) and shows why', async () => {
    const s = session({ title: 'リリース' });
    const r = run(s, { status: 'awaiting_approval' });
    s.activeRunId = r.id;
    const a = approval(r, { payload: { toolName: 'Bash', input: { command: 'pnpm run deploy' }, risk: 'high' } });
    let responded = 0;
    mount({
      'session.list': () => ({ items: [s], nextCursor: null }),
      'run.list': () => ({ items: [r], nextCursor: null }),
      'approval.list': (p) => ({ items: (p.status as string[]).includes('pending') ? [a] : [], nextCursor: null }),
      'approval.respond': () => {
        responded++;
        return { ...a, status: 'approved' };
      },
    });
    const card = await screen.findByRole('option', { name: /リリース · 承認待ち/ });
    expect(screen.getByRole('button', { name: /承認（要注意）/ })).toBeInTheDocument();
    expect(screen.getByText('取り消せない操作や外部への送信を含む可能性があります')).toBeInTheDocument();
    card.focus();
    await act(async () => {
      fireEvent.keyDown(card, { key: 'y' });
    });
    expect(responded).toBe(0);
    await act(async () => {
      fireEvent.keyDown(card, { key: 'y', ctrlKey: true });
    });
    expect(responded).toBe(1);
  });

  it('shows the orchestrator’s task tree and opens a task’s detail', async () => {
    const orch = session({ kind: 'chat', title: '設計チャット' });
    const r0 = run(orch, { kind: 'chat', status: 'completed' });
    const by = { kind: 'agent' as const, sessionId: orch.id, runId: r0.id };
    const t1 = task({ title: 'ドキュメント', status: 'ready', createdBy: by });
    const t2 = task({ title: 'テスト', status: 'running', createdBy: by, projectId: t1.projectId });
    mount({
      'session.list': () => ({ items: [orch], nextCursor: null }),
      'run.list': () => ({ items: [r0], nextCursor: null }),
      'task.list': () => ({ items: [t1, t2], nextCursor: null }),
      'session.messages': () => ({ items: [], hasMore: false }),
    });
    const tree = await screen.findByTestId('task-tree');
    expect(tree).toHaveTextContent('目標: 設計チャット');
    expect(tree).toHaveTextContent('Task 0/2');
    const rows = screen.getAllByRole('treeitem');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('テスト'), expect.stringContaining('ドキュメント')]);
    fireEvent.click(rows[1]!);
    expect(useUi.getState().selectedId).toBe(t1.id);
    // ready + no worker: the row offers to run it.
    expect(within(rows[1]!).getByRole('button', { name: /このTaskを実行/ })).toBeInTheDocument();
  });

  it('moves the selection with j / k without focusing', async () => {
    const a = session({ title: 'A' });
    const b = session({ title: 'B' });
    const ra = run(a);
    const rb = run(b);
    a.activeRunId = ra.id;
    b.activeRunId = rb.id;
    mount({
      'session.list': () => ({ items: [a, b], nextCursor: null }),
      'run.list': () => ({ items: [ra, rb], nextCursor: null }),
    });
    await screen.findAllByRole('option');
    fireEvent.keyDown(window, { key: 'j' });
    expect(useUi.getState().selectedId).toBe(a.id);
    fireEvent.keyDown(window, { key: 'j' });
    expect(useUi.getState().selectedId).toBe(b.id);
    fireEvent.keyDown(window, { key: 'k' });
    expect(useUi.getState().selectedId).toBe(a.id);
  });
});
