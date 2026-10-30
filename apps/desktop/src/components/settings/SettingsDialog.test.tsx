import type { ChatGptStatus, SettingsView } from '@acc/protocol';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useConfirm } from '../../store/confirm';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { TooltipProvider } from '../ui/Tooltip';
import { connectionStatus, SettingsDialog } from './SettingsDialog';
import { parseUsd } from './controls';

const VIEW: SettingsView = {
  litellm: { baseUrl: 'http://127.0.0.1:4000', hasApiKey: true, apiKeyMasked: 'sk-…a1b2' },
  defaultModel: null,
  defaultRuntime: null,
  maxConcurrentRuns: 10,
  maxDelegationDepth: 1,
  autoResumeOrchestrators: true,
  llmCallReserveUsd: 0.25,
  defaultPermissionProfile: 'autonomous',
  autoMode: { enabled: true, judge: 'server', classifierModel: null },
  maxConcurrentAgents: 10,
  maxConcurrentChats: 16,
  limits: { dailyUsd: 20, timezone: 'Asia/Tokyo' },
  autoResume: true,
  assistant: { model: null, dailyUsd: 2 },
  providers: {
    anthropic: { baseUrl: null, hasApiKey: false, apiKeyMasked: null },
    openai: { baseUrl: null, hasApiKey: false, apiKeyMasked: null, chatgpt: null },
  },
};

function mount(view: SettingsView = VIEW, extra: Parameters<typeof createFakeClient>[0] = {}) {
  let current = view;
  const updates: unknown[] = [];
  const fake = createFakeClient({
    'settings.get': () => current,
    'settings.update': (p) => {
      updates.push(p);
      const patch = p as Partial<SettingsView> & {
        providers?: { anthropic?: { apiKey?: string | null }; openai?: { apiKey?: string | null } };
      };
      // Like the daemon: autoMode, limits and providers are merged field by field; keys come back masked.
      const providers =
        current.providers && patch.providers ? structuredClone(current.providers) : undefined;
      const masked = (key: string | null) => ({
        hasApiKey: key !== null,
        apiKeyMasked: key ? `sk-…${key.slice(-4)}` : null,
      });
      const a = patch.providers?.anthropic?.apiKey;
      if (providers && a !== undefined)
        providers.anthropic = { ...providers.anthropic, ...masked(a) };
      const o = patch.providers?.openai?.apiKey;
      if (providers && o !== undefined) providers.openai = { ...providers.openai, ...masked(o) };
      current = {
        ...current,
        ...(patch.autoMode && current.autoMode
          ? { autoMode: { ...current.autoMode, ...patch.autoMode } }
          : {}),
        ...(patch.limits && current.limits
          ? { limits: { ...current.limits, ...patch.limits } }
          : {}),
        ...(patch.assistant && current.assistant
          ? { assistant: { ...current.assistant, ...patch.assistant } }
          : {}),
        ...(providers ? { providers } : {}),
        ...(patch.defaultPermissionProfile
          ? { defaultPermissionProfile: patch.defaultPermissionProfile }
          : {}),
        ...(patch.litellm ? { litellm: { ...current.litellm, ...patch.litellm } } : {}),
        ...(patch.autoResume !== undefined ? { autoResume: patch.autoResume } : {}),
        ...(patch.autoResumeOrchestrators !== undefined
          ? { autoResumeOrchestrators: patch.autoResumeOrchestrators }
          : {}),
        ...(patch.llmCallReserveUsd !== undefined
          ? { llmCallReserveUsd: patch.llmCallReserveUsd }
          : {}),
        ...(patch.maxConcurrentAgents !== undefined
          ? { maxConcurrentAgents: patch.maxConcurrentAgents }
          : {}),
        ...(patch.maxConcurrentChats !== undefined
          ? { maxConcurrentChats: patch.maxConcurrentChats }
          : {}),
        ...(patch.defaultModel !== undefined ? { defaultModel: patch.defaultModel } : {}),
        ...(patch.modelRules !== undefined ? { modelRules: patch.modelRules } : {}),
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
    'models.list': () => ({
      models: [{ id: 'claude-sonnet', label: null, provider: null }],
      source: 'litellm',
    }),
    ...extra,
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

const openDetails = async () => {
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: '詳細' }));
  });
};

