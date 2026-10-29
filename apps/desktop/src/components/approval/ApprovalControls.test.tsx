import type { Approval, PermissionRule } from '@acc/protocol';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { resetKeyDecisions } from '../../lib/approvalKeys';
import { createFakeClient } from '../../test/fakeClient';
import { approval, id, iso, run, session, T0 } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { InlineApproval } from './ApprovalControls';

function mount(a: Approval, handlers: Parameters<typeof createFakeClient>[0] = {}) {
  const fake = createFakeClient(handlers);
  const rt = createRuntime(fake.client);
  render(
    <RuntimeProvider runtime={rt}>
      <TooltipProvider>
        <InlineApproval approval={a} />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return { fake, rt };
}

const s = session({ projectId: id('prj'), taskId: id('tsk') });
const r = run(s, { status: 'awaiting_approval' });

describe('approval card: remember', () => {
  beforeEach(() => resetKeyDecisions());

  it('A opens the scope choice; 3 approves and remembers for the project', async () => {
    const a = approval(r, { payload: { toolName: 'Bash', input: { command: 'pnpm add zod' }, reason: '新しい依存の追加はこのプロジェクトでは確認が必要（zod）' } });
    let responded: Record<string, unknown> | null = null;
    mount(a, {
      'approval.respond': (p) => {
        responded = p;
        return { ...a, status: 'approved' };
      },
    });
    // The card says why it asks (approvals are rare).
    expect(screen.getByText(/新しい依存の追加はこのプロジェクトでは確認が必要/)).toBeInTheDocument();
    const card = document.querySelector<HTMLElement>(`[data-approval="${a.id}"]`)!;
    card.focus();
    fireEvent.keyDown(card, { key: 'a' });
    const chooser = await screen.findByTestId('remember-chooser');
    expect(chooser).toHaveTextContent('この Run');
    expect(chooser).toHaveTextContent('この Task');
    expect(chooser).toHaveTextContent('このプロジェクト');
    // The first scope takes focus: Enter would approve for this run.
    expect(document.activeElement).toHaveAttribute('data-remember', 'run');
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: '3' });
    });
    expect(responded).toMatchObject({ approvalId: a.id, decision: 'approve', remember: 'project' });
  });

  it('Esc closes the choice without deciding; a plain Y approves only this use', async () => {
    const a = approval(r);
    let responded: Record<string, unknown> | null = null;
    mount(a, {
      'approval.respond': (p) => {
        responded = p;
        return { ...a, status: 'approved' };
      },
    });
    const card = document.querySelector<HTMLElement>(`[data-approval="${a.id}"]`)!;
    card.focus();
    fireEvent.keyDown(card, { key: 'a' });
    await screen.findByTestId('remember-chooser');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('remember-chooser')).not.toBeInTheDocument());
    expect(responded).toBeNull();
    card.focus();
    await act(async () => {
      fireEvent.keyDown(card, { key: 'y' });
    });
    expect(responded).toMatchObject({ decision: 'approve' });
    expect(responded).not.toHaveProperty('remember');
  });

  it('offers no remembering for high-risk uses', () => {
    const a = approval(r, { payload: { toolName: 'Bash', input: { command: 'git push origin main' } } });
    mount(a);
    expect(screen.getByRole('button', { name: /承認（要注意）/ })).toBeInTheDocument();
    expect(screen.queryByTestId('approve-always')).not.toBeInTheDocument();
  });

  it('a resolved approval says what the daemon remembered', async () => {
    const a = approval(r, { status: 'approved', resolvedAt: iso(T0 + 2000) });
    const rule: PermissionRule = {
      id: 'prl_00000000000000000000000001',
      projectId: s.projectId!,
      scope: 'task',
      runId: null,
      taskId: s.taskId,
      toolName: 'Bash',
      commandKeys: ['pnpm test'],
      pathPrefix: null,
      description: 'コマンド「pnpm test」を許可',
      approvalId: a.id,
      createdBy: { kind: 'human', client: 'test' },
      createdAt: iso(T0 + 2000),
      revokedAt: null,
      revokedBy: null,
    };
    mount(a, { 'permissionRule.list': () => ({ items: [rule] }) });
    expect(await screen.findByTestId('remembered-scope')).toHaveTextContent('この Task では今後も許可');
  });
});
