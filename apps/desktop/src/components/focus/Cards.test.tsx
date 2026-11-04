import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { approval, card, iso, run, session, T0 } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { ApprovalLine, BriefCard, PlanCard, WakeCard, pathTail } from './Cards';

function wrap(node: React.ReactNode) {
  return render(
    <RuntimeProvider runtime={createRuntime(createFakeClient().client)}>
      <TooltipProvider>{node}</TooltipProvider>
    </RuntimeProvider>,
  );
}

beforeEach(() => useUi.setState({ mode: 'session', focusSessionId: null }));

describe('<WakeCard>', () => {
  it('is one line of changes; opened, each child is a row that goes there', () => {
    wrap(
      <WakeCard
        items={[
          { sessionId: 'ses_a', title: 'プレスリリース案', change: 'done', artifactIds: [] },
          { sessionId: 'ses_b', title: 'FAQ を 10 問つくる', change: 'needs_you', artifactIds: [] },
        ]}
      />,
    );
    const card = screen.getByRole('region', { name: '状況' });
    const head = within(card).getByRole('button', { expanded: false });
    expect(head).toHaveTextContent('プレスリリース案');
    expect(within(head).getByRole('img', { name: '完了' })).toBeInTheDocument();
    expect(within(head).getByRole('img', { name: 'あなたの出番' })).toBeInTheDocument();
    fireEvent.click(head);
    fireEvent.click(within(within(card).getByRole('list')).getByRole('button', { name: /FAQ を 10 問つくる/ }));
    expect(useUi.getState().focusSessionId).toBe('ses_b');
  });
});

describe('<BriefCard>', () => {
  const brief = { goal: '表にまとめて', doneWhen: ['3 社'], fromSessionId: null, reviewBy: 'none' as const, givenAt: iso(T0) };
  it('checks the conditions once the outputs are delivered', () => {
    const { rerender } = wrap(<BriefCard brief={brief} card={card({ state: 'working' })} workspaceId={null} />);
    expect(screen.getByRole('listitem')).not.toHaveAttribute('data-done');
    rerender(
      <RuntimeProvider runtime={createRuntime(createFakeClient().client)}>
        <TooltipProvider>
          <BriefCard
            brief={brief}
            card={card({ state: 'done', outputs: [{ id: 'art_1', kind: 'data', title: '比較表' }] })}
            workspaceId={null}
          />
        </TooltipProvider>
      </RuntimeProvider>,
    );
    expect(screen.getByRole('listitem')).toHaveAttribute('data-done', 'true');
  });
});

describe('<ApprovalLine>', () => {
  it('keeps only the decision and what it was about', () => {
    const s = session();
    const a = approval(run(s), { status: 'rejected', resolvedAt: iso(T0 + 60_000) });
    wrap(<ApprovalLine approval={a} />);
    expect(screen.getByText('拒否')).toBeInTheDocument();
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
  });
});

describe('pathTail', () => {
  it('names a folder by its last segment', () => {
    expect(pathTail('C:\\work\\market\\')).toBe('market');
    expect(pathTail('/home/me/docs')).toBe('docs');
  });
});

describe('<PlanCard>', () => {
  it('lists each child with its live state and request; a row goes to the child', () => {
    const kid = card({ id: 'ses_kid', title: 'FAQ を書く', state: 'needs_you', parentId: 'ses_root', depth: 1 });
    const other = card({ title: '告知文', state: 'working', parentId: 'ses_root', depth: 1 });
    const call = (id: string, input: unknown, output: unknown = null) => ({
      id,
      name: 'mcp__acc__session__spawn',
      input,
      output,
      done: output != null,
      isError: false,
      desc: { category: 'control' as const, label: '', activity: '', target: null, additions: null, deletions: null },
      at: iso(T0),
      endedAt: null,
      decision: null,
    });
    wrap(
      <PlanCard
        rationale="互いに待ち合わせずに進められる作業なので、同時に任せます。"
        spawns={[
          call(
            't1',
            { title: 'FAQ', goal: '質問 5 つと回答', doneWhen: ['5 組ある'], workspace: { kind: 'worktree', projectId: 'p' } },
            JSON.stringify({ session: { id: 'ses_kid' } }),
          ),
          call('t2', { title: '告知文', goal: '300 字程度' }),
          call('t3', { title: 'まだ', goal: '…' }),
        ]}
        children={[kid, other]}
      />,
    );
    const plan = screen.getByRole('region', { name: '計画' });
    expect(plan).toHaveTextContent('3 人に任せる');
    expect(plan).toHaveTextContent('互いに待ち合わせずに');
    const rows = within(plan).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    // Row 1 found its child by the spawn result (title from the tree), row 2 by title, row 3 is still queued.
    expect(within(rows[0]!).getByRole('img', { name: 'あなたの出番' })).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('FAQ を書く');
    expect(rows[0]).toHaveTextContent('質問 5 つと回答');
    expect(within(rows[0]!).getByRole('img', { name: 'コード' })).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('img', { name: '作業中' })).toBeInTheDocument();
    expect(within(rows[2]!).getByRole('img', { name: '順番待ち' })).toBeInTheDocument();
    expect(within(rows[2]!).getByRole('button')).toBeDisabled();
    fireEvent.click(within(rows[0]!).getByRole('button'));
    expect(useUi.getState().focusSessionId).toBe('ses_kid');
  });
});