beforeEach(() => {
  useUi.setState({
    settingsOpen: true,
    shortcutsOpen: false,
    theme: 'dark',
    reduceMotion: 'system',
  });
  useConfirm.setState({ request: null });
});

describe('parseUsd', () => {
  it('reads an amount in dollars, rounded to cents', () => {
    expect(parseUsd('20')).toBe(20);
    expect(parseUsd('$2.505')).toBe(2.51);
    expect(parseUsd('1,000')).toBe(1000);
    expect(parseUsd('')).toBeUndefined();
    expect(parseUsd('', { allowEmpty: true })).toBeNull();
    expect(parseUsd('0')).toBeUndefined();
    expect(parseUsd('0', { allowZero: true })).toBe(0);
    expect(parseUsd('-1')).toBeUndefined();
    expect(parseUsd('101', { max: 100 })).toBeUndefined();
    expect(parseUsd('abc')).toBeUndefined();
  });
});

describe('connectionStatus', () => {
  it('names the endpoint and how many models it serves, or モック without one', () => {
    expect(connectionStatus(VIEW, { models: [1, 2], source: 'litellm' }, false)).toEqual({
      tone: 'ok',
      text: '127.0.0.1:4000 · 2 モデル',
    });
    expect(connectionStatus(VIEW, undefined, true).tone).toBe('error');
    expect(
      connectionStatus(
        { ...VIEW, litellm: { baseUrl: null, hasApiKey: false, apiKeyMasked: null } },
        undefined,
        false,
      ),
    ).toEqual({
      tone: 'off',
      text: 'モック',
    });
  });
});

