import type { CapabilityGrant, Project, Session, SessionCard } from '@acc/protocol';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { createFakeClient } from '../../test/fakeClient';
import { T0, card, homeSnapshot, homeTree, iso, session } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { DelegateButton, grantWorkspace, supervisorGrant, workspaceOptions } from './DelegateButton';

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'prj_00000000000000000000000001',
    name: '市場レポート',
    description: null,
    repoPath: null,
    folderPath: '/work/market',
    defaultBranch: 'main',
    defaultModel: null,
    testCommand: null,
    commitAuthor: null,
    createdAt: iso(T0),
    updatedAt: iso(T0),
    archivedAt: null,
    ...over,
  } as Project;
}

function grant(s: Session, over: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    id: 'grt_00000000000000000000000001',
    subject: { kind: 'session', sessionId: s.id },
    parentGrantId: null,
    permissions: ['session.spawn', 'session.send'],
    scope: {},
    limits: { maxChildren: 4, maxDepth: 1 },
    depth: 0,
    lifetime: 'session',
    expiresAt: null,
    revokedAt: null,
    reason: 'supervisor',
    grantedBy: { kind: 'human', client: 'desktop' },
    createdAt: iso(T0),
    ...over,
  };
}

function mount(opts: { s: Session; self: SessionCard; grants?: CapabilityGrant[]; projects?: Project[]; treeUsd?: number }) {
  const fake = createFakeClient({
    'home.get': () =>
      homeSnapshot({
        trees: [homeTree(opts.self, [], { spend: { treeUsd: opts.treeUsd ?? 0, limitUsd: null, estimated: false } })],
      }),
    'session.tree': () => ({ rootSessionId: opts.s.id, nodes: [opts.self] }),
    'grant.list': () => ({ items: opts.grants ?? [] }),
    'session.list': () => ({ items: [opts.s], nextCursor: null }),
    'project.list': () => ({ items: opts.projects ?? [] }),
    'session.delegate': (p) => ({ grant: grant(opts.s, { limits: { maxChildren: p.maxChildren as number } }), budget: null }),
    'session.undelegate': () => ({ revoked: [] }),
    'session.setBudget': () => ({ budget: null }),
  });
  render(
    <RuntimeProvider runtime={createRuntime(fake.client)}>
      <TooltipProvider>
        <DelegateButton sessionId={opts.s.id} />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  const calls = (m: string) => fake.calls.filter((c) => c.method === m).map((c) => c.params);
  return { fake, calls };
}

describe('<DelegateButton>', () => {
  it('delegates with one press and the daemon defaults (no dialog)', async () => {
    const s = session({ kind: 'chat' });
    const { calls } = mount({ s, self: card({ id: s.id, role: 'chat', state: 'idle' }) });
    const button = await screen.findByRole('button', { name: '任せる' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(calls('session.delegate')).toEqual([{ sessionId: s.id }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows nothing for an agent (it works itself)', async () => {
    const s = session({ kind: 'agent' });
    const { fake } = mount({ s, self: card({ id: s.id, role: 'agent' }) });
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'session.tree')).toBe(true));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('while delegated: a filled diamond that opens budget, concurrency, workspace and stop', async () => {
    const s = session({ kind: 'chat', projectId: project().id });
    const { calls } = mount({
      s,
      self: card({ id: s.id, role: 'supervisor', state: 'supervising', budget: { limitUsd: 3.4, usedUsd: 2.77 } }),
      grants: [grant(s, { scope: { projectIds: [project().id] } })],
      projects: [project()],
      treeUsd: 2.9,
    });
    const button = await screen.findByRole('button', { name: '任せている' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    await act(async () => {
      fireEvent.click(button);
    });
    const pop = await screen.findByTestId('delegate-popover');
    await waitFor(() => expect(within(pop).getByLabelText('予算')).toHaveValue('3.40'));
    // The budget covers the tree: what the tree spent, not only the conversation itself.
    await waitFor(() => expect(within(pop).getByTestId('delegate-used')).toHaveTextContent('$2.90'));
    expect(within(pop).getByRole('group', { name: '同時に動かす数' })).toHaveTextContent('4');
    // A folder project: なし and フォルダ can be chosen, コード cannot.
    const ws = within(pop).getByRole('radiogroup', { name: '作業場所' });
    await waitFor(() => expect(within(ws).getByRole('radio', { name: 'フォルダ' })).toHaveAttribute('aria-checked', 'true'));
    expect(within(ws).getByRole('radio', { name: 'コード' })).toBeDisabled();

    await act(async () => {
      fireEvent.click(within(pop).getByRole('button', { name: '増やす' }));
    });
    expect(calls('session.delegate').at(-1)).toEqual({ sessionId: s.id, maxChildren: 5, projectId: project().id });

    await act(async () => {
      fireEvent.click(within(ws).getByRole('radio', { name: 'なし' }));
    });
    expect(calls('session.delegate').at(-1)).toEqual({ sessionId: s.id, maxChildren: 4, projectId: null });

    const budget = within(pop).getByLabelText('予算');
    fireEvent.change(budget, { target: { value: '5' } });
    await act(async () => {
      fireEvent.keyDown(budget, { key: 'Enter' });
    });
    expect(calls('session.setBudget')).toEqual([{ sessionId: s.id, limitUsd: 5 }]);

    await act(async () => {
      fireEvent.click(within(pop).getByRole('button', { name: '任せるのをやめる' }));
    });
    expect(calls('session.undelegate')).toEqual([{ sessionId: s.id }]);
    await waitFor(() => expect(screen.queryByTestId('delegate-popover')).toBeNull());
  });
});

describe('delegation helpers', () => {
  it('finds the active supervisor grant (not revoked, not expired, may start children)', () => {
    const s = session({ kind: 'chat' });
    const old = grant(s, { revokedAt: iso(T0) });
    const other = grant(s, { id: 'grt_00000000000000000000000002', permissions: ['session.get'] });
    const expired = grant(s, { id: 'grt_00000000000000000000000003', expiresAt: iso(T0 - 1) });
    const live = grant(s, { id: 'grt_00000000000000000000000004' });
    expect(supervisorGrant([live, old, other, expired], T0)?.id).toBe(live.id);
    expect(supervisorGrant([old, other, expired], T0)).toBeNull();
    expect(supervisorGrant(undefined, T0)).toBeNull();
  });

  it('reads where the children may work from the project the grant is limited to', () => {
    const s = session({ kind: 'chat' });
    const code = project({ repoPath: '/work/web', folderPath: null });
    expect(grantWorkspace(grant(s, { scope: { projectIds: [code.id] } }), code)).toBe('worktree');
    expect(grantWorkspace(grant(s, { scope: { projectIds: [project().id] } }), project())).toBe('folder');
    expect(grantWorkspace(grant(s), project())).toBe('none');
    expect(grantWorkspace(null, null)).toBe('none');
    expect(workspaceOptions(null).filter((o) => !o.disabled).map((o) => o.value)).toEqual(['none']);
    expect(workspaceOptions(code).filter((o) => !o.disabled).map((o) => o.value)).toEqual(['none', 'worktree']);
  });
});
