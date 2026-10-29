import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { approval, card, iso, run, session, T0 } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { ApprovalLine, BriefCard, WakeCard, pathTail } from './Cards';

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