describe('<SettingsDialog> up front', () => {
  it('shows only connection, 任せ方, the daily limit and appearance; the rest is folded', async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByTestId('connection-status')).toHaveTextContent(
        '127.0.0.1:4000 · 1 モデル',
      ),
    );
    expect(screen.getByRole('radiogroup', { name: '任せ方' })).toBeInTheDocument();
    expect(screen.getByLabelText('1 日の上限')).toHaveValue('20');
    expect(screen.getByRole('radiogroup', { name: 'テーマ' })).toBeInTheDocument();
    expect(screen.queryByTestId('settings-details')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: '自動判定' })).toBeNull();
    expect(screen.getByRole('button', { name: '詳細' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('has no explanation paragraphs', async () => {
    mount();
    await screen.findByTestId('connection-status');
    await openDetails();
    const dialog = screen.getByRole('dialog', { name: '設定' });
    // Every visible text is a name, a value or a button: none is a sentence.
    expect(within(dialog).queryAllByText(/。/)).toHaveLength(0);
    expect(dialog).not.toHaveTextContent(/Orchestrator|Worker|Task|Run /);
  });

  it('changes 任せ方 with one press', async () => {
    const { updates } = mount();
    const group = await screen.findByRole('radiogroup', { name: '任せ方' });
    await act(async () => {
      fireEvent.click(within(group).getByRole('radio', { name: '慎重' }));
    });
    await waitFor(() => expect(updates).toEqual([{ defaultPermissionProfile: 'careful' }]));
  });

  it('changes the daily limit in place, and an empty field removes it', async () => {
    const { updates } = mount();
    await waitFor(() => expect(screen.getByLabelText('1 日の上限')).toHaveValue('20'));
    const input = screen.getByLabelText('1 日の上限');
    fireEvent.change(input, { target: { value: '35' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    await waitFor(() => expect(updates).toContainEqual({ limits: { dailyUsd: 35 } }));
    await waitFor(() => expect(screen.getByLabelText('1 日の上限')).toHaveValue('35'));
    const again = screen.getByLabelText('1 日の上限');
    fireEvent.change(again, { target: { value: '' } });
    await act(async () => {
      fireEvent.blur(again);
    });
    await waitFor(() => expect(updates).toContainEqual({ limits: { dailyUsd: null } }));
  });

  it('changes the daily limit of the assistant beside the daily limit; an older daemon has no such row', async () => {
    const { updates } = mount();
    await waitFor(() => expect(screen.getByLabelText('右腕の上限')).toHaveValue('2'));
    const input = screen.getByLabelText('右腕の上限');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);
    await waitFor(() => expect(updates).toContainEqual({ assistant: { dailyUsd: 5 } }));
    await waitFor(() => expect(screen.getByLabelText('右腕の上限')).toHaveValue('5'));
  });

  it('ignores an invalid amount and puts the value back', async () => {
    const { updates } = mount();
    await waitFor(() => expect(screen.getByLabelText('1 日の上限')).toHaveValue('20'));
    const input = screen.getByLabelText('1 日の上限');
    fireEvent.change(input, { target: { value: '-3' } });
    fireEvent.blur(input);
    expect(updates).toEqual([]);
    expect(input).toHaveValue('20');
  });

  it('switches the theme from the icons', async () => {
    mount();
    const group = await screen.findByRole('radiogroup', { name: 'テーマ' });
    fireEvent.click(within(group).getByRole('radio', { name: 'ライト' }));
    expect(useUi.getState().theme).toBe('light');
  });

  it('変更 opens the providers side by side; the LiteLLM row opens its form and folds it with 取り消し', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '変更' }));
    const panel = screen.getByTestId('provider-panel');
    expect(within(panel).getByText('127.0.0.1:4000')).toBeInTheDocument();
    expect(within(panel).getAllByText('未設定')).toHaveLength(2);
    expect(within(panel).getByRole('button', { name: 'ChatGPT でサインイン' })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: '変更' }));
    expect(screen.getByLabelText('LiteLLM Proxy の URL')).toHaveValue('http://127.0.0.1:4000');
    expect(screen.getByRole('button', { name: '確かめる' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取り消し' }));
    expect(screen.queryByLabelText('LiteLLM Proxy の URL')).toBeNull();
  });

  it('saves a provider key through the daemon and shows it masked; 外す clears it', async () => {
    const { updates } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '変更' }));
    const panel = screen.getByTestId('provider-panel');
    const buttons = within(panel).getAllByRole('button', { name: '設定' });
    fireEvent.click(buttons[0]!);
    const input = screen.getByLabelText('Anthropic の API キー');
    fireEvent.change(input, { target: { value: 'sk-ant-api03-secretsecret1234' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() =>
      expect(updates).toContainEqual({
        providers: { anthropic: { apiKey: 'sk-ant-api03-secretsecret1234' } },
      }),
    );
    await waitFor(() => expect(within(panel).getByText('sk-…1234')).toBeInTheDocument());
    expect(screen.getByTestId('connection-status')).toHaveTextContent('Anthropic');
    fireEvent.click(within(panel).getByRole('button', { name: '外す' }));
    await waitFor(() =>
      expect(updates).toContainEqual({ providers: { anthropic: { apiKey: null } } }),
    );
  });

  it('signs in with ChatGPT: the daemon gives a URL, the row waits, then shows the account', async () => {
    let status: ChatGptStatus = { state: 'signed_out', email: null, error: null };
    const calls: string[] = [];
    mount(VIEW, {
      'chatgpt.status': () => status,
      'chatgpt.signIn': () => {
        calls.push('signIn');
        status = { state: 'waiting', email: null, error: null };
        return { url: 'https://auth.openai.com/api/accounts/authorize?x=1' };
      },
      'chatgpt.signOut': () => {
        calls.push('signOut');
        status = { state: 'signed_out', email: null, error: null };
        return { ok: true };
      },
    });
    const opened: string[] = [];
    window.open = ((url: string) => {
      opened.push(url);
      return null;
    }) as typeof window.open;
    fireEvent.click(await screen.findByRole('button', { name: '変更' }));
    fireEvent.click(await screen.findByRole('button', { name: 'ChatGPT でサインイン' }));
    await waitFor(() => expect(calls).toEqual(['signIn']));
    expect(opened).toEqual(['https://auth.openai.com/api/accounts/authorize?x=1']);
    await screen.findByText('ブラウザで続けてください');
    // The browser side finished: the daemon says so.
    status = { state: 'signed_in', email: 'me@example.com', error: null };
    await waitFor(
      () => expect(screen.getByTestId('chatgpt-account')).toHaveTextContent('サインイン済み'),
      { timeout: 3000 },
    );
    // The address stays off the screen until pressed; the summary never shows it.
    expect(screen.getByTestId('connection-status')).not.toHaveTextContent('me@example.com');
    fireEvent.click(screen.getByTestId('chatgpt-account'));
    expect(screen.getByTestId('chatgpt-account')).toHaveTextContent('me@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'サインアウト' }));
    await waitFor(() => expect(calls).toEqual(['signIn', 'signOut']));
    await screen.findByRole('button', { name: 'ChatGPT でサインイン' });
  });
});

