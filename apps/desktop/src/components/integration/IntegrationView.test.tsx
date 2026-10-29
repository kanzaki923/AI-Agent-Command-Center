import type { Artifact, Integration, IntegrationStep } from '@acc/protocol';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { T0, card, integration, iso } from '../../test/fixtures';
import { output } from '../outputs/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { IntegrationView, integrationLabel, integrationShape } from './IntegrationView';

const CHILD = 'ses_00000000000000000000000002';
const INT = 'int_00000000000000000000000001';

const step = (over: Partial<IntegrationStep>): IntegrationStep => ({
  index: 0,
  kind: 'merge',
  status: 'succeeded',
  title: '「認証 API」をマージ',
  taskId: null,
  artifactId: null,
  detail: null,
  startedAt: iso(T0),
  endedAt: iso(T0 + 500),
  workspaceId: null,
  branch: null,
  conflictFiles: [],
  ...over,
});

function mount(id: string, handlers: Parameters<typeof createFakeClient>[0] = {}) {
  const fake = createFakeClient({
    'project.list': () => ({
      items: [{ id: 'prj_00000000000000000000000001', name: 'web', defaultBranch: 'main' }],
    }),
    'integration.list': () => ({ items: [], nextCursor: null }),
    ...handlers,
  });
  const rt = createRuntime(fake.client);
  render(
    <RuntimeProvider runtime={rt}>
      <TooltipProvider>
        <IntegrationView integrationId={id} />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return { fake, rt };
}

describe('<IntegrationView> of a code output (広げる)', () => {
  const code = (): Artifact =>
    output('diff', {
      sessionId: CHILD,
      projectId: 'prj_00000000000000000000000001',
      workspaceId: 'wsp_1',
      title: 'エラーメッセージを直す',
      review: { state: 'pending', by: null, at: null, note: null },
    });

  beforeEach(() => useUi.setState({ reviewIntegrationId: null }));

  function mountCode(a: Artifact, extra: Parameters<typeof createFakeClient>[0] = {}) {
    useUi.setState({ reviewIntegrationId: a.id });
    return mount(a.id, {
      'artifact.get': () => a,
      'artifact.list': () => ({ items: [a], nextCursor: null }),
      'session.tree': () => ({
        rootSessionId: CHILD,
        nodes: [card({ id: CHILD, title: 'エラーを直す子', state: 'review' })],
      }),
      ...extra,
    });
  }

  it('shows the change file by file with where it goes, and goes back to the conversation', async () => {
    mountCode(code());
    expect(
      await screen.findByRole('heading', { name: 'エラーメッセージを直す' }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/# 認証 API/)).toBeInTheDocument();
    expect(screen.getByText('2 ファイル')).toBeInTheDocument();
    expect(await screen.findByTestId('target')).toHaveTextContent('main');
    // J / K move between files, O folds the current one.
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'o' });
    expect(screen.queryByText(/# 認証 API/)).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /エラーを直す子/ }));
    expect(useUi.getState().reviewIntegrationId).toBeNull();
  });

  it('adopts with Ctrl+Enter, then shows the change being applied', async () => {
    const a = code();
    const { fake } = mountCode(a, {
      'artifact.review': () => ({ artifact: a, integrationId: INT }),
    });
    await screen.findByRole('button', { name: /採用/ });
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    expect(fake.calls.find((c) => c.method === 'artifact.review')?.params).toEqual({
      artifactId: a.id,
      decision: 'accept',
    });
    expect(await screen.findByText('反映中')).toBeInTheDocument();
  });

  it('says 反映済み once the change was applied', async () => {
    mountCode({
      ...code(),
      review: { state: 'accepted', by: { kind: 'human', client: 'test' }, at: iso(T0), note: null },
    });
    expect(await screen.findByText('反映済み')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /採用/ })).toBeNull();
  });
});

describe('<IntegrationView> of an integration', () => {
  function mountInteg(i: Integration, extra: Parameters<typeof createFakeClient>[0] = {}) {
    useUi.setState({ reviewIntegrationId: i.id });
    return mount(i.id, {
      'integration.list': () => ({ items: [i], nextCursor: null }),
      'artifact.list': () => ({
        items: [output('diff', { workspaceId: 'wsp_int' })],
        nextCursor: null,
      }),
      ...extra,
    });
  }

  const ready = () =>
    integration({
      id: INT,
      title: '2 件のコードの変更を反映',
      status: 'awaiting_approval',
      targetRef: 'main',
      workspaceId: 'wsp_int',
      steps: [step({}), step({ index: 1, kind: 'verify', title: 'テスト' })],
    });

  it('applies with 反映 (and Ctrl+Enter); やめる rejects', async () => {
    const i = ready();
    const { fake } = mountInteg(i, {
      'integration.approve': () => ({ ...i, status: 'applied' }),
      'integration.reject': () => ({ ...i, status: 'rejected' }),
    });
    expect(await screen.findByText('反映待ち')).toBeInTheDocument();
    expect(await screen.findByText(/return true;/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('approve-integration'));
    expect(fake.calls.some((c) => c.method === 'integration.approve')).toBe(true);
    expect(await screen.findByText('反映済み')).toBeInTheDocument();
  });

  it('やめる rejects it', async () => {
    const i = ready();
    const { fake } = mountInteg(i, { 'integration.reject': () => ({ ...i, status: 'rejected' }) });
    fireEvent.click(await screen.findByRole('button', { name: 'やめる' }));
    await waitFor(() =>
      expect(fake.calls.some((c) => c.method === 'integration.reject')).toBe(true),
    );
    expect(await screen.findByText('やめました')).toBeInTheDocument();
  });

  it('on a conflict lists the files and hands the conflict to an agent', async () => {
    const i = integration({
      id: INT,
      title: '2 件のコードの変更を反映',
      status: 'conflict',
      targetRef: 'main',
      steps: [step({ status: 'failed', conflictFiles: ['src/auth.ts'], branch: 'acc/a' })],
      error: { code: 'conflict', message: 'src/auth.ts が競合しました' },
    });
    const { fake } = mountInteg(i, {
      'integration.resolveWithAgent': () => ({
        integration: { ...i, status: 'running' },
        sessionId: null,
      }),
    });
    expect(await screen.findByRole('list', { name: '競合したファイル' })).toHaveTextContent(
      'src/auth.ts',
    );
    expect(screen.getByText('競合')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    await waitFor(() =>
      expect(fake.calls.some((c) => c.method === 'integration.resolveWithAgent')).toBe(true),
    );
    expect(await screen.findByText('反映中')).toBeInTheDocument();
  });

  it('after failed tests shows their output and offers もう一度', async () => {
    const i = integration({
      id: INT,
      title: '「ログイン」の変更を反映',
      status: 'failed',
      targetRef: 'main',
      steps: [
        step({}),
        step({ index: 1, kind: 'verify', status: 'failed', artifactId: 'art_test' }),
      ],
      error: { code: 'tests_failed', message: 'テストが失敗しました' },
    });
    const { fake } = mountInteg(i, {
      'artifact.get': () => ({
        ...output('test_result'),
        data: {
          command: 'pnpm test',
          passed: false,
          exitCode: 1,
          durationMs: 10,
          summary: '失敗',
          output: 'FAIL login.test.js',
        },
      }),
      'integration.run': () => ({ ...i, status: 'running' }),
    });
    expect(await screen.findByText('テスト失敗')).toBeInTheDocument();
    expect(await screen.findByLabelText('テストの出力')).toHaveTextContent('FAIL login.test.js');
    fireEvent.click(screen.getByRole('button', { name: 'もう一度' }));
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'integration.run')).toBe(true));
  });

  it('names every status with a shape and a noun phrase', () => {
    const at = (status: Integration['status'], over: Partial<Integration> = {}) =>
      integration({ status, ...over });
    expect(
      [
        at('pending'),
        at('verifying'),
        at('awaiting_approval'),
        at('conflict'),
        at('applied'),
        at('cancelled'),
      ].map(integrationShape),
    ).toEqual(['queued', 'working', 'review', 'failed', 'done', 'stopped']);
    expect(integrationLabel(at('failed', { error: { code: 'apply_failed', message: '' } }))).toBe(
      '反映できません',
    );
    expect(
      integrationLabel(at('running', { steps: [step({ kind: 'fix', status: 'running' })] })),
    ).toBe('競合を解消中');
  });
});
