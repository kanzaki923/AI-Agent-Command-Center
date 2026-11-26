import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { qk } from '../../daemon/keys';
import { useConfirm } from '../../store/confirm';
import { useToasts } from '../../store/toast';
import { useUi } from '../../store/ui';
import { session } from '../../test/fixtures';
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

function mount(extra: Parameters<typeof createFakeClient>[0] = {}) {
  const updates: unknown[] = [];
  const fake = createFakeClient({
    'project.list': () => ({ items: [CODE, FOLDER] }),
    'session.list': () => ({ items: [], nextCursor: null }),
    'schedule.list': () => ({ items: [] }),
    'settings.get': () => ({ defaultPermissionProfile: 'autonomous' }),
    'permissionRule.list': () => ({ items: [] }),
    'project.update': (p) => {
      updates.push(p);
      return { ...CODE, ...(p as object) };
    },
    ...extra,
  });
  const rt = createRuntime(fake.client);
  render(
    <RuntimeProvider runtime={rt}>
      <TooltipProvider>
        <Tab />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return { updates, rt };
}

beforeEach(() => {
  useUi.setState({ settingsOpen: false, settingsTab: 'general', projectsView: { kind: 'list' } });
  useConfirm.setState({ request: null });
  useToasts.setState({ toasts: [] });
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

  it('removes a project at once when nothing would stop, with an undo, and forgets it as the current one', async () => {
    act(() => {
      useUi.getState().openProjects(FOLDER.id);
      useUi.getState().setProject(FOLDER.id);
    });
    const { updates } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'プロジェクトを外す' }));
    await waitFor(() => expect(updates).toContainEqual({ projectId: FOLDER.id, archived: true }));
    expect(useConfirm.getState().request).toBeNull();
    expect(useUi.getState().projectsView).toEqual({ kind: 'list' });
    expect(useUi.getState().projectId).toBeNull();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'notes の設定' })).toBeNull());
    const toast = useToasts.getState().toasts.at(-1)!;
    expect(toast.title).toBe('プロジェクト「notes」を外しました');
    await act(async () => {
      toast.action!.run();
    });
    await waitFor(() => expect(updates).toContainEqual({ projectId: FOLDER.id, archived: false }));
  });

  it('asks first when removing would stop work or turn repeats off', async () => {
    const busy = session({ projectId: CODE.id, state: 'working' });
    act(() => useUi.getState().openProjects(CODE.id));
    const { updates, rt } = mount({
      'schedule.list': () => ({ items: [{ id: 'sch_1', sessionId: busy.id, enabled: true }] }),
    });
    rt.queryClient.setQueryData(qk.sessions, [busy]);
    fireEvent.click(await screen.findByRole('button', { name: 'プロジェクトを外す' }));
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    const ask = useConfirm.getState().request!;
    expect(ask.body).toContain('動いている作業は止まります。繰り返し 1 件はオフになります。');
    expect(ask.confirmLabel).toBe('止めて外す');
    expect(updates).toEqual([]);
    await act(async () => {
      ask.onConfirm();
    });
    await waitFor(() => expect(updates).toContainEqual({ projectId: CODE.id, archived: true }));
  });

  it('opens on the list again when the tab is switched away and back', () => {
    act(() => useUi.getState().openProjects(CODE.id));
    expect(useUi.getState().projectsView).toEqual({ kind: 'edit', projectId: CODE.id });
    act(() => useUi.getState().setSettingsTab('general'));
    act(() => useUi.getState().setSettingsTab('projects'));
    expect(useUi.getState().projectsView).toEqual({ kind: 'list' });
  });
});