describe('speakers (children with a persona)', () => {
  const call = (id: string, input: unknown, output: unknown = null) => ({
    id,
    name: 'mcp__acc__session__spawn',
    input,
    output,
    done: output != null,
    isError: false,
    desc: { category: 'control' as const, label: '', activity: '', target: null, additions: null, deletions: null },
    at: iso(T0),
    endedAt: null,
    decision: null,
  });

  it('a wake shows what each speaker said, by name; other changes stay one line', () => {
    wrap(
      <WakeCard
        items={[
          { sessionId: 'ses_m', title: 'ミナト', change: 'done', artifactIds: [], reply: { text: 'まず小さく試しましょう。', cut: false } },
          { sessionId: 'ses_s', title: 'サエ', change: 'done', artifactIds: [], reply: { text: '費用が気になります。', cut: true } },
          { sessionId: 'ses_x', title: '下調べ', change: 'failed', artifactIds: [] },
        ]}
      />,
    );
    const spoken = screen.getByRole('region', { name: '発言' });
    expect(spoken).toHaveTextContent('まず小さく試しましょう。');
    expect(spoken).toHaveTextContent('費用が気になります。');
    expect(screen.getByRole('region', { name: '状況' })).toHaveTextContent('下調べ');
    // A cut turn offers the rest in the speaker's own conversation; the name goes there too.
    fireEvent.click(within(spoken).getByRole('button', { name: '続きを読む' }));
    expect(useUi.getState().focusSessionId).toBe('ses_s');
    fireEvent.click(within(spoken).getByRole('button', { name: 'ミナト' }));
    expect(useUi.getState().focusSessionId).toBe('ses_m');
  });

  it('starting speakers is a cast: who talks and who each plays', () => {
    const minato = card({ id: 'ses_m', title: 'ミナト', role: 'speaker', parentId: 'ses_root', depth: 1 });
    wrap(
      <PlanCard
        rationale={null}
        spawns={[
          call('t1', { title: 'ミナト', goal: '最初の意見', mode: 'chat', persona: '前のめりな企画屋。' }, JSON.stringify({ session: { id: 'ses_m' } })),
          call('t2', { title: 'サエ', goal: '最初の意見', mode: 'chat', persona: '慎重なレビュアー。' }),
        ]}
        children={[minato]}
      />,
    );
    const cast = screen.getByRole('region', { name: '話し手' });
    expect(cast).toHaveTextContent('2 人で話す');
    const rows = within(cast).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('前のめりな企画屋。');
    expect(rows[1]).toHaveTextContent('慎重なレビュアー。');
    expect(screen.queryByRole('region', { name: '計画' })).toBeNull();
    // A speaker made on the spot can be kept on the roster.
    expect(within(rows[0]!).getByRole('button', { name: /名簿に残す/ })).toBeInTheDocument();
    fireEvent.click(within(rows[0]!).getAllByRole('button')[0]!);
    expect(useUi.getState().focusSessionId).toBe('ses_m');
  });

  it("a speaker's request card says who it plays", () => {
    const brief = { goal: '最初の意見を', doneWhen: [], fromSessionId: null, reviewBy: 'none' as const, givenAt: iso(T0) };
    wrap(
      <BriefCard
        brief={brief}
        card={null}
        workspaceId={null}
        speaker={{ title: 'サエ', persona: '慎重なレビュアー。', tone: 1 }}
      />,
    );
    expect(screen.getByRole('region', { name: '依頼' })).toHaveTextContent('慎重なレビュアー。');
  });
});
