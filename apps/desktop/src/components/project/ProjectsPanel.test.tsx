import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { TooltipProvider } from '../ui/Tooltip';
import { ProjectsPanel } from './ProjectsPanel';

/** The tab as the settings mount it: its screen lives in the UI store. */
function Tab() {
  const view = useUi((s) => s.projectsView);
  const setView = useUi((s) => s.setProjectsView);
  return <ProjectsPanel view={view} onView={setView} />;
}

const BASE = {
  description: null,
  defaultModel: null,
  commitAuthor: null,
  permissionProfile: null,
  archivedAt: null,
  createdAt: '2026-10-29T05:00:00.000Z',
  updatedAt: '2026-10-29T05:00:00.000Z',
};
const CODE = {
  ...BASE,
  id: 'prj_00000000000000000000000001',
  name: 'acme',
  repoPath: 'C:\\work\\acme',
  folderPath: null,
  defaultBranch: 'main',
  testCommand: 'pnpm test',
};
const FOLDER = {
  ...BASE,
  id: 'prj_00000000000000000000000002',
  name: 'notes',
  repoPath: null,
  folderPath: 'C:\\docs\\notes',
  defaultBranch: null,
  testCommand: null,
};

function mount() {
  const updates: unknown[] = [];
  const fake = createFakeClient({
    'project.list': () => ({ items: [CODE, FOLDER] }),
    'settings.get': () => ({ defaultPermissionProfile: 'autonomous' }),
    'permissionRule.list': () => ({ items: [] }),
    'project.update': (p) => {
      updates.push(p);
      return { ...CODE, ...(p as object) };
    },
  });
  render(
    <RuntimeProvider runtime={createRuntime(fake.client)}>
      <TooltipProvider>
        <Tab />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return { updates };
}

beforeEach(() => {
  useUi.setState({ settingsOpen: false, settingsTab: 'general', projectsView: { kind: 'list' } });
});

describe('the projects tab of the settings', () => {
  it('lists every project with where it lives, code with its default branch', async () => {
    act(() => useUi.getState().openProjects());
    mount();
    expect(useUi.getState()).toMatchObject({ settingsOpen: true, settingsTab: 'projects' });
    const code = await screen.findByRole('button', { name: 'acme の設定' });
    expect(code).toHaveTextContent('C:\\work\\acme');
    expect(code).toHaveTextContent('main');
    expect(screen.getByRole('button', { name: 'notes の設定' })).toHaveTextContent('C:\\docs\\notes');
  });

  it("changes a code project's default branch, then goes back to the list", async () => {
    act(() => useUi.getState().openProjects());
    const { updates } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'acme の設定' }));
    const branch = screen.getByLabelText('既定ブランチ');
    fireEvent.change(branch, { target: { value: 'develop' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
    });
    expect(updates).toContainEqual({ projectId: CODE.id, defaultBranch: 'develop' });
    expect(await screen.findByTestId('projects-panel')).toBeInTheDocument();
  });

  it('shows a folder project without branch or test command', async () => {
    act(() => useUi.getState().openProjects(FOLDER.id));
    mount();
    expect(await screen.findByText('C:\\docs\\notes')).toBeInTheDocument();
    expect(screen.getByLabelText('名前')).toHaveValue('notes');
    expect(screen.queryByLabelText('既定ブランチ')).toBeNull();
    expect(screen.queryByLabelText('テストコマンド')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'notes' }));
    await waitFor(() => expect(screen.getByTestId('projects-panel')).toBeInTheDocument());
  });

  it('adds a project from the tab and comes back to the list when cancelled', async () => {
    act(() => useUi.getState().openProjects());
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'プロジェクトを追加' }));
    expect(screen.getByLabelText('フォルダ')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(await screen.findByTestId('projects-panel')).toBeInTheDocument();
  });

  it('opens on the list again when the tab is switched away and back', () => {
    act(() => useUi.getState().openProjects(CODE.id));
    expect(useUi.getState().projectsView).toEqual({ kind: 'edit', projectId: CODE.id });
    act(() => useUi.getState().setSettingsTab('general'));
    act(() => useUi.getState().setSettingsTab('projects'));
    expect(useUi.getState().projectsView).toEqual({ kind: 'list' });
  });
});
