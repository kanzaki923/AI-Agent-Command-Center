import type { Message, Session, SessionCard } from '@acc/protocol';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { attention, card, homeSnapshot, homeTree, iso, message, session, T0 } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { treeControl } from '../../daemon/tree';
import { agentModelView } from './FocusHeader';
import { FocusView } from './FocusView';

// jsdom has no layout: give the virtualized chat a viewport so it renders its rows.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
});
afterAll(() => {
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

const page = <T,>(items: T[]) => ({ items, nextCursor: null });

/** A delegated conversation with two children; the second asks a question. */
function scene() {
  const lead = session({ kind: 'chat', title: '新製品ローンチ準備', state: 'supervising' });
  const faq = session({
    title: 'FAQ を 10 問つくる',
    parentSessionId: lead.id,
    rootSessionId: lead.id,
    state: 'needs_you',
    stateSince: iso(T0),
  });
  const research = session({
    title: '競合 3 社の調査',
    parentSessionId: lead.id,
    rootSessionId: lead.id,
    state: 'working',
    activeRunId: null,
  });
  const leadCard = card({ id: lead.id, title: lead.title, role: 'supervisor', state: 'supervising', depth: 0 });
  const faqCard = card({ id: faq.id, parentId: lead.id, depth: 1, title: faq.title, state: 'needs_you', costUsd: 0.39 });
  const researchCard = card({ id: research.id, parentId: lead.id, depth: 1, title: research.title, state: 'working', costUsd: 1 });
  const q = attention(faq, {
    rootSessionId: lead.id,
    title: '価格を FAQ に載せてよいですか？',
    choices: [{ id: 'c1', label: '載せる', tone: 'primary' }],
  });
  faqCard.attentionIds = [q.id];
  const nodes: SessionCard[] = [leadCard, researchCard, faqCard];
  return { lead, faq, research, nodes, q };
}

function mount(opts: {
  sessions: Session[];
  nodes: SessionCard[];
  messages?: Record<string, Message[]>;
  streaming?: { messageId: string; runId: string; text: string; reasoning: string } | null;
  snapshot?: ReturnType<typeof homeSnapshot>;
  extra?: Parameters<typeof createFakeClient>[0];
}) {
  const rootId = opts.nodes[0]!.id;
  const fake = createFakeClient({
    'session.list': () => page(opts.sessions),
    'session.tree': () => ({ rootSessionId: rootId, nodes: opts.nodes }),
    'session.messages': (p) => ({
      items: opts.messages?.[p.sessionId as string] ?? [],
      hasMore: false,
      streaming: opts.streaming ?? null,
    }),
    'home.get': () => opts.snapshot ?? homeSnapshot(),
    'run.list': () => page([]),
    'approval.list': () => page([]),
    ...opts.extra,
  });
  const rt = createRuntime(fake.client);
  render(
    <RuntimeProvider runtime={rt}>
      <TooltipProvider>
        <FocusView />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return fake;
}

beforeEach(() => {
  useUi.setState({ mode: 'session', focusSessionId: null, drafts: {}, editing: null, back: [], forward: [] });
});

describe('<FocusView> head', () => {
  it('shows the parent as a chip that goes back to it, and the state of this conversation', async () => {
    const { lead, faq, research, nodes } = scene();
    useUi.setState({ focusSessionId: faq.id });
    mount({ sessions: [lead, faq, research], nodes });
    const up = await screen.findByRole('button', { name: /新製品ローンチ準備/ });
    expect(await screen.findByRole('heading', { name: 'FAQ を 10 問つくる' })).toBeInTheDocument();
    expect(screen.getByTestId('session-state')).toHaveAttribute('data-state', 'needs_you');
    // A child has no 任せる / 繰り返す of its own.
    expect(screen.queryByRole('button', { name: /^任せる/ })).not.toBeInTheDocument();
    fireEvent.click(up);
    expect(useUi.getState().focusSessionId).toBe(lead.id);
  });

  it('lists the children as chips (press one to go there) and stops the whole tree', async () => {
    const { lead, faq, research, nodes } = scene();
    useUi.setState({ focusSessionId: lead.id });
    const fake = mount({
      sessions: [lead, faq, research],
      nodes,
      extra: { 'session.stop': () => ({ stoppedSessionIds: [], cancelledRunIds: [] }) },
    });
    const row = await screen.findByRole('navigation', { name: '子の会話' });
    const chips = await within(row).findAllByRole('button');
    expect(chips.map((c) => c.getAttribute('data-session-chip'))).toEqual([research.id, faq.id]);
    expect(screen.getByRole('button', { name: /^任せる/ })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '止める' }));
    });
    expect(fake.calls.find((c) => c.method === 'session.stop')?.params).toMatchObject({ sessionId: lead.id, tree: true });
    fireEvent.click(chips[1]!);
    expect(useUi.getState().focusSessionId).toBe(faq.id);
  });

  it('renames on double-click', async () => {
    const { lead, faq, research, nodes } = scene();
    useUi.setState({ focusSessionId: faq.id });
    const fake = mount({
      sessions: [lead, faq, research],
      nodes,
      extra: { 'session.update': (p) => ({ ...faq, title: p.title as string }) },
    });
    fireEvent.doubleClick(await screen.findByRole('heading', { name: 'FAQ を 10 問つくる' }));
    const input = screen.getByRole('textbox', { name: '会話の名前' });
    fireEvent.change(input, { target: { value: 'よくある質問' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(fake.calls.find((c) => c.method === 'session.update')?.params).toMatchObject({ title: 'よくある質問' });
  });
});

describe('<FocusView> flow', () => {
  it('shows the request as a card (no machine text), the attention row above the composer and a queued mark', async () => {
    const { lead, faq, research, nodes, q } = scene();
    const brief = {
      goal: 'よくある質問を 10 問つくってください。\n\n```acc-mock\n{ "steps": [] }\n```',
      doneWhen: ['10 問ある', '回答つき'],
      fromSessionId: lead.id,
      reviewBy: 'none' as const,
      givenAt: iso(T0),
    };
    const first = message(faq, {
      author: { kind: 'agent', sessionId: lead.id, runId: 'run_1' },
      meta: { kind: 'brief', brief },
      content: [{ type: 'text', text: brief.goal }],
    });
    const later = message(faq, { content: [{ type: 'text', text: '価格は載せないで' }], delivery: 'queued', createdAt: iso(T0 + 5000) });
    useUi.setState({ focusSessionId: faq.id });
    mount({
      sessions: [lead, faq, research],
      nodes,
      messages: { [faq.id]: [first, later] },
      snapshot: homeSnapshot({ attention: [q], trees: [homeTree(nodes[0]!, nodes.slice(1))] }),
    });
    const card = await screen.findByRole('region', { name: '依頼' });
    expect(within(card).getByText('よくある質問を 10 問つくってください。')).toBeInTheDocument();
    expect(card.textContent).not.toContain('acc-mock');
    expect(within(card).getAllByRole('listitem')).toHaveLength(2);
    const pinned = await screen.findByRole('region', { name: '出番' });
    expect(within(pinned).getByText('価格を FAQ に載せてよいですか？')).toBeInTheDocument();
    expect(within(pinned).getByRole('button', { name: /載せる/ })).toBeInTheDocument();
    expect(await screen.findByTestId('queued-mark')).toBeInTheDocument();
    // No raw words of the machinery.
    expect(document.body.textContent).not.toMatch(/Orchestrator|Worker|権限/);
  });

  it('marks a request the assistant wrote as from 右腕, and opens the assistant from it', async () => {
    const chat = session({ kind: 'chat', title: 'シネマシティについて' });
    const ask = message(chat, {
      author: { kind: 'system', component: 'assistant' },
      content: [{ type: 'text', text: 'シネマシティについて、話し相手になって' }],
    });
    useUi.setState({ focusSessionId: chat.id });
    mount({
      sessions: [chat],
      nodes: [card({ id: chat.id, title: chat.title, role: 'chat', state: 'idle' })],
      messages: { [chat.id]: [ask] },
      extra: { 'system.assistant': () => ({ sessionId: 'ses_00000000000000000000000099' }) },
    });
    const from = await screen.findByRole('button', { name: '右腕' });
    // Once the assistant's id is known, the line opens its conversation.
    await waitFor(() => {
      fireEvent.click(from);
      expect(useUi.getState().focusSessionId).toBe('ses_00000000000000000000000099');
    });
  });

  it('shows the model of a child conversation and of each reply', async () => {
    const { lead, faq, research, nodes } = scene();
    const child = { ...faq, model: 'openai/gpt-6-luna' };
    const reply = message(child, {
      role: 'assistant',
      model: 'openai/gpt-6-luna',
      author: { kind: 'agent', sessionId: child.id, runId: 'run_1' },
      content: [{ type: 'text', text: '10 問できました' }],
    });
    useUi.setState({ focusSessionId: child.id });
    mount({ sessions: [lead, child, research], nodes, messages: { [child.id]: [reply] } });
    expect(await screen.findByRole('button', { name: /gpt-6-luna/ })).toBeInTheDocument();
    expect(await screen.findByTestId('message-model')).toHaveTextContent('gpt-6-luna');
  });

  it('shows the model beside the cost; the roster first, and a word on changing it mid-conversation', async () => {
    const chat = session({ kind: 'chat', title: '相談', model: null });
    const models = {
      'settings.get': () => ({
        defaultModel: 'openai/gpt-6-luna',
        modelRules: [{ model: 'anthropic/claude-sonnet-5-5', when: '画面の設計' }],
      }),
      'models.list': () => ({
        models: [
          { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic', price: { inputPerMTok: 5, outputPerMTok: 25 } },
          { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', provider: 'chatgpt', price: null },
          { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic', price: { inputPerMTok: 3, outputPerMTok: 15 } },
        ],
        source: 'providers',
      }),
      'session.update': (p: unknown) => ({ ...chat, model: (p as { model: string }).model }),
    };
    useUi.setState({ focusSessionId: chat.id, modelPickerOpen: false });
    const fake = mount({
      sessions: [chat],
      nodes: [card({ id: chat.id, title: chat.title, role: 'chat', state: 'idle' })],
      messages: { [chat.id]: [message(chat)] },
      extra: models,
    });
    const chip = await screen.findByRole('button', { name: /gpt-6-luna/ });
    expect(chip.closest('[data-focus-header]')).not.toBeNull();
    act(() => useUi.getState().setModelPickerOpen(true));
    await waitFor(() =>
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
        expect.stringContaining('Claude Sonnet 5.5'),
        expect.stringContaining('GPT-6 Luna'),
        expect.stringContaining('Claude Opus 5.5'),
      ]),
    );
    expect(screen.getAllByRole('option')[1]).toHaveTextContent('契約枠');
    // The conversation has started: changing the model now costs a fresh read.
    expect(await screen.findByTestId('model-note')).toHaveTextContent('費用が増えます');
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Claude Opus 5.5/ }));
    });
    const updates = fake.calls.filter((c) => c.method === 'session.update').map((c) => c.params);
    expect(updates).toEqual([{ sessionId: chat.id, model: 'anthropic/claude-opus-5-5' }]);
  });

  it('names the model that answered an agent conversation, and offers only what Claude Code runs', async () => {
    // Made before the fix: the chat default (GPT) stuck to it, but Claude Code answered.
    const agent = session({ kind: 'agent', title: '直して', model: 'openai/gpt-6-luna' });
    const reply = message(agent, {
      role: 'assistant',
      model: 'claude-opus-5-5',
      author: { kind: 'agent', sessionId: agent.id, runId: 'run_1' },
      content: [{ type: 'text', text: '直しました' }],
    });
    useUi.setState({ focusSessionId: agent.id, modelPickerOpen: false });
    mount({
      sessions: [agent],
      nodes: [card({ id: agent.id, title: agent.title, role: 'agent', state: 'idle' })],
      messages: { [agent.id]: [reply] },
      extra: {
        'settings.get': () => ({
          defaultModel: 'openai/gpt-6-luna',
          modelRules: [],
          litellm: { baseUrl: null, hasApiKey: false, apiKeyMasked: null },
          agentRuntime: { configured: null, effective: 'claude-agent-sdk', detected: 'claude-agent-sdk' },
        }),
        'models.list': () => ({
          models: [
            { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', provider: 'chatgpt', price: null },
            { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic', price: null },
          ],
          source: 'providers',
        }),
      },
    });
    const chip = await screen.findByRole('button', { name: /opus/ });
    expect(chip.closest('[data-focus-header]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /gpt-6-luna/ })).toBeNull();
    act(() => useUi.getState().setModelPickerOpen(true));
    await waitFor(() =>
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
        expect.stringContaining('Claude Code の既定'),
        expect.stringContaining('Claude Sonnet 5.5'),
      ]),
    );
  });

  it('shows the answer being written when opened mid-stream', async () => {
    const chat = session({ kind: 'chat', title: 'ブログ記事', state: 'working' });
    const ask = message(chat, { content: [{ type: 'text', text: 'ブログを書いて' }] });
    useUi.setState({ focusSessionId: chat.id });
    mount({
      sessions: [chat],
      nodes: [card({ id: chat.id, title: chat.title, role: 'chat', state: 'working' })],
      messages: { [chat.id]: [ask] },
      streaming: { messageId: 'msg_stream', runId: 'run_stream', text: 'リモートワークを 1 年続けて', reasoning: '' },
    });
    expect(await screen.findByText(/リモートワークを 1 年続けて/)).toBeInTheDocument();
  });

  it('opens the draft when no conversation is open', async () => {
    mount({ sessions: [], nodes: [card()] });
    expect(await screen.findByRole('textbox', { name: 'メッセージ' })).toBeInTheDocument();
  });
});

