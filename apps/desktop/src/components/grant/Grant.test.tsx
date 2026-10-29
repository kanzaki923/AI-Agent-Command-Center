import type { CapabilityGrant, Session } from '@acc/protocol';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { T0, iso, session } from '../../test/fixtures';
import { Composer } from '../focus/Composer';
import { TooltipProvider } from '../ui/Tooltip';
import { GrantLine, isReplacement } from './Grant';

function grant(s: Session, over: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    id: 'grt_00000000000000000000000009',
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

function mount(ui: ReactNode, handlers: Parameters<typeof createFakeClient>[0] = {}) {
  const fake = createFakeClient({
    'session.list': () => ({ items: [], nextCursor: null }),
    'project.list': () => ({ items: [] }),
    'settings.get': () => ({
      litellm: { baseUrl: null, hasApiKey: false, apiKeyMasked: null },
      defaultModel: null,
      defaultRuntime: null,
      maxConcurrentRuns: 10,
      maxDelegationDepth: 1,
    }),
    'models.list': () => ({ models: [], source: 'mock' }),
    'system.info': () => ({ methods: [], stats: { lastEventSeq: 0 } }),
    'grant.list': () => ({ items: [] }),
    'events.list': () => ({ events: [], lastSeq: 0, hasMore: false }),
    ...handlers,
  });
  render(
    <RuntimeProvider runtime={createRuntime(fake.client)}>
      <TooltipProvider>{ui}</TooltipProvider>
    </RuntimeProvider>,
  );
  return fake;
}

describe('the old grant dialog is gone', () => {
  beforeEach(() => {
    useUi.setState({ projectId: null, suggestions: {}, drafts: {} });
  });

  it('shows no grant chip or "Orchestrator" wording in the composer', async () => {
    const s = session({ kind: 'chat' });
    mount(<Composer session={s} activeRun={null} onSent={() => {}} />, {
      'grant.list': () => ({ items: [grant(s)] }),
    });
    await screen.findByRole('textbox');
    expect(screen.queryByTestId('grant-chip')).toBeNull();
    expect(document.body).not.toHaveTextContent(/Orchestrator|権限/);
  });

  it('sends the suggested first message with one click', async () => {
    const s = session({ kind: 'chat' });
    useUi.setState({ suggestions: { [s.id]: '新製品のローンチ準備を進めて' } });
    let sent: Record<string, unknown> | null = null;
    mount(<Composer session={s} activeRun={null} onSent={() => {}} />, {
      'session.send': (p) => {
        sent = p;
        return { messageId: 'msg_1', runId: 'run_1' };
      },
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('suggestion-chip'));
    });
    expect(sent).toEqual({ sessionId: s.id, content: '新製品のローンチ準備を進めて' });
    expect(useUi.getState().suggestions[s.id]).toBeUndefined();
  });
});

describe('<GrantLine>', () => {
  it('says 任せました and 任せるのをやめました with the time', async () => {
    const s = session({ kind: 'chat' });
    const g = grant(s, { revokedAt: iso(T0 + 60_000) });
    mount(
      <>
        <GrantLine grant={g} change="given" />
        <GrantLine grant={g} change="ended" />
      </>,
      { 'grant.list': () => ({ items: [g] }) },
    );
    expect(await screen.findByTestId('grant-line-given')).toHaveTextContent('任せました');
    expect(screen.getByTestId('grant-line-ended')).toHaveTextContent('任せるのをやめました');
  });

  it("stays quiet for a child's own working grant (not a delegation by a person)", async () => {
    const child = session({ kind: 'agent' });
    const own = grant(child, {
      permissions: ['artifact.publish', 'human.ask'],
      grantedBy: { kind: 'agent', sessionId: 'ses_parent', runId: 'run_parent' } as CapabilityGrant['grantedBy'],
    });
    mount(<GrantLine grant={own} change="given" />, { 'grant.list': () => ({ items: [own] }) });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByTestId('grant-line-given')).toBeNull();
  });

  it('stays quiet when delegating again replaced the grant (new settings)', async () => {
    const s = session({ kind: 'chat' });
    const old = grant(s, { revokedAt: iso(T0 + 60_000) });
    const next = grant(s, { id: 'grt_00000000000000000000000010', createdAt: iso(T0 + 60_020) });
    expect(isReplacement(old, 'ended', [old, next])).toBe(true);
    expect(isReplacement(next, 'given', [old, next])).toBe(true);
    expect(isReplacement(old, 'given', [old, next])).toBe(false);
    mount(
      <>
        <GrantLine grant={old} change="given" />
        <GrantLine grant={old} change="ended" />
        <GrantLine grant={next} change="given" />
      </>,
      { 'grant.list': () => ({ items: [old, next] }) },
    );
    await screen.findByTestId('grant-line-given');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getAllByTestId('grant-line-given')).toHaveLength(1);
    expect(screen.queryByTestId('grant-line-ended')).toBeNull();
  });
});
