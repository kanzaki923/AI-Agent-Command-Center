import type { SettingsView } from '@acc/protocol';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { card, session } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { Onboarding } from './Onboarding';

const EMPTY: SettingsView = {
  litellm: { baseUrl: null, hasApiKey: false, apiKeyMasked: null },
  defaultModel: null,
  defaultRuntime: null,
  maxConcurrentRuns: 10,
  maxDelegationDepth: 1,
};

function mount(over: Parameters<typeof createFakeClient>[0] = {}, sessions = 0) {
  let settings = EMPTY;
  const demo = session({ kind: 'chat', title: 'デモ: 新製品ローンチ準備' });
  const fake = createFakeClient({
    'settings.get': () => settings,
    'settings.update': (p) => {
      const l = (p as { litellm?: { baseUrl?: string } }).litellm;
      if (l?.baseUrl) settings = { ...settings, litellm: { baseUrl: l.baseUrl, hasApiKey: true, apiKeyMasked: 'sk-…1234' } };
      return settings;
    },
    'session.list': () => ({ items: Array.from({ length: sessions }, () => session()), nextCursor: null }),
    'models.list': () => ({ models: [{ id: 'claude-sonnet', label: 'Claude Sonnet', provider: null }], source: 'litellm' }),
    'system.setupDemo': () => ({ project: { id: 'prj_d' }, session: demo, grant: {}, repoPath: 'x', created: true }),
    'session.tree': () => ({ rootSessionId: demo.id, nodes: [card({ id: demo.id, role: 'supervisor' })] }),
    'session.spawn': () => ({ session: session(), runId: null, budgetId: null, waitingFor: [] }),
    ...over,
  });
  render(
    <RuntimeProvider runtime={createRuntime(fake.client)}>
      <TooltipProvider>
        <Onboarding />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return { fake, demo };
}

beforeEach(() => {
  useUi.setState({ onboardingDone: false, mode: 'session', focusSessionId: null });
});

describe('<Onboarding>', () => {
  it('is one screen: the connection with 確かめる, or あとで (mock) — nothing to read', async () => {
    mount();
    const dialog = await screen.findByRole('dialog', { name: 'はじめに' });
    expect(within(dialog).getByLabelText('LiteLLM Proxy の URL')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('API キー')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '確かめる' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'あとで（モックで試す）' })).toBeInTheDocument();
    expect(within(dialog).queryAllByText(/。/)).toHaveLength(0);
    expect(dialog).not.toHaveTextContent(/Orchestrator|Worker|プロジェクト/);
  });

  it('あとで starts the demo: a delegated conversation with three mock children, then home', async () => {
    const { fake, demo } = mount();
    const later = await screen.findByRole('button', { name: 'あとで（モックで試す）' });
    await act(async () => {
      fireEvent.click(later);
    });
    await waitFor(() => expect(useUi.getState().onboardingDone).toBe(true));
    expect(fake.calls.filter((c) => c.method === 'system.setupDemo')).toHaveLength(1);
    const spawns = fake.calls.filter((c) => c.method === 'session.spawn').map((c) => c.params);
    expect(spawns).toHaveLength(3);
    for (const p of spawns) expect(p).toMatchObject({ parentSessionId: demo.id, mode: 'agent', runtime: 'mock' });
    expect(useUi.getState().mode).toBe('home');
    expect(screen.queryByRole('dialog', { name: 'はじめに' })).toBeNull();
  });

  it('stays open while connecting (saving the URL configures it) until 始める', async () => {
    mount();
    const url = await screen.findByLabelText('LiteLLM Proxy の URL');
    fireEvent.change(url, { target: { value: 'http://localhost:4000' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '確かめる' }));
    });
    expect(await screen.findByText('1 モデル')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'はじめに' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '始める' }));
    });
    await waitFor(() => expect(useUi.getState().onboardingDone).toBe(true));
  });

  it('does not show for someone who already uses the app', async () => {
    const { fake } = mount({}, 2);
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'session.list')).toBe(true));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByRole('dialog', { name: 'はじめに' })).toBeNull();
  });
});
