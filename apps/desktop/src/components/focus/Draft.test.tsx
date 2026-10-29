import type { Project } from '@acc/protocol';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { iso, session, T0 } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { DRAFT_KEY, Draft, workspaceFor } from './Draft';

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'prj_00000000000000000000000001',
    name: 'acme-web',
    description: null,
    repoPath: 'C:/work/acme-web',
    folderPath: null,
    defaultBranch: 'main',
    defaultModel: null,
    testCommand: null,
    commitAuthor: null,
    permissionProfile: null,
    createdAt: iso(T0),
    updatedAt: iso(T0),
    archivedAt: null,
    ...over,
  };
}

describe('workspaceFor', () => {
  it('offers a folder or the code only when the project has one', () => {
    const code = project();
    const docs = project({ repoPath: null, folderPath: 'C:/docs' });
    expect(workspaceFor('none', null)).toEqual({ kind: 'none' });
    expect(workspaceFor('worktree', null)).toBeNull();
    expect(workspaceFor('worktree', code)).toEqual({ kind: 'worktree', projectId: code.id });
    expect(workspaceFor('folder', code)).toBeNull();
    expect(workspaceFor('folder', docs)).toEqual({ kind: 'folder', path: 'C:/docs' });
  });
});

describe('<Draft> (Ctrl+N)', () => {
  beforeEach(() => useUi.setState({ mode: 'session', focusSessionId: null, projectId: null, drafts: {} }));

  function mount(projects: Project[]) {
    const created = session({ kind: 'agent', title: '' });
    const fake = createFakeClient({
      'project.list': () => ({ items: projects, nextCursor: null }),
      'session.create': () => created,
      'session.messages': () => ({ items: [], hasMore: false, streaming: null }),
      'session.send': () => ({ messageId: 'msg_00000000000000000000000001', runId: null, delivery: 'started' }),
    });
    render(
      <RuntimeProvider runtime={createRuntime(fake.client)}>
        <TooltipProvider>
          <Draft />
        </TooltipProvider>
      </RuntimeProvider>,
    );
    return { fake, created };
  }

  it('creates nothing until the first send, then creates in the chosen project and place and opens it', async () => {
    const p = project();
    useUi.setState({ projectId: p.id });
    const { fake, created } = mount([p]);
    const input = screen.getByRole('textbox', { name: '何を頼みますか' });
    expect(await screen.findByTestId('draft-project')).toHaveTextContent('acme-web');
    // The project has code but no folder.
    expect(screen.getByRole('radio', { name: 'フォルダ' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'コード' }));
    expect(screen.getByRole('radio', { name: 'コード' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.change(input, { target: { value: 'ログイン画面を直して' } });
    expect(fake.calls.some((c) => c.method === 'session.create')).toBe(false);
    expect(useUi.getState().drafts[DRAFT_KEY]).toBe('ログイン画面を直して');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(useUi.getState().focusSessionId).toBe(created.id));
    expect(fake.calls.find((c) => c.method === 'session.create')?.params).toMatchObject({
      kind: 'agent',
      projectId: p.id,
      workspace: { kind: 'worktree', projectId: p.id },
    });
    expect(fake.calls.find((c) => c.method === 'session.send')?.params).toMatchObject({ content: 'ログイン画面を直して' });
    expect(useUi.getState().drafts[DRAFT_KEY]).toBeUndefined();
  });

  it('is only the input when there is no project', async () => {
    const { fake } = mount([]);
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'project.list')).toBe(true));
    expect(screen.queryByTestId('draft-project')).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: '作業場所' })).not.toBeInTheDocument();
  });
});
