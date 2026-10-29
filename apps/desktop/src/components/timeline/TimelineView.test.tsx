import type { Event, Run, Session } from '@acc/protocol';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { EMPTY_FILTERS } from '../../model/timeline';
import { useTimeline } from '../../store/timeline';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { attention, event, homeSnapshot, message, run, session } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { TimelineView } from './TimelineView';

const lead = session({ title: 'ローンチ準備', kind: 'chat' });
const faq = session({ title: 'FAQ 担当', parentSessionId: lead.id });
const other = session({ title: 'お詫びメール', kind: 'chat' });

function story() {
  const r1 = run(lead, { kind: 'orchestrator', status: 'completed' });
  const rf = run(faq, { status: 'running', trigger: 'spawn' });
  const ask = message(lead, { content: [{ type: 'text', text: '発売の準備を進めて' }] });
  const faqSays = message(faq, { role: 'assistant', runId: rf.id, author: { kind: 'agent', sessionId: faq.id, runId: rf.id }, content: [{ type: 'text', text: '価格を確かめます' }] });
  const events: Event[] = [
    event('message.created', { message: ask }, { sessionId: lead.id }),
    event('run.created', { run: r1 }, { sessionId: lead.id, runId: r1.id }),
    event('tool.called', { runId: r1.id, toolCallId: 'a', name: 'session.spawn', input: { title: 'FAQ 担当' } }, { sessionId: lead.id, runId: r1.id }),
    event('run.created', { run: rf }, { sessionId: faq.id, runId: rf.id }),
    event('message.created', { message: faqSays }, { sessionId: faq.id, runId: rf.id }),
    event('tool.called', { runId: r1.id, toolCallId: 'b', name: 'session.spawn', input: { title: '告知メール' } }, { sessionId: lead.id, runId: r1.id }),
    event('attention.opened', { attention: attention({ id: faq.id, rootSessionId: lead.id }, { title: '価格を載せる？' }) }, { sessionId: faq.id }),
    event('message.created', { message: message(other, { content: [{ type: 'text', text: 'お詫びを書いて' }] }) }, { sessionId: other.id }),
  ];
  return { events, runs: [r1, rf], ask, faqSays, r1 };
}

function mount(events: Event[], sessions: Session[], runs: Run[]) {
  const fake = createFakeClient({
    'system.info': () => ({ stats: { lastEventSeq: events[events.length - 1]?.seq ?? 0 } }),
    'events.list': () => ({ events, lastSeq: events[events.length - 1]?.seq ?? 0, hasMore: false }),
    'session.list': () => ({ items: sessions, nextCursor: null }),
    'run.list': () => ({ items: runs, nextCursor: null }),
    'home.get': () => homeSnapshot(),
  });
  render(
    <RuntimeProvider runtime={createRuntime(fake.client)}>
      <TooltipProvider>
        <TimelineView />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return fake;
}

beforeEach(() => {
  localStorage.clear();
  useTimeline.setState({ filters: EMPTY_FILTERS, showAll: false, openRuns: {}, unfolded: {} });
  useUi.setState({ mode: 'timeline', focusSessionId: null, timelineSelected: null, jumpTo: null });
});

describe('<TimelineView>', () => {
  it('groups the human moments by tree, newest tree first, and leaves the runs out', async () => {
    const s = story();
    mount(s.events, [lead, faq, other], s.runs);
    await screen.findByRole('region', { name: 'ローンチ準備' });
    const groups = screen.getAllByRole('region');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['お詫びメール', 'ローンチ準備']);
    const launch = groups[1]!;
    expect(within(launch).getByText('発売の準備を進めて')).toBeInTheDocument();
    expect(within(launch).getByText('価格を載せる？')).toBeInTheDocument();
    // The child is named by its chip; the root's own rows need none.
    expect(within(launch).getAllByRole('button', { name: 'FAQ 担当' })).toHaveLength(1);
    expect(document.querySelector('[data-tl-row^="r"]')).toBeNull();
  });

  it('jumps to the message a row came from', async () => {
    const s = story();
    mount(s.events, [lead, faq, other], s.runs);
    await screen.findByRole('region', { name: 'ローンチ準備' });
    fireEvent.click(screen.getByText('価格を載せる？'));
    expect(useUi.getState()).toMatchObject({ mode: 'session', focusSessionId: faq.id });
    expect(useUi.getState().jumpTo).toMatchObject({ sessionId: faq.id, messageId: s.faqSays.id });
  });

  it('shows each run as one unit with 詳細, and opens it for its steps', async () => {
    const s = story();
    mount(s.events, [lead, faq, other], s.runs);
    fireEvent.click(await screen.findByRole('button', { name: '詳細' }));
    const runRows = document.querySelectorAll(`[data-tl-row="r${s.r1.id}"]`);
    // Two spawn calls with another run in between: still one row.
    expect(runRows).toHaveLength(1);
    expect(screen.queryByText('「告知メール」に依頼')).toBeNull();
    fireEvent.click(runRows[0]!);
    const steps = within(runRows[0]!.parentElement!).getAllByRole('option').slice(1);
    expect(steps.map((r) => r.getAttribute('aria-label'))).toEqual(['ツール: 「FAQ 担当」に依頼', 'ツール: 「告知メール」に依頼']);
  });

  it('moves with J / K and opens with Enter', async () => {
    const s = story();
    mount(s.events, [lead, faq, other], s.runs);
    await screen.findByText('お詫びを書いて');
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'j' });
    expect(useUi.getState().timelineSelected).toBe(`m${s.events[0]!.seq}`);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(useUi.getState().jumpTo).toMatchObject({ sessionId: lead.id, messageId: s.ask.id });
  });

  it('narrows with the search, says so when nothing matches, and clears in one press', async () => {
    const s = story();
    mount(s.events, [lead, faq, other], s.runs);
    const box = await screen.findByRole('textbox', { name: '絞り込み' });
    fireEvent.change(box, { target: { value: 'お詫び' } });
    expect(screen.getAllByRole('region').map((g) => g.getAttribute('aria-label'))).toEqual(['お詫びメール']);
    fireEvent.change(box, { target: { value: 'ありえない語' } });
    expect(screen.getByText('条件に合う出来事はありません')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '絞り込みを外す' }));
    expect(screen.getAllByRole('region')).toHaveLength(2);
  });

  it('is one quiet line when nothing happened yet', async () => {
    mount([], [], []);
    expect(await screen.findByText('まだ出来事はありません')).toBeInTheDocument();
  });
});
