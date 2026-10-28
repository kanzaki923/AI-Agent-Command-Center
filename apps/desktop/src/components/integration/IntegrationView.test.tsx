import { AccClientError } from '@acc/client';
import type { Integration, IntegrationStep } from '@acc/protocol';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { T0, event, integration, iso } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { IntegrationView } from './IntegrationView';

const PATCH = `diff --git a/docs/auth.md b/docs/auth.md
new file mode 100644
--- /dev/null
+++ b/docs/auth.md
@@ -0,0 +1,2 @@
+# 認証 API
+POST /api/login
diff --git a/src/auth/session.ts b/src/auth/session.ts
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -1,3 +1,3 @@
 export function isExpired() {
-  return false;
+  return true;
 }
`;

const step = (over: Partial<IntegrationStep>): IntegrationStep => ({
  index: 0,
  kind: 'merge',
  status: 'succeeded',
  title: '「認証 API のドキュメント」をマージ',
  taskId: null,
  artifactId: null,
  detail: 'マージしました（1506e2a）',
  startedAt: iso(T0),
  endedAt: iso(T0 + 500),
  workspaceId: null,
  branch: null,
  conflictFiles: [],
  ...over,
});

function ready(): Integration {
  return integration({
    id: 'int_00000000000000000000000001',
    title: '統合: 認証 API のドキュメント → main',
    status: 'awaiting_approval',
    targetRef: 'main',
    branch: 'acc/integration-00000001',
    workspaceId: 'wsp_int',
    baseSha: 'aaaaaaa0',
    headSha: 'bbbbbbb0',
    taskIds: ['tsk_1'],
    steps: [
      step({ index: 0 }),
      step({
        index: 1,
        kind: 'verify',
        title: 'テストを実行（pnpm test）',
        detail: '成功（1.2 秒）',
        artifactId: 'art_test',
      }),
      step({
        index: 2,
        kind: 'apply',
        status: 'pending',
        title: '「main」へ反映（要承認）',
        detail: null,
        startedAt: null,
        endedAt: null,
      }),
    ],
  });
}

function mount(i: Integration, extra: Parameters<typeof createFakeClient>[0] = {}) {
  const fake = createFakeClient({
    'integration.list': () => ({ items: [i], nextCursor: null }),
    'project.list': () => ({ items: [] }),
    'task.list': () => ({ items: [], nextCursor: null }),
    'artifact.list': () => ({
      items: [
        {
          id: 'art_diff',
          kind: 'diff',
          data: {
            patch: PATCH,
            baseRef: null,
            headRef: null,
            stats: { files: 2, additions: 3, deletions: 1 },
            files: [],
          },
        },
      ],
      nextCursor: null,
    }),
    'artifact.get': () => ({
      id: 'art_test',
      kind: 'test_result',
      data: {
        command: 'pnpm test',
        passed: true,
        exitCode: 0,
        durationMs: 1200,
        summary: '成功（1.2 秒）',
        output: 'Tests  24 passed (24)',
      },
    }),
    ...extra,
  });
  const rt = createRuntime(fake.client);
  render(
    <RuntimeProvider runtime={rt}>
      <TooltipProvider>
        <IntegrationView integrationId={i.id} />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return { fake, rt };
}

describe('<IntegrationView>', () => {
  beforeEach(() => {
    useUi.setState({ reviewIntegrationId: 'int_00000000000000000000000001' });
  });

  it('shows ordered steps, test output and the combined diff per file', async () => {
    mount(ready());
    expect(await screen.findByText('「認証 API のドキュメント」をマージ')).toBeInTheDocument();
    expect(screen.getByText('テストを実行（pnpm test）')).toBeInTheDocument();
    expect(await screen.findByText(/Tests\s+24 passed/)).toBeInTheDocument();
    expect(await screen.findByText(/# 認証 API/)).toBeInTheDocument();
    // Per-file collapse.
    const header = screen
      .getAllByRole('button', { name: /session\.ts/ })
      .find((b) => b.getAttribute('aria-expanded') !== null)!;
    expect(screen.getByText(/return true;/)).toBeInTheDocument();
    fireEvent.click(header);
    expect(screen.queryByText(/return true;/)).not.toBeInTheDocument();
    // j / k move between files (session.ts is current after the click), o toggles.
    fireEvent.keyDown(window, { key: 'k' });
    fireEvent.keyDown(window, { key: 'o' });
    expect(screen.queryByText(/# 認証 API/)).not.toBeInTheDocument();
  });

  it('confirms exactly what applying does, then applies at once', async () => {
    const i = ready();
    let approved: Record<string, unknown> | null = null;
    mount(i, {
      'integration.approve': (p) => {
        approved = p;
        return { ...i, status: 'applied', decidedAt: iso(T0 + 9000) };
      },
    });
    fireEvent.click(await screen.findByTestId('approve-integration'));
    const dialog = await screen.findByRole('dialog', { name: 'main に変更を反映しますか？' });
    expect(within(dialog).getByText(/早送り（fast-forward）/)).toHaveTextContent(
      'aaaaaaa → bbbbbbb',
    );
    expect(within(dialog).getByText(/を main に反映します/)).toHaveTextContent('2 ファイル、+3 −1');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '反映する' }));
    });
    expect(approved).toEqual({ integrationId: i.id });
    expect(await screen.findByText('main に反映しました')).toBeInTheDocument();
    expect(screen.queryByTestId('approve-integration')).not.toBeInTheDocument();
  });

  it('follows live step progress and offers a re-run after a conflict', async () => {
    const i = {
      ...ready(),
      status: 'running' as const,
      steps: ready().steps.map((s) => ({ ...s, status: 'pending' as const, detail: null })),
    };
    const { fake } = mount(i);
    expect(await screen.findByText('変更を順番にマージしています…')).toBeInTheDocument();
    const conflicted: Integration = {
      ...i,
      status: 'conflict',
      error: {
        code: 'merge_conflict',
        message: '「acc/x」のマージでコンフリクトが発生しました: src/a.ts',
      },
      steps: i.steps.map((s) =>
        s.index === 0
          ? {
              ...s,
              status: 'failed',
              conflictFiles: ['src/a.ts'],
              detail: 'コンフリクトが発生しました',
            }
          : s,
      ),
    };
    act(() =>
      fake.emit(
        event('integration.updated', { integration: conflicted, changes: ['status', 'steps'] }),
      ),
    );
    expect(await screen.findByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '再実行' })).toBeInTheDocument();
    expect(screen.queryByTestId('approve-integration')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/コンフリクトが発生しました: src\/a\.ts/)).toBeInTheDocument(),
    );
  });
});

