import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { lexer } from 'marked';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { qk } from '../../daemon/keys';
import { useStickToBottom } from '../../hooks/useStickToBottom';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { type ChatBlock, buildChatBlocks, lastUnanswered, stabilizeBlocks } from '../../model/chat';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { T0, iso, message, run, session } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { ChatStream } from './ChatStream';
import { Composer } from './Composer';
import { lexIncremental } from './Markdown';

const SETTINGS = {
  litellm: { baseUrl: null, hasApiKey: false, apiKeyMasked: null },
  defaultModel: null,
  maxConcurrentRuns: 10,
  maxDelegationDepth: 1,
};

describe('incremental markdown lexing (streaming)', () => {
  it('produces the same blocks as lexing the whole text, frame after frame', () => {
    const full = [
      '# 見出し',
      '',
      '最初の段落です。',
      '',
      '- 項目 1',
      '- 項目 2',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '',
      '最後の段落',
      '===',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\n');
    let cache = null;
    for (let i = 1; i <= full.length; i += 3) {
      const text = full.slice(0, i);
      cache = lexIncremental(text, cache);
      const want = lexer(text, { gfm: true, breaks: true }).map((t) => [t.type, t.raw]);
      expect(cache.tokens.map((t) => [t.type, t.raw])).toEqual(want);
    }
  });
});

describe('chat blocks', () => {
  it('keeps unchanged blocks identical so they do not re-render on every frame', () => {
    const s = session({ kind: 'chat' });
    const msgs = [
      message(s, { content: [{ type: 'text', text: '質問' }], createdAt: iso(T0) }),
      message(s, { role: 'assistant', content: [{ type: 'text', text: '答え' }], createdAt: iso(T0 + 1) }),
    ];
    const prev = new Map<string, ChatBlock>();
    const a = stabilizeBlocks(prev, buildChatBlocks({ messages: msgs, approvals: [], streaming: [], runs: [] }));
    const b = stabilizeBlocks(prev, buildChatBlocks({ messages: [...msgs], approvals: [], streaming: [], runs: [] }));
    expect(b[0]).toBe(a[0]);
    expect(b[1]).toBe(a[1]);
  });

  it('finds the last message nothing answered yet', () => {
    const s = session({ kind: 'chat' });
    const q = message(s, { content: [{ type: 'text', text: '質問' }] });
    const ans = message(s, { role: 'assistant', content: [{ type: 'text', text: '答え' }] });
    expect(lastUnanswered([q])).toBe(q);
    expect(lastUnanswered([q, ans])).toBeNull();
    const fromAi = message(s, { author: { kind: 'agent', sessionId: s.id, runId: 'run_x' } });
    expect(lastUnanswered([fromAi])).toBeNull();
  });
});

function mountChat(s: ReturnType<typeof session>, msgs: ReturnType<typeof message>[], runs: ReturnType<typeof run>[] = []) {
  const sent: unknown[] = [];
  const cancelled: unknown[] = [];
  const fake = createFakeClient({
    'session.messages': () => ({ items: msgs, hasMore: false }),
    'run.list': () => ({ items: runs, nextCursor: null }),
    'session.list': () => ({ items: [s], nextCursor: null }),
    'settings.get': () => SETTINGS,
    'session.send': (p) => {
      sent.push(p);
      return { messageId: 'msg_00000000000000000000000099', runId: 'run_00000000000000000000000099' };
    },
    'run.cancel': (p) => {
      cancelled.push(p);
      return { ...runs[0], status: 'cancelled' };
    },
  });
  const rt = createRuntime(fake.client);
  rt.queryClient.setQueryData(qk.runs, runs);
  function Chat() {
    const stick = useStickToBottom();
    return <ChatStream session={s} stick={stick} />;
  }
  render(
    <RuntimeProvider runtime={rt}>
      <TooltipProvider>
        <Chat />
        <Composer session={s} activeRun={runs[0] ?? null} onSent={() => {}} />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return { sent, cancelled, rt };
}

// jsdom has no layout: give the virtualized chat a viewport so it renders its rows.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
});
afterAll(() => {
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

describe('edit and resend (↑ in an empty composer)', () => {
  beforeEach(() => {
    useUi.setState({ drafts: {}, editing: null, superseded: {}, suggestions: {} });
  });

  it('loads the last unanswered message, stops its run and sends the edited text', async () => {
    const s = session({ kind: 'chat' });
    const q = message(s, { content: [{ type: 'text', text: 'README を要約して' }] });
    const r = run(s, { kind: 'chat', status: 'running', triggerMessageId: q.id });
    const { sent, cancelled } = mountChat(s, [q], [r]);
    const input = await screen.findByLabelText('メッセージ');
    await screen.findByText('README を要約して');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByTestId('editing-banner')).toBeInTheDocument();
    expect(input).toHaveValue('README を要約して');

    fireEvent.change(input, { target: { value: 'README を 3 行で要約して' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(cancelled).toEqual([expect.objectContaining({ runId: r.id })]);
    expect(sent[0]).toMatchObject({ content: 'README を 3 行で要約して' });
    // The original stays in history, folded as "編集前".
    expect(await screen.findByText('編集前:')).toBeInTheDocument();
    expect(screen.queryByTestId('editing-banner')).not.toBeInTheDocument();
  });

  it('Esc cancels the edit and leaves an empty composer', async () => {
    const s = session({ kind: 'chat' });
    const q = message(s, { content: [{ type: 'text', text: '質問' }] });
    mountChat(s, [q]);
    const input = await screen.findByLabelText('メッセージ');
    await screen.findByText('質問');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveValue('質問');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('');
    expect(screen.queryByTestId('editing-banner')).not.toBeInTheDocument();
  });

  it('does nothing once the message was answered', async () => {
    const s = session({ kind: 'chat' });
    const q = message(s, { content: [{ type: 'text', text: '質問' }], createdAt: iso(T0) });
    const a = message(s, { role: 'assistant', content: [{ type: 'text', text: '答え' }], createdAt: iso(T0 + 5) });
    mountChat(s, [q, a]);
    const input = await screen.findByLabelText('メッセージ');
    await screen.findByText('答え');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveValue('');
  });
});

describe('assistant messages', () => {
  it('fold reasoning to one line and offer copy', async () => {
    const s = session({ kind: 'chat' });
    const a = message(s, {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'まず要件を整理する。' },
        { type: 'text', text: '結論です。' },
      ],
    });
    mountChat(s, [a]);
    const toggle = await screen.findByRole('button', { name: /思考過程/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('まず要件を整理する。')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText('まず要件を整理する。')).toBeInTheDocument();
    const answer = screen.getByText('結論です。').closest('.group\\/msg') as HTMLElement;
    expect(within(answer).getByRole('button', { name: 'コピー' })).toBeInTheDocument();
  });
});
