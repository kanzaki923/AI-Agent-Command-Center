import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { normalizeInspection } from '../../model/repo';
import { createFakeClient } from '../../test/fakeClient';
import { TooltipProvider } from '../ui/Tooltip';
import { NewProjectForm } from './ProjectDialog';

const PROJECT = {
  id: 'prj_00000000000000000000000001',
  name: 'acme',
  description: null,
  repoPath: 'C:\\work\\acme',
  defaultBranch: 'main',
  defaultModel: null,
  testCommand: 'pnpm test',
  commitAuthor: null,
  archivedAt: null,
  createdAt: '2026-10-29T05:00:00.000Z',
  updatedAt: '2026-10-29T05:00:00.000Z',
};

function mount(handlers: Parameters<typeof createFakeClient>[0]) {
  const fake = createFakeClient(handlers);
  const rt = createRuntime(fake.client);
  const onDone = vi.fn();
  render(
    <RuntimeProvider runtime={rt}>
      <TooltipProvider>
        <NewProjectForm onDone={onDone} />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return { fake, onDone };
}

describe('normalizeInspection', () => {
  it('reads the shapes a daemon may answer with', () => {
    expect(
      normalizeInspection({ isRepo: true, root: 'C:\\r', currentBranch: 'main', uncommittedFiles: ['a', 'b'], testCommand: 'pnpm test' }),
    ).toMatchObject({ isRepo: true, root: 'C:\\r', branch: 'main', dirty: 2, testCommand: 'pnpm test', error: null });
    expect(normalizeInspection({ git: { root: '/r', branch: 'dev', dirty: true } })).toMatchObject({
      isRepo: true,
      branch: 'dev',
      dirty: true,
    });
    expect(normalizeInspection({ isRepo: false, reason: 'not a git repository' })).toMatchObject({
      isRepo: false,
      error: 'not a git repository',
    });
  });
});

describe('<NewProjectForm> with project.inspectRepo', () => {
  it('validates the folder first, prefills what it found and warns about a dirty tree', async () => {
    let created: unknown = null;
    const { fake } = mount({
      'system.info': () => ({ methods: ['project.inspectRepo', 'project.create'], stats: { lastEventSeq: 0 } }),
      'project.inspectRepo': () => ({
        isRepo: true,
        root: 'C:\\work\\acme',
        name: 'acme',
        currentBranch: 'main',
        uncommittedFiles: 3,
        testCommand: 'pnpm test',
      }),
      'project.create': (p) => {
        created = p;
        return PROJECT;
      },
      'workspace.create': () => ({ branch: 'main' }),
    });
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'system.info')).toBe(true));
    const input = screen.getByLabelText('Git リポジトリのフォルダ');
    // Let the method probe land before typing.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    fireEvent.change(input, { target: { value: 'C:\\work\\acme' } });
    expect(await screen.findByText('git リポジトリ', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByTestId('dirty-warning')).toHaveTextContent('未コミットの変更が 3 件あります');
    expect(screen.getByLabelText('テストコマンド')).toHaveValue('pnpm test');
    expect(screen.getByLabelText('既定ブランチ')).toHaveAttribute('placeholder', 'main（検出）');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'プロジェクトを追加' }));
    });
    await waitFor(() => expect(created).toMatchObject({ name: 'acme', repoPath: 'C:\\work\\acme', testCommand: 'pnpm test' }));
  });

  it('blocks a folder that is not a repository before creating anything', async () => {
    const { fake } = mount({
      'system.info': () => ({ methods: ['project.inspectRepo'], stats: { lastEventSeq: 0 } }),
      'project.inspectRepo': () => ({ isRepo: false, reason: 'git リポジトリではありません' }),
    });
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'system.info')).toBe(true));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    fireEvent.change(screen.getByLabelText('Git リポジトリのフォルダ'), { target: { value: 'C:\\tmp' } });
    expect(await screen.findByText('git リポジトリではありません', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'プロジェクトを追加' })).toBeDisabled();
    expect(fake.calls.some((c) => c.method === 'project.create')).toBe(false);
  });

  it('falls back to validating on create when the daemon cannot inspect', async () => {
    const { fake } = mount({
      'system.info': () => ({ methods: ['project.create'], stats: { lastEventSeq: 0 } }),
    });
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'system.info')).toBe(true));
    fireEvent.change(screen.getByLabelText('Git リポジトリのフォルダ'), { target: { value: 'C:\\work\\acme' } });
    await new Promise((r) => setTimeout(r, 450));
    expect(fake.calls.some((c) => c.method === 'project.inspectRepo')).toBe(false);
    expect(screen.getByText('リポジトリのルート（.git があるフォルダ）を絶対パスで指定します。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'プロジェクトを追加' })).toBeEnabled();
  });
});
