import type { FolderInspection, RepoInspection } from '@acc/protocol';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { branchText, dirtyText, failedFolder, projectKindOf } from '../../model/repo';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { TooltipProvider } from '../ui/Tooltip';
import { NewProjectForm, ProjectDialog } from './ProjectDialog';

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

/** A `project.inspectRepo` result exactly as the daemon answers (protocol RepoInspection). */
const repoOk = (over: Partial<RepoInspection> = {}): RepoInspection => ({
  ok: true,
  reason: null,
  repoRoot: 'C:\\work\\acme',
  defaultBranch: 'main',
  currentBranch: 'main',
  isDirty: false,
  suggestedName: 'acme',
  suggestedTestCommand: 'pnpm test',
  existingProjectId: null,
  ...over,
});

/** A `project.inspectFolder` result for the root of the acme repository. */
const folderOk = (over: Partial<FolderInspection> = {}): FolderInspection => ({
  ok: true,
  reason: null,
  path: 'C:\\work\\acme',
  isGitRepo: true,
  repoRoot: 'C:\\work\\acme',
  defaultBranch: 'main',
  suggestedName: 'acme',
  suggestedTestCommand: 'pnpm test',
  existingProjectId: null,
  ...over,
});

/** An ordinary folder with no git. */
const plainFolder = (path = 'C:\\docs\\notes'): FolderInspection =>
  folderOk({
    path,
    isGitRepo: false,
    repoRoot: null,
    defaultBranch: null,
    suggestedName: 'notes',
    suggestedTestCommand: null,
  });

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

const typePath = (value: string) =>
  fireEvent.change(screen.getByLabelText('フォルダ'), { target: { value } });

const kindLine = () => document.querySelector('[data-project-kind]');

beforeEach(() => {
  useUi.setState({ projectId: null });
});

describe('repo inspection helpers', () => {
  it('words branches and the dirty tree', () => {
    expect(branchText(repoOk())).toBe('main');
    expect(branchText(repoOk({ currentBranch: 'feature-x' }))).toBe('feature-x（既定は main）');
    expect(branchText(repoOk({ currentBranch: null, defaultBranch: 'trunk' }))).toBe('trunk');
    expect(dirtyText(true)).toBe('未コミットの変更があります');
    expect(dirtyText(false)).toBeNull();
    expect(dirtyText(null)).toBeNull();
  });

  it('makes the root of a repository code and any other folder a folder', () => {
    expect(projectKindOf(folderOk())).toBe('code');
    expect(projectKindOf(folderOk({ path: 'c:\\work\\acme\\' }))).toBe('code');
    expect(projectKindOf(folderOk({ path: 'C:\\work\\acme\\docs' }))).toBe('folder');
    expect(projectKindOf(plainFolder())).toBe('folder');
    expect(failedFolder('見つかりません')).toMatchObject({ ok: false, reason: '見つかりません', path: null });
  });
});

