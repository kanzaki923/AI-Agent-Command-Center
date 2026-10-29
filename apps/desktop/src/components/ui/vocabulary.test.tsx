import { fireEvent, render, screen, within } from '@testing-library/react';
import { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { qk } from '../../daemon/keys';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { attention, card, homeSnapshot, homeTree, iso } from '../../test/fixtures';
import { AttentionRow, attentionKeyAction, choiceKey } from './AttentionRow';
import { CostMeter } from './CostMeter';
import { Elapsed } from './Elapsed';
import { OutputIcon, RoleIcon } from './SemanticIcons';
import { SessionChip } from './SessionChip';
import { StateIcon } from './StateIcon';
import { TooltipProvider } from './Tooltip';

function wrap(children: ReactNode, handlers: Parameters<typeof createFakeClient>[0] = {}) {
  const fake = createFakeClient({ 'home.get': () => homeSnapshot(), ...handlers });
  const rt = createRuntime(fake.client);
  const utils = render(
    <RuntimeProvider runtime={rt}>
      <TooltipProvider>{children}</TooltipProvider>
    </RuntimeProvider>,
  );
  return { ...utils, rt, fake };
}

describe('<StateIcon>', () => {
  it('names the state for screen readers and uses its colour', () => {
    render(<StateIcon state="needs_you" />);
    const icon = screen.getByRole('img', { name: 'あなたの出番' });
    expect(icon.style.color).toBe('var(--st-needs_you)');
  });

  it('turns while working, with a still circle for reduced motion', () => {
    const { container } = render(<StateIcon state="working" />);
    expect(container.querySelector('.acc-spin.acc-motion-only')).not.toBeNull();
    expect(container.querySelector('.acc-still-only')).not.toBeNull();
  });
});

describe('<OutputIcon> / <RoleIcon>', () => {
  it('names outputs and roles in the UI words', () => {
    render(
      <>
        <OutputIcon kind="code" />
        <RoleIcon role="supervisor" />
        <RoleIcon role="agent" scheduled />
      </>,
    );
    expect(screen.getByRole('img', { name: '変更' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '任せた会話' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'エージェント（繰り返し）' })).toBeInTheDocument();
  });
});

describe('<SessionChip>', () => {
  it('shows what it is doing now, the time in its state and its spend', () => {
    const c = card({ title: '競合調査', state: 'working', now: 'pricing.md を参照', costUsd: 0.214, stateSince: iso(Date.now() - 4 * 60_000) });
    wrap(<SessionChip card={c} />);
    const chip = screen.getByRole('button', { name: '競合調査（作業中）' });
    expect(chip).toHaveTextContent('pricing.md を参照');
    expect(chip).toHaveTextContent('4分');
    expect(chip).toHaveTextContent('$0.21');
  });

  it('shows the attention it waits on in amber and gets a coloured frame', () => {
    const a = attention({ id: 'x' }, { title: '価格を載せる？' });
    const c = card({ state: 'needs_you', attentionIds: [a.id] });
    wrap(<SessionChip card={c} attention={[a]} />);
    const line = screen.getByText('価格を載せる？');
    expect(line.className).toContain('text-st-needs_you');
    expect(screen.getByRole('button').style.borderColor).toContain('--st-needs_you');
  });

  it('looks the attention up in the home snapshot when not given', async () => {
    const a = attention({ id: 'x' }, { kind: 'failure', title: '顧客リストがない' });
    const c = card({ state: 'failed', attentionIds: [a.id] });
    wrap(<SessionChip card={c} />, { 'home.get': () => homeSnapshot({ attention: [a] }) });
    expect(await screen.findByText('顧客リストがない')).toBeInTheDocument();
  });

  it('shows output kinds when done and the kind name while waiting for review; opens on press', () => {
    const onOpen = vi.fn();
    const done = card({ title: '完了', state: 'done', outputs: [{ id: 'art_1', kind: 'document', title: 'FAQ' }, { id: 'art_2', kind: 'document', title: 'FAQ2' }] });
    const review = card({ title: '確認', state: 'review', outputs: [{ id: 'art_3', kind: 'code', title: '変更' }] });
    wrap(
      <>
        <SessionChip card={done} onOpen={onOpen} />
        <SessionChip card={review} size="sm" />
      </>,
    );
    const d = screen.getByRole('button', { name: '完了（完了）' });
    expect(within(d).getByRole('img', { name: '文書' })).toBeInTheDocument();
    expect(d).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: '確認（確認待ち）' })).toHaveTextContent('変更');
    fireEvent.click(d);
    expect(onOpen).toHaveBeenCalledWith(done.id);
  });

  it('flashes once when it becomes needs_you', () => {
    const c = card({ state: 'working' });
    const { rerender, rt, container } = wrap(<SessionChip card={c} />);
    expect(container.querySelector('.acc-alarm-once')).toBeNull();
    rerender(
      <RuntimeProvider runtime={rt}>
        <TooltipProvider>
          <SessionChip card={{ ...c, state: 'needs_you' }} />
        </TooltipProvider>
      </RuntimeProvider>,
    );
    expect(container.querySelector('.acc-alarm-once')).not.toBeNull();
  });
});

