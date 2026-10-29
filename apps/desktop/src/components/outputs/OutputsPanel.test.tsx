import type { Artifact, Integration, Session, SessionCard } from '@acc/protocol';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { T0, card, integration, iso, session } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { output } from './fixtures';
import { OutputsPanel } from './OutputsPanel';
import { TABLE_ROWS } from './OutputViewer';

const ROOT = 'ses_00000000000000000000000001';
const CHILD = 'ses_00000000000000000000000002';
const pending = { state: 'pending' as const, by: null, at: null, note: null };

const rootCard = card({
  id: ROOT,
  title: '新製品ローンチ準備',
  role: 'supervisor',
  state: 'supervising',
});
const childCard = card({
  id: CHILD,
  parentId: ROOT,
  depth: 1,
  title: 'プレスリリース案',
  state: 'done',
});

interface MountOptions {
  open?: string;
  nodes?: SessionCard[];
  sessions?: Session[];
  integrations?: Integration[];
  handlers?: Parameters<typeof createFakeClient>[0];
}

function mount(
  outputs: Artifact[],
  {
    open = ROOT,
    nodes = [rootCard, childCard],
    sessions = [],
    integrations = [],
    handlers = {},
  }: MountOptions = {},
) {
  const fake = createFakeClient({
    'session.tree': () => ({ rootSessionId: ROOT, nodes }),
    'artifact.list': () => ({ items: outputs, nextCursor: null }),
    'integration.list': () => ({ items: integrations, nextCursor: null }),
    'session.list': () => ({ items: sessions, nextCursor: null }),
    ...handlers,
  });
  const rt = createRuntime(fake.client);
  const ui = render(
    <RuntimeProvider runtime={rt}>
      <TooltipProvider>
        <OutputsPanel sessionId={open} />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return { fake, rt, ui };
}

const panel = () => screen.findByRole('complementary', { name: '成果物' });

describe('<OutputsPanel>', () => {
  beforeEach(() => {
    useUi.setState({
      panelOpen: true,
      panelWidth: 360,
      reviewIntegrationId: null,
      mode: 'session',
      focusSessionId: ROOT,
    });
  });

  it('shows nothing while the conversation has no outputs', async () => {
    const { fake, ui } = mount([output('test_result', { sessionId: CHILD })]);
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'artifact.list')).toBe(true));
    expect(ui.container).toBeEmptyDOMElement();
  });

  it('lists the outputs of the conversation and its children, with who made them, and renders a document', async () => {
    const doc = output('document', {
      sessionId: CHILD,
      title: 'プレスリリース（案）',
      data: { format: 'markdown', content: '# 家族の予定を、ひとつに\n\n- 共有\n', path: null },
    });
    const link = output('link', {
      sessionId: ROOT,
      title: '競合の比較',
      createdAt: iso(T0 - 1000),
    });
    mount([doc, link]);
    const p = await panel();
    const list = await within(p).findByRole('list', { name: '成果物の一覧' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((b) => b.textContent)).toEqual([
      expect.stringContaining('プレスリリース（案）'),
      expect.stringContaining('競合の比較'),
    ]);
    // The child's name beside its output; the conversation's own output has none.
    expect(rows[0]).toHaveTextContent('プレスリリース案');
    expect(within(rows[1]!).queryByRole('button', { name: /を開く$/ })).toBeNull();
    // The chosen output carries its actions (a document: copy).
    expect(within(rows[0]!).getByRole('button', { name: 'コピー' })).toBeInTheDocument();
    expect(within(rows[1]!).queryByRole('button', { name: '開く' })).toBeNull();
    expect(
      await within(p).findByRole('heading', { level: 1, name: '家族の予定を、ひとつに' }),
    ).toBeInTheDocument();
    // The maker chip opens that conversation.
    fireEvent.click(within(p).getByRole('button', { name: 'プレスリリース案 を開く' }));
    expect(useUi.getState().focusSessionId).toBe(CHILD);
  });

  it('shows a table with its first 500 rows', async () => {
    const rows = Array.from({ length: TABLE_ROWS + 20 }, (_, i) => [`行 ${i}`, i]);
    mount([
      output('data', {
        sessionId: ROOT,
        data: { format: 'csv', columns: ['名前', '数'], rows, path: null },
      }),
    ]);
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(TABLE_ROWS + 1);
    expect(within(table).getByRole('columnheader', { name: '数' })).toHaveClass('text-right');
    expect(screen.getByTestId('rows-cut')).toHaveTextContent('500 / 520 行');
  });

  it('shows a file of a files output as text (Markdown rendered)', async () => {
    const files = output('files', { sessionId: ROOT });
    const { fake } = mount([files], {
      handlers: {
        'artifact.read': () => ({
          content: '# よくある質問\n\n対応端末',
          mimeType: 'text/markdown',
          truncated: false,
        }),
      },
    });
    expect(await screen.findByRole('heading', { name: 'よくある質問' })).toBeInTheDocument();
    expect(screen.getByText('2 KB')).toBeInTheDocument();
    expect(fake.calls.find((c) => c.method === 'artifact.read')?.params).toMatchObject({
      artifactId: files.id,
      path: 'notes/faq.md',
    });
  });

  it('lists the request’s completion conditions, met once the work is done', async () => {
    const child = session({
      id: CHILD,
      parentSessionId: ROOT,
      brief: {
        goal: '調べる',
        doneWhen: ['3 社の価格が表になっている', '出典が書かれている'],
        fromSessionId: ROOT,
        reviewBy: 'none',
        givenAt: iso(T0),
      },
    });
    mount([output('document', { sessionId: CHILD })], { open: CHILD, sessions: [child] });
    const list = await screen.findByRole('list', { name: '完了条件' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['3 社の価格が表になっている', '出典が書かれている']);
    expect(within(list).getAllByRole('listitem')[0]).toHaveAttribute('data-met', 'true');
  });

  it('adopts code: 採用 calls artifact.review and the bar follows the change being applied', async () => {
    const code = output('diff', {
      sessionId: CHILD,
      workspaceId: 'wsp_1',
      review: pending,
      title: 'エラーメッセージを直す',
    });
    const { fake } = mount([code], {
      nodes: [rootCard, { ...childCard, state: 'review' } satisfies SessionCard],
      handlers: {
        'artifact.review': () => ({
          artifact: code,
          integrationId: 'int_00000000000000000000000077',
        }),
      },
    });
    const p = await panel();
    // One output: no list, the change of two files.
    expect(within(p).queryByRole('list', { name: '成果物の一覧' })).toBeNull();
    expect(await within(p).findByText('src/auth/session.ts')).toBeInTheDocument();
    fireEvent.click(within(p).getByRole('button', { name: '採用' }));
    expect(fake.calls.find((c) => c.method === 'artifact.review')?.params).toEqual({
      artifactId: code.id,
      decision: 'accept',
    });
    expect(await within(p).findByText('反映中')).toBeInTheDocument();
    expect(within(p).queryByRole('button', { name: '採用' })).toBeNull();

    // The daemon's integration fails its tests: the bar says so and offers a redo.
    const failed = integration({
      id: 'int_00000000000000000000000077',
      status: 'failed',
      workspaceIds: ['wsp_1'],
      preApprovedBy: { kind: 'human', client: 'test' },
      createdAt: iso(T0 + 60_000),
      error: { code: 'tests_failed', message: 'テストが 1 件失敗しました' },
    });
    act(() =>
      fake.emit({
        seq: 1,
        type: 'integration.updated',
        at: iso(T0),
        payload: { integration: failed, changes: ['status'] },
      } as never),
    );
    expect(await within(p).findByText('テスト失敗')).toBeInTheDocument();
    expect(within(p).getByRole('button', { name: 'やり直す' })).toBeEnabled();
  });

  it('sends work back with a note: やり直す opens the note, Enter sends it', async () => {
    const doc = output('document', { sessionId: ROOT, review: pending });
    const { fake } = mount([doc], {
      handlers: { 'artifact.review': () => ({ artifact: doc, integrationId: null }) },
    });
    const p = await panel();
    fireEvent.click(await within(p).findByRole('button', { name: 'やり直す' }));
    const note = within(p).getByRole('textbox', { name: '直してほしいこと' });
    fireEvent.change(note, { target: { value: '価格を外して' } });
    fireEvent.keyDown(note, { key: 'Enter' });
    expect(fake.calls.find((c) => c.method === 'artifact.review')?.params).toEqual({
      artifactId: doc.id,
      decision: 'redo',
      note: '価格を外して',
    });
    expect(await within(p).findByText('やり直し中')).toBeInTheDocument();
  });

  it('keeps the decided output in view while it moves down the list', async () => {
    const first = output('document', {
      sessionId: ROOT,
      title: '文書 1',
      review: pending,
      createdAt: iso(T0 + 2000),
    });
    const second = output('document', {
      sessionId: ROOT,
      title: '文書 2',
      review: pending,
      createdAt: iso(T0 + 1000),
    });
    let items: Artifact[] = [first, second];
    mount([], {
      handlers: {
        'artifact.list': () => ({ items, nextCursor: null }),
        'artifact.review': () => {
          items = [{ ...first, review: { ...pending, state: 'accepted' } }, second];
          return { artifact: items[0], integrationId: null };
        },
      },
    });
    const p = await panel();
    const list = await within(p).findByRole('list', { name: '成果物の一覧' });
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('文書 1');
    fireEvent.click(within(p).getByRole('button', { name: '採用' }));
    // Adopted, it goes below the one still waiting; the view stays on it.
    await waitFor(() =>
      expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('文書 2'),
    );
    expect(within(list).getByRole('button', { name: /文書 1/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(within(p).getByText('採用済み')).toBeInTheDocument();
  });

  it('Esc closes the note without sending', async () => {
    const doc = output('document', { sessionId: ROOT, review: pending });
    const { fake } = mount([doc]);
    const p = await panel();
    fireEvent.click(await within(p).findByRole('button', { name: 'やり直す' }));
    fireEvent.keyDown(within(p).getByRole('textbox', { name: '直してほしいこと' }), {
      key: 'Escape',
    });
    expect(within(p).queryByRole('textbox')).toBeNull();
    expect(fake.calls.some((c) => c.method === 'artifact.review')).toBe(false);
  });

  it('shows no decision for outputs nobody has to review, and what was decided for the others', async () => {
    const plain = output('document', { sessionId: ROOT, title: '普通の文書' });
    const adopted = output('document', {
      sessionId: ROOT,
      title: '採用した文書',
      review: { state: 'accepted', by: { kind: 'human', client: 'test' }, at: iso(T0), note: null },
    });
    mount([plain, adopted]);
    const p = await panel();
    await within(p).findByRole('list', { name: '成果物の一覧' });
    expect(within(p).queryByRole('button', { name: '採用' })).toBeNull();
    fireEvent.click(within(p).getByRole('button', { name: /採用した文書/ }));
    expect(await within(p).findByText('採用済み')).toBeInTheDocument();
  });

  it('広げる opens the code in the full view', async () => {
    const code = output('diff', { sessionId: ROOT, review: pending });
    mount([code]);
    fireEvent.click(await screen.findByRole('button', { name: '広げる' }));
    expect(useUi.getState().reviewIntegrationId).toBe(code.id);
  });

  it('closed, it keeps a rail of the outputs; pressing one opens the panel on it', async () => {
    useUi.setState({ panelOpen: false });
    const a = output('document', { sessionId: ROOT, title: '文書 A' });
    const b = output('link', { sessionId: ROOT, title: 'リンク B', createdAt: iso(T0 - 5000) });
    mount([a, b]);
    const rail = await screen.findByRole('complementary', { name: '成果物' });
    expect(rail).toHaveAttribute('data-region', 'panel-rail');
    fireEvent.click(within(rail).getByRole('button', { name: 'リンク B' }));
    expect(useUi.getState().panelOpen).toBe(true);
    const p = await panel();
    const list = within(p).getByRole('list', { name: '成果物の一覧' });
    expect(within(list).getByRole('button', { name: /リンク B/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    // The close button folds it back.
    fireEvent.click(within(p).getByRole('button', { name: '閉じる' }));
    expect(useUi.getState().panelOpen).toBe(false);
  });
});
