import type { CapabilityGrant, Session } from '@acc/protocol';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { T0, event, iso, session } from '../../test/fixtures';
import { Composer } from '../focus/Composer';
import { TooltipProvider } from '../ui/Tooltip';
import { GrantChip, GrantDialog } from './Grant';

const project = {
  id: 'prj_00000000000000000000000001',
  name: 'acme-web',
  description: null,
  repoPath: 'C:\\work\\acme-web',
  defaultBranch: 'main',
  defaultModel: null,
  testCommand: 'pnpm test',
  commitAuthor: null,
  createdAt: iso(T0),
  updatedAt: iso(T0),
  archivedAt: null,
};

function mount(s: Session, extra: Parameters<typeof createFakeClient>[0] = {}) {
  let granted: Record<string, unknown> | null = null;
  const fake = createFakeClient({
    'session.list': () => ({ items: [s], nextCursor: null }),
    'project.list': () => ({ items: [project] }),
    'settings.get': () => ({
      litellm: { baseUrl: null, hasApiKey: false, apiKeyMasked: null },
      defaultModel: null,
      defaultRuntime: null,
      maxConcurrentRuns: 10,
      maxDelegationDepth: 1,
    }),
    'models.list': () => ({ models: [], source: 'mock' }),
    'system.info': () => ({
      methods: ['grant.create', 'budget.allocate'],
      stats: { lastEventSeq: 0 },
    }),
    'grant.list': () => ({ items: [] }),
    'events.list': () => ({ events: [], lastSeq: 0, hasMore: false }),
    'grant.create': (p) => {
      granted = p;
      return {
        id: 'grt_00000000000000000000000001',
        subject: p.subject,
        parentGrantId: null,
        permissions: p.permissions,
        scope: p.scope,
        limits: p.limits,
        depth: 0,
        lifetime: p.lifetime,
        expiresAt: p.expiresAt ?? null,
        revokedAt: null,
        reason: null,
        grantedBy: { kind: 'human', client: 'desktop' },
        createdAt: iso(T0 + 1000),
      };
    },
    'budget.allocate': (p) => ({
      id: 'bud_1',
      parentId: null,
      subject: p.subject,
      status: 'active',
      limitUsd: p.limitUsd,
      allocatedUsd: 0,
      reservedUsd: 0,
      spentUsd: 0,
      createdAt: iso(T0),
      updatedAt: iso(T0),
      releasedAt: null,
      createdBy: { kind: 'human', client: 'desktop' },
    }),
    'grant.revoke': () => ({}),
    ...extra,
  });
  const rt = createRuntime(fake.client);
  render(
    <RuntimeProvider runtime={rt}>
      <TooltipProvider>
        <Composer session={s} activeRun={null} onSent={() => {}} />
        {/* The conversation's composer no longer carries the chip (ui-redesign §5): render it alone. */}
        <GrantChip session={s} />
        <GrantDialog />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return { fake, rt, granted: () => granted };
}

describe('Orchestrator grant (権限を与えるだけで Orchestrator になる)', () => {
  beforeEach(() => {
    useUi.setState({ grantDialogSessionId: null, projectId: null, suggestions: {}, drafts: {} });
  });

  it('grants from the composer chip in a few clicks and shows the result as a chip', async () => {
    const s = session({ kind: 'chat', title: '設計チャット', projectId: project.id });
    const { granted } = mount(s);
    fireEvent.click(await screen.findByRole('button', { name: /Orchestrator 権限: なし/ }));
    const dialog = await screen.findByRole('dialog', {
      name: 'このチャットを Orchestrator にする',
    });
    // The sentence says exactly what will be allowed.
    expect(within(dialog).getByTestId('grant-sentence')).toHaveTextContent(
      'このチャットは「acme-web」で Task を分け、Worker を 2 人まで並列に起動できます。Worker に配れる予算は $5.00 です。次の実行が終わると自動で失効します。',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: '増やす' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'このセッション' }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '権限を与える' }));
    });
    await waitFor(() => expect(granted()).not.toBeNull());
    expect(granted()).toMatchObject({
      subject: { kind: 'session', sessionId: s.id },
      scope: { projectIds: [project.id] },
      limits: { maxWorkers: 3, maxDepth: 1 },
      lifetime: 'session',
    });
    const chip = await screen.findByTestId('grant-chip');
    expect(chip).toHaveTextContent('Orchestrator');
    expect(chip).toHaveTextContent('Worker 3');
  });

  it('revokes from the chip, and a live grant.revoked removes it too', async () => {
    const s = session({ kind: 'chat' });
    const g: CapabilityGrant = {
      id: 'grt_00000000000000000000000009',
      subject: { kind: 'session', sessionId: s.id },
      parentGrantId: null,
      permissions: ['task.*', 'session.create', 'session.send'],
      scope: {},
      limits: { maxWorkers: 2, maxDepth: 1 },
      depth: 0,
      lifetime: 'run',
      expiresAt: null,
      revokedAt: null,
      reason: null,
      grantedBy: { kind: 'human', client: 'desktop' },
      createdAt: iso(T0),
    };
    const { fake } = mount(s, { 'grant.list': () => ({ items: [g] }) });
    expect(await screen.findByTestId('grant-chip')).toHaveTextContent('この実行のみ');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Orchestrator 権限を取り消す' }));
    });
    await waitFor(() => expect(screen.queryByTestId('grant-chip')).not.toBeInTheDocument());
    expect(fake.calls.some((c) => c.method === 'grant.revoke')).toBe(true);
    expect(screen.getByRole('button', { name: /Orchestrator 権限: なし/ })).toBeInTheDocument();
    // Run-lifetime grants also end on their own (daemon event).
    act(() => fake.emit(event('grant.revoked', { grantId: g.id, reason: 'run ended' })));
  });

  it('sends the suggested first message with one click', async () => {
    const s = session({ kind: 'chat' });
    useUi.setState({ suggestions: { [s.id]: '認証まわりのドキュメントとテストを並列で整備して' } });
    let sent: Record<string, unknown> | null = null;
    mount(s, {
      'session.send': (p) => {
        sent = p;
        return { messageId: 'msg_1', runId: 'run_1' };
      },
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('suggestion-chip'));
    });
    expect(sent).toEqual({
      sessionId: s.id,
      content: '認証まわりのドキュメントとテストを並列で整備して',
    });
    expect(useUi.getState().suggestions[s.id]).toBeUndefined();
    expect(screen.queryByTestId('suggestion-chip')).not.toBeInTheDocument();
  });
});
