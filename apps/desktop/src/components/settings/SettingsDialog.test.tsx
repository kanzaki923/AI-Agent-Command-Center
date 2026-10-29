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

function mount(view: SettingsView = VIEW) {
  let current = view;
  const updates: unknown[] = [];
  const fake = createFakeClient({
    'settings.get': () => current,
    'settings.update': (p) => {
      updates.push(p);
      const patch = p as Partial<SettingsView>;
      // Like the daemon: autoMode is merged field by field.
      current = {
        ...current,
        ...patch,
        ...(patch.autoMode && current.autoMode ? { autoMode: { ...current.autoMode, ...patch.autoMode } } : {}),
      };
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

describe('<SettingsDialog> agent permissions', () => {
  const WITH_PROFILES: SettingsView = {
    ...VIEW,
    defaultPermissionProfile: 'autonomous',
    autoMode: { enabled: true, judge: 'server', classifierModel: null },
  };

  it('picks the default profile, each with one plain line of what runs without asking', async () => {
    const { updates } = mount(WITH_PROFILES);
    const group = await screen.findByRole('radiogroup', { name: '既定のプロファイル' });
    await waitFor(() => expect(group.querySelector('[aria-checked="true"]')).toHaveTextContent('おまかせ（推奨）'));
    expect(group).toHaveTextContent('worktree の中で完結する作業はすべて確認なしで進めます');
    expect(screen.getAllByText(/push・worktree の外への書き込み/).length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(group.querySelector('[data-profile="careful"]')!);
    });
    await waitFor(() => expect(updates).toEqual([{ defaultPermissionProfile: 'careful' }]));
  });

  it('turns auto mode off and saves the classifier model on blur', async () => {
    const { updates } = mount(WITH_PROFILES);
    const input = await screen.findByLabelText('分類器のモデル（LiteLLM 経由のとき）');
    fireEvent.change(input, { target: { value: 'claude-sonnet' } });
    await act(async () => {
      fireEvent.blur(input);
    });
    await waitFor(() => expect(updates).toEqual([{ autoMode: { classifierModel: 'claude-sonnet' } }]));
    const group = screen.getByRole('radiogroup', { name: 'Claude Code の Auto mode' });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('radio', { name: 'オフ' }).find((b) => group.contains(b))!);
    });
    await waitFor(() => expect(updates).toContainEqual({ autoMode: { enabled: false } }));
  });

  it('chooses where auto mode judges, with one line of cost each', async () => {
    const { updates } = mount(WITH_PROFILES);
    const group = await screen.findByRole('radiogroup', { name: '判定する場所' });
    await waitFor(() => expect(group.querySelector('[aria-checked="true"]')).toHaveTextContent('サーバーで判定（推奨）'));
    expect(group).toHaveTextContent('追加のリクエストなし');
    expect(group).toHaveTextContent('1 回約 $0.01、キャッシュが冷えると約 $0.13');
    // With the server judge, the classifier model is the fallback.
    expect(screen.getByText(/サーバー判定を使えない上流のときの予備です/)).toBeInTheDocument();
    expect(screen.getByLabelText('分類器のモデル（LiteLLM 経由のとき）')).toHaveAttribute(
      'placeholder',
      expect.stringContaining('Claude Sonnet 5') as string,
    );
    await act(async () => {
      fireEvent.click(group.querySelector('[data-judge="client"]')!);
    });
    await waitFor(() => expect(updates).toEqual([{ autoMode: { judge: 'client' } }]));
    expect(await screen.findByText(/空のままなら、LiteLLM 経由の Run は Core Daemon のルールで判断します/)).toBeInTheDocument();
  });

  it('hides the judge choice for a daemon that does not report it', async () => {
    mount({ ...WITH_PROFILES, autoMode: { enabled: true, classifierModel: null } });
    await screen.findByLabelText('分類器のモデル（LiteLLM 経由のとき）');
    expect(screen.queryByRole('radiogroup', { name: '判定する場所' })).toBeNull();
  });

  it('says so when the daemon has no permission profiles', async () => {
    mount();
    expect(await screen.findByText('この Core Daemon は権限のプロファイルに対応していません。')).toBeInTheDocument();
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