describe('<SettingsDialog> モデル', () => {
  const ROSTER: SettingsView = {
    ...VIEW,
    defaultModel: 'openai/gpt-6-luna',
    modelRules: [
      { model: 'anthropic/claude-sonnet-5-5', when: '画面の設計' },
      { model: 'gemini-3-pro', when: '文章を書く' },
    ],
  };
  const MODELS = {
    'models.list': () => ({
      models: [
        { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic', runUsd: 0.48 },
        { id: 'gemini-3-pro', label: null, provider: 'litellm', runUsd: null },
        { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', provider: 'chatgpt', runUsd: 0 },
        { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic', runUsd: 0.96 },
      ],
      source: 'providers',
    }),
    'cost.summary': () => ({
      totalUsd: 3.2,
      estimated: false,
      rows: [{ key: 'anthropic/claude-sonnet-5-5', label: 'anthropic/claude-sonnet-5-5', usd: 3.2, estimated: false }],
      daily: { limitUsd: 20, usedTodayUsd: 0 },
    }),
  };

  const openRoster = async () => {
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'モデルを変更' }));
    });
    return screen.findByTestId('model-roster');
  };

  it('sums the roster up, and shows each row with the cost of a run and of the last 30 days', async () => {
    mount(ROSTER, MODELS);
    await waitFor(() =>
      expect(screen.getByTestId('roster-summary')).toHaveTextContent('gpt-6-luna ほか 2'),
    );
    await openRoster();
    const rows = await screen.findAllByTestId('roster-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Claude Sonnet 5.5');
    await waitFor(() => expect(rows[0]).toHaveTextContent('約 $0.48/回'));
    await waitFor(() => expect(rows[0]).toHaveTextContent('30 日 $3.20'));
    expect(rows[1]).toHaveTextContent('—');
    expect(screen.getByTestId('roster-otherwise')).toHaveTextContent('GPT-6 Luna');
    expect(screen.getByTestId('roster-otherwise')).toHaveTextContent('契約枠');
  });

  it('opens the model list of a row above the dialog and saves the choice', async () => {
    const { updates } = mount(ROSTER, MODELS);
    await openRoster();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: '1 番目のモデル' }));
    });
    const opus = await screen.findByRole('option', { name: /Claude Opus 5.5/ });
    // Popovers sit below dialogs (40 < 60) unless opened from one.
    expect(opus.closest('[data-radix-popper-content-wrapper] > *')).toHaveClass('z-[61]');
    await act(async () => {
      fireEvent.click(opus);
    });
    expect(updates.at(-1)).toEqual({
      modelRules: [
        { model: 'anthropic/claude-opus-5-5', when: '画面の設計' },
        { model: 'gemini-3-pro', when: '文章を書く' },
      ],
    });
  });

  it('reorders with Alt+↑, saves a condition on blur, adds and removes rows', async () => {
    const { updates } = mount(ROSTER, MODELS);
    await openRoster();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('button', { name: '2 番目を動かす（Alt+↑↓）' }), {
        key: 'ArrowUp',
        altKey: true,
      });
    });
    expect(updates.at(-1)).toEqual({
      modelRules: [
        { model: 'gemini-3-pro', when: '文章を書く' },
        { model: 'anthropic/claude-sonnet-5-5', when: '画面の設計' },
      ],
    });
    await waitFor(() =>
      expect(screen.getAllByTestId('roster-row')[0]).toHaveTextContent('gemini-3-pro'),
    );
    const when = await screen.findByLabelText('2 番目を使うとき');
    fireEvent.change(when, { target: { value: '画面の設計・UI の実装 ' } });
    await act(async () => {
      fireEvent.blur(when);
    });
    expect(updates.at(-1)).toEqual({
      modelRules: [
        { model: 'gemini-3-pro', when: '文章を書く' },
        { model: 'anthropic/claude-sonnet-5-5', when: '画面の設計・UI の実装' },
      ],
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'モデルを足す' }));
    });
    await waitFor(() => expect(screen.getAllByTestId('roster-row')).toHaveLength(3));
    expect(updates.at(-1)).toMatchObject({
      modelRules: [{}, {}, { model: 'anthropic/claude-opus-5-5', when: '' }],
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '1 番目を外す' }));
    });
    expect((updates.at(-1) as { modelRules: unknown[] }).modelRules).toHaveLength(2);
  });
});

