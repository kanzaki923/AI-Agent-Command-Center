import type { SettingsView } from '@acc/protocol';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useConfirm } from '../../store/confirm';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { TooltipProvider } from '../ui/Tooltip';
import { SettingsDialog, parseReserveUsd } from './SettingsDialog';

const VIEW: SettingsView = {
  litellm: { baseUrl: 'http://127.0.0.1:4000', hasApiKey: true, apiKeyMasked: 'sk-…a1b2' },
  defaultModel: null,
  defaultRuntime: null,
  maxConcurrentRuns: 10,
  maxDelegationDepth: 1,
  autoResumeOrchestrators: true,
  llmCallReserveUsd: 0.25,
};

function mount() {
  let current = VIEW;
  const updates: unknown[] = [];
  const fake = createFakeClient({
    'settings.get': () => current,
    'settings.update': (p) => {
      updates.push(p);
      current = { ...current, ...(p as Partial<SettingsView>) };
      return current;
    },
    'system.info': () => ({
      version: '0.1.0',
      protocolVersion: 1,
      pid: 42,
      port: 7777,
      startedAt: '2026-10-29T05:00:00.000Z',
      dataDir: 'D:\\acc',
      nodeVersion: 'v22',
      platform: 'win32',
      methods: ['system.shutdown'],
      stats: { projects: 0, sessions: 0, activeRuns: 0, lastEventSeq: 0 },
    }),
    'models.list': () => ({ models: [], source: 'config' }),
  });
  render(
    <RuntimeProvider runtime={createRuntime(fake.client)}>
      <TooltipProvider>
        <SettingsDialog />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return { fake, updates };
}

beforeEach(() => {
  useUi.setState({ settingsOpen: true });
  useConfirm.setState({ request: null });
});

describe('parseReserveUsd', () => {
  it('accepts 0–100 USD rounded to cents', () => {
    expect(parseReserveUsd('0.5')).toBe(0.5);
    expect(parseReserveUsd('0')).toBe(0);
    expect(parseReserveUsd('0.333')).toBe(0.33);
    expect(parseReserveUsd('')).toBeNull();
    expect(parseReserveUsd('-1')).toBeNull();
    expect(parseReserveUsd('101')).toBeNull();
    expect(parseReserveUsd('abc')).toBeNull();
  });
});

describe('<SettingsDialog> daemon settings', () => {
  it('turns automatic orchestrator resume off through settings.update', async () => {
    const { updates } = mount();
    const group = await screen.findByRole('radiogroup', { name: '再起動のあと Orchestrator を再開' });
    await waitFor(() =>
      expect(group.querySelector('[aria-checked="true"]')).toHaveTextContent('オン'),
    );
    await act(async () => {
      fireEvent.click(screen.getAllByRole('radio', { name: 'オフ' }).find((b) => group.contains(b))!);
    });
    await waitFor(() => expect(updates).toEqual([{ autoResumeOrchestrators: false }]));
    await waitFor(() =>
      expect(group.querySelector('[aria-checked="true"]')).toHaveTextContent('オフ'),
    );
  });

  it('saves the per-call LLM reserve, and ignores an invalid amount', async () => {
    const { updates } = mount();
    const input = await screen.findByLabelText('LLM 呼び出しごとの予約額（USD）');
    await waitFor(() => expect(input).toHaveValue(0.25));
    expect(screen.getByText(/確保できない呼び出しは/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '-3' } });
    fireEvent.blur(input);
    expect(updates).toEqual([]);
    const again = screen.getByLabelText('LLM 呼び出しごとの予約額（USD）');
    fireEvent.change(again, { target: { value: '0.5' } });
    await act(async () => {
      fireEvent.blur(again);
    });
    await waitFor(() => expect(updates).toEqual([{ llmCallReserveUsd: 0.5 }]));
  });

  it('stops the daemon from the browser (system.shutdown) after a confirmation', async () => {
    mount();
    const button = await screen.findByTestId('shutdown-daemon');
    expect(button).toHaveTextContent('Core Daemon を停止');
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(useConfirm.getState().request?.title).toBe('Core Daemon を停止しますか？'));
  });
});
