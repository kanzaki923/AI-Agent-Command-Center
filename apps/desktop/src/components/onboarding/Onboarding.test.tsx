import type { SettingsView } from '@acc/protocol';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promptConnectionThen, unconfigured } from '../../app/connect';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { TooltipProvider } from '../ui/Tooltip';
import { Onboarding } from './Onboarding';

const EMPTY: SettingsView = {
  litellm: { baseUrl: null, hasApiKey: false, apiKeyMasked: null },
  defaultModel: null,
  defaultRuntime: null,
  maxConcurrentRuns: 10,
  maxDelegationDepth: 1,
};

function mount(over: Parameters<typeof createFakeClient>[0] = {}) {
  let settings = EMPTY;
  const fake = createFakeClient({
    'settings.get': () => settings,
    'settings.update': (p) => {
      const l = (p as { litellm?: { baseUrl?: string } }).litellm;
      if (l?.baseUrl) settings = { ...settings, litellm: { baseUrl: l.baseUrl, hasApiKey: true, apiKeyMasked: 'sk-…1234' } };
      return settings;
    },
    'models.list': () => ({ models: [{ id: 'claude-sonnet', label: 'Claude Sonnet', provider: null }], source: 'litellm' }),
    ...over,
  });
  render(
    <RuntimeProvider runtime={createRuntime(fake.client)}>
      <TooltipProvider>
        <Onboarding />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return { fake };
}

beforeEach(() => {
  useUi.setState({ onboardingDone: false, connectPromptOpen: false, mode: 'home', focusSessionId: null });
});

describe('the connection prompt (ui-rework spec §3.4)', () => {
  it('is not a first-run screen: nothing shows until a real request is sent without an endpoint', () => {
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(unconfigured(EMPTY)).toBe(true);
    expect(unconfigured({ ...EMPTY, litellm: { baseUrl: 'http://x', hasApiKey: false, apiKeyMasked: null } })).toBe(false);
  });

  it('opens on the first request, and モックで送る sends it on the mock and never asks again', async () => {
    mount();
    const go = vi.fn();
    expect(promptConnectionThen(EMPTY, go)).toBe(true);
    const dialog = await screen.findByRole('dialog', { name: '接続先' });
    expect(within(dialog).getByLabelText('LiteLLM Proxy の URL')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '確かめる' })).toBeInTheDocument();
    expect(go).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'モックで送る' }));
    });
    expect(go).toHaveBeenCalledTimes(1);
    expect(useUi.getState().onboardingDone).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    // Asked once: the next request goes straight through.
    expect(promptConnectionThen(EMPTY, vi.fn())).toBe(false);
  });

  it('closing it (outside or Esc) sends nothing and asks again next time', async () => {
    mount();
    const go = vi.fn();
    promptConnectionThen(EMPTY, go);
    let dialog = await screen.findByRole('dialog', { name: '接続先' });
    await act(async () => {
      fireEvent.click(dialog);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(go).not.toHaveBeenCalled();
    expect(useUi.getState().onboardingDone).toBe(false);

    const again = vi.fn();
    expect(promptConnectionThen(EMPTY, again)).toBe(true);
    dialog = await screen.findByRole('dialog', { name: '接続先' });
    await act(async () => {
      fireEvent.keyDown(within(dialog).getByLabelText('LiteLLM Proxy の URL'), { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(again).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
  });

  it('connecting (確かめる → 始める) sends the waiting request too', async () => {
    mount();
    const go = vi.fn();
    promptConnectionThen(EMPTY, go);
    const url = await screen.findByLabelText('LiteLLM Proxy の URL');
    fireEvent.change(url, { target: { value: 'http://localhost:4000' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '確かめる' }));
    });
    expect(await screen.findByText('1 モデル')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '接続先' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '始める' }));
    });
    await waitFor(() => expect(useUi.getState().onboardingDone).toBe(true));
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('does not ask when an endpoint is saved, or when it was already answered', () => {
    useUi.setState({ onboardingDone: true });
    expect(promptConnectionThen(EMPTY, vi.fn())).toBe(false);
    useUi.setState({ onboardingDone: false });
    expect(promptConnectionThen({ ...EMPTY, litellm: { baseUrl: 'http://x', hasApiKey: true, apiKeyMasked: null } }, vi.fn())).toBe(false);
    expect(useUi.getState().connectPromptOpen).toBe(false);
  });
});
