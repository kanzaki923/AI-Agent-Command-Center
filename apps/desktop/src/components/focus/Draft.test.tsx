import type { Project } from '@acc/protocol';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { iso, session, T0 } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { DRAFT_KEY, Draft, defaultPlace, workspaceFor } from './Draft';

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

describe('defaultPlace', () => {
  it('starts in the project: its code, else its folder', () => {
    expect(defaultPlace(null)).toBe('none');
    expect(defaultPlace(project())).toBe('worktree');
    expect(defaultPlace(project({ folderPath: 'C:/work/acme-web' }))).toBe('worktree');
    expect(defaultPlace(project({ repoPath: null, folderPath: 'C:/docs' }))).toBe('folder');
    expect(defaultPlace(project({ repoPath: null }))).toBe('none');
  });
});

describe('<Draft> (Ctrl+N)', () => {
  beforeEach(() => useUi.setState({ mode: 'session', focusSessionId: null, projectId: null, drafts: {}, onboardingDone: true }));

  function mount(projects: Project[]) {
    const created = session({ kind: 'agent', title: 'ログイン画面を直して' });
    const fake = createFakeClient({
      'project.list': () => ({ items: projects, nextCursor: null }),
      'assistant.startWork': () => ({ session: created }),
      'session.messages': () => ({ items: [], hasMore: false, streaming: null }),
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

  it('starts a conversation of its own in the chosen project and place, and opens it (never the assistant)', async () => {
    const p = project();
    useUi.setState({ projectId: p.id });
    const { fake, created } = mount([p]);
    const input = screen.getByRole('textbox', { name: 'メッセージ' });
    expect(screen.queryByRole('button', { name: '試してみる' })).toBeNull();
    const code = await screen.findByRole('radio', { name: 'コード' });
    expect(screen.getByTestId('draft-project')).toHaveTextContent('acme-web');
    // The project has code but no folder.
    expect(screen.getByRole('radio', { name: 'フォルダ' })).toBeDisabled();
    fireEvent.click(code);
    expect(code).toHaveAttribute('aria-checked', 'true');

    fireEvent.change(input, { target: { value: 'ログイン画面を直して' } });
    expect(useUi.getState().drafts[DRAFT_KEY]).toBe('ログイン画面を直して');
    // Shift+Enter is a newline, as in any conversation.
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(fake.calls.some((c) => c.method === 'assistant.startWork')).toBe(false);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(useUi.getState().focusSessionId).toBe(created.id));
    expect(fake.calls.find((c) => c.method === 'assistant.startWork')?.params).toEqual({
      text: 'ログイン画面を直して',
      delegate: false,
      projectId: p.id,
      workspace: { kind: 'worktree', projectId: p.id },
    });
    expect(fake.calls.map((c) => c.method)).not.toContain('system.assistant');
    expect(fake.calls.map((c) => c.method)).not.toContain('session.send');
    expect(useUi.getState().drafts[DRAFT_KEY]).toBeUndefined();
  });

  it('works in the project without a pick, and keeps 作業場所なし once chosen', async () => {
    const p = project();
    useUi.setState({ projectId: p.id });
    const { fake } = mount([p]);
    const code = await screen.findByRole('radio', { name: 'コード' });
    expect(code).toHaveAttribute('aria-checked', 'true');
    const none = screen.getByRole('radio', { name: '作業場所なし' });
    fireEvent.click(none);
    expect(none).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(screen.getByRole('textbox', { name: 'メッセージ' }), {
      target: { value: 'ちょっと相談' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'メッセージ' }), { key: 'Enter' });
    await waitFor(() =>
      expect(fake.calls.find((c) => c.method === 'assistant.startWork')?.params).toEqual({
        text: 'ちょっと相談',
        delegate: false,
        projectId: p.id,
      }),
    );
  });

  it('is only the input, the model and send when there is no project', async () => {
    const { fake } = mount([]);
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'project.list')).toBe(true));
    expect(screen.queryByRole('radiogroup', { name: '作業場所' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('draft-project')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '送信' })).toBeInTheDocument();
  });
});