describe('<NewProjectForm> with project.inspectFolder', () => {
  it('adds the root of a repository as code, prefilled, and warns about a dirty tree', async () => {
    let created: unknown = null;
    const { fake } = mount({
      'project.inspectFolder': () => folderOk(),
      'project.inspectRepo': () => repoOk({ isDirty: true, defaultBranch: 'main', currentBranch: 'feature-x' }),
      'project.create': (p) => {
        created = p;
        return PROJECT;
      },
      'workspace.create': () => ({ branch: 'feature-x' }),
    });
    typePath('C:\\work\\acme');
    await waitFor(() => expect(kindLine()).toHaveAttribute('data-project-kind', 'code'), { timeout: 2000 });
    // Exactly the contract's params: no guessing of alternative names.
    expect(fake.calls.filter((c) => c.method === 'project.inspectFolder').map((c) => c.params)).toEqual([
      { path: 'C:\\work\\acme' },
    ]);
    expect(kindLine()).toHaveTextContent('コード');
    expect(screen.getByText('feature-x（既定は main）')).toBeInTheDocument();
    expect(screen.getByTestId('dirty-warning')).toHaveTextContent('未コミットの変更があります');
    expect(screen.getByLabelText('テストコマンド')).toHaveValue('pnpm test');
    expect(screen.getByLabelText('既定ブランチ')).toHaveAttribute('placeholder', 'main（検出）');
    expect(screen.getByLabelText('名前')).toHaveAttribute('placeholder', 'acme');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'プロジェクトを追加' }));
    });
    // The detected default branch (not the checked-out one) becomes the project's.
    await waitFor(() =>
      expect(created).toEqual({
        name: 'acme',
        repoPath: 'C:\\work\\acme',
        defaultBranch: 'main',
        testCommand: 'pnpm test',
      }),
    );
  });

  it('adds an ordinary folder as a folder: no branch, no test command, no checkout', async () => {
    let created: unknown = null;
    const { fake, onDone } = mount({
      'project.inspectFolder': () => plainFolder(),
      'project.create': (p) => {
        created = p;
        return { ...PROJECT, name: 'notes', repoPath: null, folderPath: 'C:\\docs\\notes', defaultBranch: null };
      },
    });
    typePath('C:\\docs\\notes');
    await waitFor(() => expect(kindLine()).toHaveAttribute('data-project-kind', 'folder'), { timeout: 2000 });
    expect(kindLine()).toHaveTextContent('エージェントがこのフォルダを直接書き換えます');
    expect(screen.queryByLabelText('既定ブランチ')).toBeNull();
    expect(screen.queryByLabelText('テストコマンド')).toBeNull();
    expect(fake.calls.some((c) => c.method === 'project.inspectRepo')).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'プロジェクトを追加' }));
    });
    await waitFor(() => expect(created).toEqual({ name: 'notes', folderPath: 'C:\\docs\\notes' }));
    expect(fake.calls.some((c) => c.method === 'workspace.create')).toBe(false);
    expect(onDone).toHaveBeenCalled();
  });

  it('blocks a folder that cannot be used, with the reason, before creating anything', async () => {
    const { fake } = mount({
      'project.inspectFolder': () =>
        failedFolder('アプリのデータフォルダを含む場所は追加できません。その中の作業用のフォルダを指定してください'),
    });
    typePath('C:\\Users\\me');
    expect(
      await screen.findByText(
        'アプリのデータフォルダを含む場所は追加できません。その中の作業用のフォルダを指定してください',
        {},
        { timeout: 2000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'プロジェクトを追加' })).toBeDisabled();
    expect(fake.calls.some((c) => c.method === 'project.create')).toBe(false);
  });

  it('drops what an earlier path filled in when the folder changes', async () => {
    mount({
      'project.inspectFolder': (p) =>
        p.path === 'C:\\work\\acme' ? folderOk() : failedFolder('フォルダが見つかりません'),
      'project.inspectRepo': () => repoOk(),
    });
    typePath('C:\\work\\acme');
    await waitFor(() => expect(screen.getByLabelText('テストコマンド')).toHaveValue('pnpm test'), {
      timeout: 2000,
    });
    typePath('C:\\work\\gone');
    expect(await screen.findByText('フォルダが見つかりません', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.queryByLabelText('テストコマンド')).toBeNull();
    typePath('C:\\work\\acme');
    await waitFor(() => expect(screen.getByLabelText('テストコマンド')).toHaveValue('pnpm test'), {
      timeout: 2000,
    });
  });

  it('takes a folder inside a repository as a folder, and offers the repository as code', async () => {
    const { fake } = mount({
      'project.inspectFolder': (p) =>
        p.path === 'C:\\work\\acme' ? folderOk() : folderOk({ path: p.path as string, suggestedName: 'docs' }),
      'project.inspectRepo': () => repoOk(),
    });
    typePath('C:\\work\\acme\\docs');
    const use = await screen.findByRole(
      'button',
      { name: 'リポジトリ C:\\work\\acme をコードとして追加する' },
      { timeout: 2000 },
    );
    expect(kindLine()).toHaveAttribute('data-project-kind', 'folder');
    expect(screen.getByRole('button', { name: 'プロジェクトを追加' })).toBeEnabled();
    await act(async () => {
      fireEvent.click(use);
    });
    expect(screen.getByLabelText('フォルダ')).toHaveValue('C:\\work\\acme');
    await waitFor(() => expect(kindLine()).toHaveAttribute('data-project-kind', 'code'));
    expect(screen.getByLabelText('既定ブランチ')).toBeInTheDocument();
    expect(fake.calls.filter((c) => c.method === 'project.inspectFolder')).toHaveLength(2);
  });

  it('points at the project that already uses the folder instead of adding it twice', async () => {
    const { fake, onDone } = mount({
      'project.list': () => ({ items: [PROJECT] }),
      'project.inspectFolder': () => folderOk({ existingProjectId: PROJECT.id }),
      'project.inspectRepo': () => repoOk({ existingProjectId: PROJECT.id }),
    });
    typePath('C:\\work\\acme');
    const note = await screen.findByTestId('existing-project', {}, { timeout: 2000 });
    await waitFor(() => expect(note).toHaveTextContent('プロジェクト「acme」として追加されています'));
    expect(screen.getByRole('button', { name: 'プロジェクトを追加' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'このプロジェクトを開く' }));
    expect(useUi.getState().projectId).toBe(PROJECT.id);
    expect(onDone).toHaveBeenCalledWith(PROJECT);
    expect(fake.calls.some((c) => c.method === 'project.create')).toBe(false);
  });

  it('falls back to validating on create when the daemon cannot inspect', async () => {
    const { fake } = mount({});
    typePath('C:\\work\\acme');
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'project.inspectFolder')).toBe(true), {
      timeout: 2000,
    });
    // not_implemented → no verdict: the hint stays and creating is still possible.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText('エクスプローラーの「パスのコピー」を貼り付けられます')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'プロジェクトを追加' })).toBeEnabled();
  });
});