/** Two merges; the second conflicted on README.md (as the daemon records it). */
function conflicted(): Integration {
  return integration({
    id: 'int_00000000000000000000000001',
    title: '統合: ドキュメントとテスト → main',
    status: 'conflict',
    targetRef: 'main',
    branch: 'acc/integration-00000001',
    workspaceId: 'wsp_int',
    taskIds: ['tsk_1', 'tsk_2'],
    error: { code: 'merge_conflict', message: '「acc/tests」のマージでコンフリクトが発生しました: README.md' },
    steps: [
      step({ index: 0, title: '「ドキュメント」をマージ', branch: 'acc/docs' }),
      step({
        index: 1,
        status: 'failed',
        title: '「テスト」をマージ',
        branch: 'acc/tests',
        detail: 'コンフリクトが発生しました',
        conflictFiles: ['README.md'],
      }),
      // The daemon skips verification of an attempt that stopped on a conflict.
      step({ index: 2, kind: 'verify', status: 'skipped', title: 'テストを実行（pnpm test）', detail: null }),
      step({ index: 3, kind: 'apply', status: 'pending', title: '「main」へ反映（要承認）', detail: null }),
    ],
  });
}

const fix = (over: Partial<IntegrationStep>): IntegrationStep =>
  step({
    index: 2,
    kind: 'fix',
    status: 'running',
    title: 'Integrator がコンフリクトを解消（README.md）',
    branch: 'acc/tests',
    conflictFiles: ['README.md'],
    detail: 'Integrator（Run run_int）がコンフリクトを解消しています',
    endedAt: null,
    ...over,
  });

function resolving(base: Integration, over: Partial<IntegrationStep> = {}): Integration {
  const [m0, m1, verify, apply] = base.steps;
  return {
    ...base,
    status: 'running',
    error: null,
    resolverRunId: 'run_int',
    steps: [m0!, m1!, fix(over), { ...verify!, index: 3 }, { ...apply!, index: 4 }],
    updatedAt: iso(T0 + 1000),
  };
}