describe('<SettingsDialog> 詳細', () => {
  it('turns auto mode off, chooses where it judges and saves the model on blur', async () => {
    const { updates } = mount();
    await openDetails();
    const judge = screen.getByRole('radiogroup', { name: '判定する場所' });
    await act(async () => {
      fireEvent.click(within(judge).getByRole('radio', { name: '手元' }));
    });
    await waitFor(() => expect(updates).toEqual([{ autoMode: { judge: 'client' } }]));
    const input = screen.getByLabelText('判定モデル');
    fireEvent.change(input, { target: { value: 'claude-sonnet' } });
    await act(async () => {
      fireEvent.blur(input);
    });
    await waitFor(() =>
      expect(updates).toContainEqual({ autoMode: { classifierModel: 'claude-sonnet' } }),
    );
    const auto = screen.getByRole('radiogroup', { name: '自動判定' });
    await act(async () => {
      fireEvent.click(within(auto).getByRole('radio', { name: 'オフ' }));
    });
    await waitFor(() => expect(updates).toContainEqual({ autoMode: { enabled: false } }));
    await waitFor(() => expect(screen.queryByLabelText('判定モデル')).toBeNull());
  });

  it('steps how many agents and conversations run at once', async () => {
    const { updates } = mount();
    await openDetails();
    const agents = screen.getByRole('group', { name: '同時に動くエージェント' });
    await act(async () => {
      fireEvent.click(within(agents).getByRole('button', { name: '増やす' }));
    });
    await waitFor(() => expect(updates).toEqual([{ maxConcurrentAgents: 11 }]));
    const chats = screen.getByRole('group', { name: '同時に動く会話' });
    await act(async () => {
      fireEvent.click(within(chats).getByRole('button', { name: '減らす' }));
    });
    await waitFor(() => expect(updates).toContainEqual({ maxConcurrentChats: 15 }));
  });

  it('saves the per-call reserve (0 allowed) and the resume after a restart', async () => {
    const { updates } = mount();
    await openDetails();
    const reserve = screen.getByLabelText('1 回の呼び出しの予約');
    fireEvent.change(reserve, { target: { value: '0' } });
    await act(async () => {
      fireEvent.blur(reserve);
    });
    await waitFor(() => expect(updates).toEqual([{ llmCallReserveUsd: 0 }]));
    const resume = screen.getByRole('radiogroup', { name: '再起動のあと再開' });
    await act(async () => {
      fireEvent.click(within(resume).getByRole('radio', { name: 'オフ' }));
    });
    await waitFor(() => expect(updates).toContainEqual({ autoResume: false }));
  });

  it('opens the shortcut list and stops the daemon after a confirmation', async () => {
    mount();
    await openDetails();
    fireEvent.click(screen.getByRole('button', { name: /一覧/ }));
    expect(useUi.getState().shortcutsOpen).toBe(true);
    expect(await screen.findByTestId('diagnostics')).toHaveTextContent('pid 42');
    await act(async () => {
      fireEvent.click(screen.getByTestId('shutdown-daemon'));
    });
    await waitFor(() =>
      expect(useConfirm.getState().request?.title).toBe('Core Daemon を停止しますか？'),
    );
  });

  it('works with an older daemon that reports no profiles, limits or auto mode', async () => {
    mount({
      litellm: { baseUrl: null, hasApiKey: false, apiKeyMasked: null },
      defaultModel: null,
      defaultRuntime: null,
      maxConcurrentRuns: 8,
      maxDelegationDepth: 1,
    });
    expect(await screen.findByTestId('connection-status')).toHaveTextContent('モック');
    expect(screen.queryByRole('radiogroup', { name: '任せ方' })).toBeNull();
    await openDetails();
    expect(
      within(screen.getByRole('group', { name: '同時に動くエージェント' })).getByText('8'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: '自動判定' })).toBeNull();
  });
});