describe('<ProjectDialog> agent permissions', () => {
  const RULE = {
    id: 'prl_00000000000000000000000001',
    projectId: PROJECT.id,
    scope: 'project' as const,
    runId: null,
    taskId: null,
    toolName: 'Bash',
    commandKeys: ['pnpm add'],
    pathPrefix: null,
    description: 'コマンド「pnpm add」を許可',
    approvalId: null,
    createdBy: { kind: 'human' as const, client: 'test' },
    createdAt: '2026-10-29T05:00:00.000Z',
    revokedAt: null,
    revokedBy: null,
  };

  function mountEdit() {
    const calls: { method: string; params: unknown }[] = [];
    const fake = createFakeClient({
      'project.list': () => ({ items: [{ ...PROJECT, permissionProfile: null }], nextCursor: null }),
      'settings.get': () => ({
        litellm: { baseUrl: null, hasApiKey: false, apiKeyMasked: null },
        defaultModel: null,
        defaultRuntime: null,
        maxConcurrentRuns: 10,
        maxDelegationDepth: 1,
        defaultPermissionProfile: 'autonomous',
      }),
      'permissionRule.list': () => ({ items: [RULE] }),
      'permissionRule.revoke': (p) => {
        calls.push({ method: 'permissionRule.revoke', params: p });
        return { ...RULE, revokedAt: '2026-10-29T06:00:00.000Z' };
      },
      'project.update': (p) => {
        calls.push({ method: 'project.update', params: p });
        return { ...PROJECT, permissionProfile: (p as { permissionProfile?: unknown }).permissionProfile ?? null };
      },
    });
    useUi.setState({ projectDialog: { kind: 'edit', projectId: PROJECT.id } });
    render(
      <RuntimeProvider runtime={createRuntime(fake.client)}>
        <TooltipProvider>
          <ProjectDialog />
        </TooltipProvider>
      </RuntimeProvider>,
    );
    return calls;
  }

  it('follows the global default until a profile is chosen, then saves it', async () => {
    const calls = mountEdit();
    const group = await screen.findByRole('radiogroup', { name: 'エージェントの権限' });
    await waitFor(() =>
      expect(group.querySelector('[aria-checked="true"]')).toHaveTextContent('全体の既定に従う（おまかせ）'),
    );
    fireEvent.click(group.querySelector('[data-profile="careful"]')!);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
    });
    expect(calls).toContainEqual({
      method: 'project.update',
      params: { projectId: PROJECT.id, permissionProfile: 'careful' },
    });
  });

  it('lists remembered approvals and takes one back', async () => {
    const calls = mountEdit();
    const list = await screen.findByTestId('remembered-rules');
    expect(list).toHaveTextContent('コマンド「pnpm add」を許可');
    expect(list).toHaveTextContent('プロジェクト全体');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '「コマンド「pnpm add」を許可」を取り消す' }));
    });
    expect(calls).toContainEqual({ method: 'permissionRule.revoke', params: { ruleId: RULE.id } });
    await waitFor(() => expect(screen.getByTestId('no-remembered-rules')).toBeInTheDocument());
  });
});
