import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { id, session } from '../../test/fixtures';
import { Onboarding } from './Onboarding';

describe('<Onboarding> demo mode', () => {
  beforeEach(() => {
    useUi.setState({ onboardingDone: false, drafts: {}, focusSessionId: null, projectId: null });
  });

  it('"デモモードで試す" prepares the demo in the daemon and opens its orchestrator chat', async () => {
    const projectId = id('prj');
    const demoSession = session({ kind: 'chat', title: 'デモ: 設計チャット', projectId });
    const fake = createFakeClient({
      'settings.get': () => ({
        litellm: { baseUrl: null, hasApiKey: false, apiKeyMasked: null },
        defaultModel: null,
        defaultRuntime: null,
        maxConcurrentRuns: 10,
        maxDelegationDepth: 1,
      }),
      'session.list': () => ({ items: [], nextCursor: null }),
      'system.setupDemo': () => ({
        project: { id: projectId, name: 'デモプロジェクト（認証）' },
        session: demoSession,
        grant: {},
        repoPath: '/tmp/acc/demo/auth-demo',
        created: true,
      }),
    });
    const rt = createRuntime(fake.client);
    render(
      <RuntimeProvider runtime={rt}>
        <Onboarding />
      </RuntimeProvider>,
    );
    const card = await screen.findByRole('button', { name: /デモモードで試す/ });
    await act(async () => {
      fireEvent.click(card);
    });

    expect(fake.calls.filter((c) => c.method === 'system.setupDemo')).toHaveLength(1);
    const ui = useUi.getState();
    expect(ui.onboardingDone).toBe(true);
    expect(ui.projectId).toBe(projectId);
    expect(ui.focusSessionId).toBe(demoSession.id);
    expect(ui.drafts[demoSession.id]).toBe('認証まわりのドキュメントとテストを並列で整備して');
  });
});