describe('<IntegrationView> conflict → Integrator', () => {
  beforeEach(() => {
    useUi.setState({ reviewIntegrationId: 'int_00000000000000000000000001', focusSessionId: null });
  });

  it('explains what the Integrator will do, starts it with the guidance and shows its live progress', async () => {
    const i = conflicted();
    let called: Record<string, unknown> | null = null;
    const { fake } = mount(i, {
      'integration.resolveWithAgent': (p) => {
        called = p;
        return { integration: resolving(i, { detail: 'コンフリクトしたマージを作業ツリーに再現しています' }), sessionId: 'ses_int', runId: 'run_int' };
      },
      'run.get': () => ({ id: 'run_int', sessionId: 'ses_int', status: 'running' }),
    });
    const button = await screen.findByTestId('resolve-with-agent');
    expect(button).toHaveTextContent('Integrator に解消を任せる');
    // Not "no test command": the tests did not run because the merge stopped.
    expect(screen.getByText('マージが終わっていないため、テストはまだ実行していません。')).toBeInTheDocument();
    // Re-running would only conflict again: it steps back to a quiet action.
    expect(screen.getByRole('button', { name: '再実行' })).toBeInTheDocument();
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Integrator にコンフリクトの解消を任せますか？' });
    expect(dialog).toHaveTextContent('「テスト」をマージするときに README.md がコンフリクトしました。');
    expect(dialog).toHaveTextContent('main はまだ変更しません（反映にはあなたの承認が必要です）');
    fireEvent.change(within(dialog).getByLabelText('Integrator への補足'), {
      target: { value: '両方の節を残して' },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /Integrator に任せる/ }));
    });
    expect(called).toEqual({ integrationId: i.id, instructions: '両方の節を残して' });
    expect(await screen.findByTestId('resolving')).toHaveTextContent('Integrator がコンフリクトを解消しています');
    expect(screen.queryByTestId('resolve-with-agent')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '却下' })).not.toBeInTheDocument();

    // The daemon's integration.updated events carry the fix step's progress.
    act(() =>
      fake.emit(
        event('integration.updated', {
          integration: { ...resolving(i), updatedAt: iso(T0 + 2000) },
          changes: ['resolverRunId', 'steps'],
        }),
      ),
    );
    expect(await screen.findByText('Integrator（Run run_int）がコンフリクトを解消しています')).toBeInTheDocument();
    const fixRow = document.querySelector('[data-step="fix"]')!;
    expect(fixRow).toHaveAttribute('data-status', 'running');
    // Its session is one click away (the bar and the step).
    fireEvent.click(await screen.findByRole('button', { name: /Integrator を開く/ }));
    expect(useUi.getState().focusSessionId).toBe('ses_int');
  });

  it('shows the result: resumed to approval with the fix step done', async () => {
    const i = resolving(conflicted());
    const { fake } = mount(i, { 'run.get': () => ({ id: 'run_int', sessionId: 'ses_int', status: 'completed' }) });
    expect(await screen.findByTestId('resolving')).toBeInTheDocument();
    const done: Integration = {
      ...i,
      status: 'awaiting_approval',
      headSha: 'ccccccc0',
      baseSha: 'aaaaaaa0',
      steps: i.steps.map((s) =>
        s.kind === 'fix'
          ? { ...s, status: 'succeeded', detail: 'Integrator がコンフリクトを解消し、マージをコミットしました（ccccccc）', endedAt: iso(T0 + 4000) }
          : s.kind === 'apply'
            ? s
            : { ...s, status: 'succeeded' },
      ),
      updatedAt: iso(T0 + 5000),
    };
    act(() => fake.emit(event('integration.updated', { integration: done, changes: ['status', 'steps'] })));
    expect(await screen.findByTestId('approve-integration')).toBeInTheDocument();
    expect(screen.getByText('Integrator がコンフリクトを解消し、マージをコミットしました（ccccccc）')).toBeInTheDocument();
    expect(screen.queryByTestId('resolving')).not.toBeInTheDocument();
    // The merge keeps the record of where it conflicted, labelled as past.
    expect(screen.getByRole('list', { name: 'コンフリクトしていたファイル' })).toHaveTextContent('README.md');
  });

  it('offers another try when the Integrator could not resolve it', async () => {
    const base = conflicted();
    const failed: Integration = {
      ...resolving(base, {
        status: 'failed',
        detail: 'Integrator の解消を確認できませんでした: コンフリクトマーカーが残っています: README.md',
      }),
      status: 'conflict',
      error: {
        code: 'resolution_failed',
        message: 'Integrator の解消を確認できませんでした: コンフリクトマーカーが残っています: README.md',
      },
    };
    mount(failed);
    expect(await screen.findByTestId('resolve-with-agent')).toHaveTextContent('もう一度 Integrator に任せる');
    expect(screen.getAllByText(/コンフリクトマーカーが残っています/).length).toBeGreaterThan(0);
  });

  it('puts the conflict back when the daemon refuses', async () => {
    const i = conflicted();
    mount(i, {
      'integration.resolveWithAgent': () => {
        throw new AccClientError('forbidden', 'この操作の権限がありません');
      },
    });
    fireEvent.click(await screen.findByTestId('resolve-with-agent'));
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /Integrator に任せる/ }));
    });
    expect(await screen.findByTestId('resolve-with-agent')).toBeInTheDocument();
    expect(screen.queryByTestId('resolving')).not.toBeInTheDocument();
  });
});
