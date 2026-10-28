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