describe('treeControl', () => {
  const base = { state: 'idle' as const, activeRunId: null, supervision: 'active' as const };
  it('offers stop while anything in the tree moves, resume when something was stopped', () => {
    expect(treeControl(base, [])).toBeNull();
    expect(treeControl({ ...base, state: 'supervising' }, [])).toBe('stop');
    expect(treeControl(base, [{ state: 'queued' }])).toBe('stop');
    expect(treeControl({ ...base, activeRunId: 'run_1' }, [])).toBe('stop');
    expect(treeControl({ ...base, state: 'stopped' }, [{ state: 'done' }])).toBe('resume');
    expect(treeControl(base, [{ state: 'stopped' }, { state: 'done' }])).toBe('resume');
    expect(treeControl({ ...base, supervision: 'paused' }, [])).toBe('resume');
  });
});

describe('<FocusView> resume', () => {
  it('resumes a stopped tree', async () => {
    const s = session({ kind: 'agent', title: '止めた作業', state: 'stopped' });
    useUi.setState({ focusSessionId: s.id });
    const fake = mount({
      sessions: [s],
      nodes: [card({ id: s.id, title: s.title, state: 'stopped' })],
      extra: { 'session.resume': () => ({ resumedSessionIds: [s.id], runIds: [] }) },
    });
    const btn = await screen.findByRole('button', { name: '再開' });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() =>
      expect(fake.calls.find((c) => c.method === 'session.resume')?.params).toMatchObject({ sessionId: s.id, tree: true }),
    );
  });
});