describe('<AttentionRow>', () => {
  const question = attention(
    { id: 'ses_q' },
    {
      title: '価格を FAQ に載せてよいですか？',
      detail: '正式決定は 11/4 です。',
      choices: [
        { id: 'c1', label: '載せる', tone: 'primary' },
        { id: 'c2', label: '載せない', tone: 'neutral' },
      ],
    },
  );

  it('maps keys: 1–4 for choices, Y / N for an approval, Enter for a reply', () => {
    const approval = attention({ id: 's' }, { kind: 'approval', allowText: false, choices: [{ id: 'approve', label: '許可', tone: 'primary' }, { id: 'reject', label: '拒否', tone: 'danger' }] });
    expect(choiceKey(approval, 0)).toBe('Y');
    expect(choiceKey(approval, 1)).toBe('N');
    expect(attentionKeyAction(approval, 'n')).toMatchObject({ kind: 'choice', choice: { id: 'reject' } });
    expect(attentionKeyAction(approval, 'Enter')).toBeNull();
    expect(attentionKeyAction(question, '2')).toMatchObject({ kind: 'choice', choice: { id: 'c2' } });
    expect(attentionKeyAction(question, 'Enter')).toEqual({ kind: 'reply' });
  });

  it('answers with a choice and leaves the home screen at once (optimistic)', async () => {
    let sent: unknown = null;
    const { rt } = wrap(<AttentionRow attention={question} sessionTitle="FAQ 担当" />, {
      'attention.respond': (p) => {
        sent = p;
        return { ...question, status: 'resolved' };
      },
    });
    rt.queryClient.setQueryData(qk.home, homeSnapshot({ attention: [question], trees: [homeTree(card({ id: 'ses_q' }))] }));
    fireEvent.click(screen.getByRole('button', { name: /載せない/ }));
    expect(rt.queryClient.getQueryData<{ attention: unknown[] }>(qk.home)!.attention).toEqual([]);
    await vi.waitFor(() => expect(sent).toEqual({ attentionId: question.id, choiceId: 'c2' }));
  });

  it('opens a reply field, sends the text, shows the detail on demand and opens the conversation', async () => {
    let sent: unknown = null;
    wrap(<AttentionRow attention={question} sessionTitle="FAQ 担当" />, {
      'attention.respond': (p) => {
        sent = p;
        return question;
      },
    });
    expect(screen.queryByText('正式決定は 11/4 です。')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '詳細' }));
    expect(screen.getByText('正式決定は 11/4 です。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /返信/ }));
    const field = screen.getByRole('textbox', { name: '返信' });
    fireEvent.change(field, { target: { value: '仮の価格は伏せて' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await vi.waitFor(() => expect(sent).toEqual({ attentionId: question.id, text: '仮の価格は伏せて' }));
    useUi.setState({ mode: 'home', focusSessionId: null });
    fireEvent.click(screen.getByRole('button', { name: 'FAQ 担当' }));
    expect(useUi.getState()).toMatchObject({ mode: 'session', focusSessionId: 'ses_q' });
  });

  it('offers no detail toggle when the detail only repeats the title', () => {
    const failure = attention({ id: 's' }, { kind: 'failure', title: '顧客リストが見つかりません。', detail: '顧客リストが見つかりません。\n' });
    wrap(<AttentionRow attention={failure} sessionTitle="配信リストの整理" />);
    expect(screen.getByText('顧客リストが見つかりません。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '詳細' })).toBeNull();
  });

  it('answers by key when the row has focus', async () => {
    const onRespond = vi.fn();
    wrap(<AttentionRow attention={question} onRespond={onRespond} compact />);
    const row = screen.getByRole('group');
    row.focus();
    fireEvent.keyDown(row, { key: '1' });
    expect(onRespond).toHaveBeenCalledWith(question, { choiceId: 'c1' });
  });
});

const plain = { wrapper: ({ children }: { children: ReactNode }) => <TooltipProvider>{children}</TooltipProvider> };

describe('<CostMeter>', () => {
  it('shows amount, meter and limit; amber over 80%, red at the limit', () => {
    const { rerender } = render(<CostMeter usedUsd={3.2} limitUsd={20} />, plain);
    const m = screen.getByRole('meter', { name: '予算' });
    expect(m).toHaveTextContent('$3.20');
    expect(m).toHaveTextContent('$20');
    expect(m.dataset.tone).toBe('ok');
    rerender(<CostMeter usedUsd={17} limitUsd={20} />);
    expect(screen.getByRole('meter').dataset.tone).toBe('warn');
    rerender(<CostMeter usedUsd={20} limitUsd={20} />);
    expect(screen.getByRole('meter').dataset.tone).toBe('over');
  });

  it('shows what children still hold as a paler stretch that sets the tone', () => {
    const { container } = render(<CostMeter usedUsd={3.03} limitUsd={3.4} committedUsd={3.4} />, plain);
    const m = screen.getByRole('meter');
    expect(m).toHaveTextContent('$3.03');
    expect(m.dataset.tone).toBe('over');
    expect(m.getAttribute('aria-valuetext')).toBe('$3.03 / $3.40・子に渡した分 $0.37');
    expect(container.querySelector('[data-meter-held]')).not.toBeNull();
  });

  it('shows only the amount without a limit, and nothing for nothing', () => {
    const { container, rerender } = render(<CostMeter usedUsd={0.5} limitUsd={null} />, plain);
    expect(container).toHaveTextContent('$0.50');
    rerender(<CostMeter usedUsd={0} limitUsd={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('<Elapsed>', () => {
  it('reads ongoing and finished times, nothing without a start', () => {
    const { container, rerender } = render(<Elapsed since={iso(Date.now() - 2 * 3600_000)} settled={false} />, plain);
    expect(container).toHaveTextContent('2時間');
    // The 30s ticker may be up to 30s behind.
    rerender(<Elapsed since={iso(Date.now() - 12 * 60_000 - 40_000)} settled />);
    expect(container).toHaveTextContent('12分前');
    rerender(<Elapsed since={null} settled />);
    expect(container.textContent).toBe('');
  });
});