describe('agentModelView', () => {
  const claude = { configured: null, effective: 'claude-agent-sdk', detected: 'claude-agent-sdk' };
  const settings = { litellm: { baseUrl: null, hasApiKey: false, apiKeyMasked: null }, agentRuntime: claude };
  const answered = [{ role: 'assistant' as const, model: 'claude-opus-5-5' }];

  it('names Claude Code’s default until something answers, then the model that did', () => {
    expect(agentModelView({ model: null, runtime: null }, settings, [])).toMatchObject({
      value: null,
      fallback: null,
      autoLabel: 'Claude Code の既定',
    });
    expect(agentModelView({ model: null, runtime: null }, settings, answered).fallback).toBe(
      'claude-opus-5-5',
    );
  });

  it('never shows a model Claude Code cannot run as the conversation’s', () => {
    const v = agentModelView({ model: 'openai/gpt-6.1-sol', runtime: null }, settings, answered);
    expect(v.value).toBeNull();
    expect(v.fallback).toBe('claude-opus-5-5');
    expect(v.allow?.('openai/gpt-6.1-sol')).toBe(false);
    expect(v.allow?.('anthropic/claude-sonnet-5-5')).toBe(true);
    expect(agentModelView({ model: 'claude-sonnet-5-5', runtime: null }, settings, []).value).toBe(
      'claude-sonnet-5-5',
    );
  });

  it('says the mock answers when it does, whatever model is named', () => {
    const v = agentModelView({ model: 'claude-sonnet-5-5', runtime: 'mock' }, settings, [
      { role: 'assistant', model: 'mock/mock-agent' },
    ]);
    expect(v).toMatchObject({ value: null, fallback: 'mock/mock-agent', autoLabel: 'モック' });
    expect(v.allow).toBeUndefined();
  });
});
