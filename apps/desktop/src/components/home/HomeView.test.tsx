import type { HomeSnapshot, Project } from '@acc/protocol';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { qk } from '../../daemon/keys';
import { type AppRuntime, RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { attention, card, homeSnapshot, homeTree, session } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { HomeView } from './HomeView';

function mount(handlers: Parameters<typeof createFakeClient>[0]) {
  const fake = createFakeClient(handlers);
  const rt = createRuntime(fake.client);
  render(
    <RuntimeProvider runtime={rt}>
      <TooltipProvider>
        <HomeView />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return { ...fake, rt };
}

const counts = { working: 0, queued: 0, needsYou: 0, failed: 0, review: 0, done: 0, stopped: 0 };

/** A delegated tree with a question, two working children and a done one; plus a settled tree and a plain chat. */
function scene() {
  const root = card({ title: 'ローンチ準備', role: 'supervisor', state: 'supervising' });
  const faq = card({ parentId: root.id, depth: 1, title: 'FAQ', state: 'needs_you' });
  const research = card({ parentId: root.id, depth: 1, title: '競合調査', state: 'working', now: 'pricing.md を参照' });
  const mail = card({ parentId: root.id, depth: 1, title: '告知メール', state: 'working' });
  const press = card({ parentId: root.id, depth: 1, title: 'プレスリリース', state: 'done' });
  const q = attention({ id: faq.id, rootSessionId: root.id }, { title: '価格を載せる？', choices: [
    { id: 'yes', label: '載せる', tone: 'primary' },
    { id: 'later', label: '発売時に案内', tone: 'neutral' },
  ], allowText: true });
  const ok = attention({ id: faq.id, rootSessionId: root.id }, {
    kind: 'approval',
    title: 'pnpm add zod を実行',
    choices: [
      { id: 'approve', label: '許可', tone: 'primary' },
      { id: 'reject', label: '拒否', tone: 'danger' },
    ],
    allowText: false,
    priority: 5,
  });
  faq.attentionIds = [ok.id, q.id];
  const morning = card({ title: '朝のまとめ', role: 'chat', state: 'done', startedBy: 'schedule' });
  const firing = card({ parentId: morning.id, depth: 1, title: '朝のまとめ · 10/30', state: 'done' });
  const chat = card({ title: 'ブログ記事', role: 'chat', state: 'working', now: '回答を作成中' });
  const snap = homeSnapshot({
    attention: [ok, q],
    trees: [
      homeTree(root, [research, faq, mail, press], { counts: { ...counts, working: 2, needsYou: 1, done: 1 } }),
      homeTree(chat, [], { counts: { ...counts, working: 1 } }),
      homeTree(morning, [firing], { counts: { ...counts, done: 2 }, nextRunAt: new Date(Date.now() + 3_600_000).toISOString() }),
    ],
  });
  return { snap, root, faq, research, mail, press, q, ok, morning, chat };
}

const chipsIn = (region: HTMLElement) =>
  within(region)
    .queryAllByRole('button')
    .filter((b) => b.hasAttribute('data-session-chip'));

const setSnap = (rt: AppRuntime, snap: HomeSnapshot) => act(() => void rt.queryClient.setQueryData(qk.home, snap));

const press = (key: string, target: Element | Document = document.body) => act(() => void fireEvent.keyDown(target, { key }));

beforeEach(() => useUi.setState({ mode: 'home', focusSessionId: null, selectedId: null, projectId: null }));

describe('<HomeView>', () => {
  it('shows attention on top, then each tree: chips by state priority with a state band', async () => {
    const s = scene();
    mount({ 'home.get': () => s.snap });
    const rows = await screen.findByRole('region', { name: '出番' });
    expect(within(rows).getByText('価格を載せる？')).toBeInTheDocument();
    const lane = screen.getByRole('region', { name: 'ローンチ準備' });
    expect(chipsIn(lane).map((c) => c.getAttribute('data-state'))).toEqual(['needs_you', 'working', 'working', 'done']);
    expect(within(lane).getByRole('img', { name: 'あなたの出番 1、作業中 2、完了 1' })).toHaveAttribute('data-state-band');
    fireEvent.click(chipsIn(lane)[1]!);
    expect(useUi.getState()).toMatchObject({ mode: 'session', focusSessionId: s.research.id });
  });

  it('folds a settled tree to its heading; a tree without children shows its state and what it does', async () => {
    const s = scene();
    mount({ 'home.get': () => s.snap });
    const morning = await screen.findByRole('region', { name: '朝のまとめ' });
    expect(chipsIn(morning)).toHaveLength(0);
    expect(morning).toHaveAttribute('data-compact', 'true');
    expect(within(morning).getByLabelText('次回')).toBeInTheDocument();
    const chat = screen.getByRole('region', { name: 'ブログ記事' });
    expect(within(chat).getByRole('img', { name: '作業中' })).toBeInTheDocument();
    expect(within(chat).getByText('回答を作成中')).toBeInTheDocument();
    // Its heading opens the conversation.
    fireEvent.click(within(chat).getByRole('button', { name: 'ブログ記事' }));
    expect(useUi.getState().focusSessionId).toBe(s.chat.id);
  });

  it('marks a conversation whose answer arrived after you last looked; opening it clears the mark', async () => {
    const s = scene();
    s.morning.stateSince = new Date().toISOString();
    useUi.setState({ readBaseline: new Date(Date.now() - 60_000).toISOString(), viewedAt: {} });
    mount({ 'home.get': () => s.snap });
    const morning = await screen.findByRole('region', { name: '朝のまとめ' });
    expect(within(morning).getByRole('img', { name: '未読' })).toBeInTheDocument();
    // Still working: nothing to read yet.
    expect(within(screen.getByRole('region', { name: 'ブログ記事' })).queryByRole('img', { name: '未読' })).toBeNull();
    fireEvent.click(within(morning).getByRole('button', { name: '朝のまとめ' }));
    act(() => useUi.getState().goHome());
    expect(within(screen.getByRole('region', { name: '朝のまとめ' })).queryByRole('img', { name: '未読' })).toBeNull();
  });

  it('shows five attention rows and 「あと N 件」 when more than six are open', async () => {
    const root = card({ title: 'R', state: 'supervising' });
    const items = Array.from({ length: 8 }, (_, i) => attention({ id: root.id }, { title: `質問 ${i}` }));
    mount({ 'home.get': () => homeSnapshot({ attention: items, trees: [homeTree(root)] }) });
    const rows = await screen.findByRole('region', { name: '出番' });
    expect(within(rows).getAllByRole('group')).toHaveLength(5);
    fireEvent.click(within(rows).getByRole('button', { name: 'あと 3 件' }));
    expect(within(rows).getAllByRole('group')).toHaveLength(8);
  });

  it('J / K walk attention rows, lane headings and chips; Enter opens a chip', async () => {
    const s = scene();
    mount({ 'home.get': () => s.snap });
    await screen.findByRole('region', { name: '出番' });
    press('j');
    expect(useUi.getState().selectedId).toBe(s.ok.id);
    press('j');
    press('j');
    expect(useUi.getState().selectedId).toBe(s.root.id);
    press('ArrowDown');
    expect(useUi.getState().selectedId).toBe(s.faq.id);
    press('j');
    expect(useUi.getState().selectedId).toBe(s.research.id);
    expect(document.querySelector(`[data-session-chip="${s.research.id}"]`)).toHaveAttribute('data-selected', 'true');
    press('k');
    expect(useUi.getState().selectedId).toBe(s.faq.id);
    press('Enter');
    expect(useUi.getState()).toMatchObject({ mode: 'session', focusSessionId: s.faq.id });
  });

  it('Y answers the selected approval and the selection moves to the next row', async () => {
    const s = scene();
    const fake = mount({ 'home.get': () => s.snap, 'attention.respond': () => ({ attention: { ...s.ok, status: 'resolved' } }) });
    await screen.findByRole('region', { name: '出番' });
    press('j');
    press('y');
    await vi.waitFor(() =>
      expect(fake.calls.find((c) => c.method === 'attention.respond')?.params).toEqual({ attentionId: s.ok.id, choiceId: 'approve' }),
    );
    expect(useUi.getState().selectedId).toBe(s.q.id);
    // 2 picks the second choice of the question now selected.
    press('2');
    await vi.waitFor(() =>
      expect(fake.calls.filter((c) => c.method === 'attention.respond').map((c) => c.params.choiceId)).toEqual(['approve', 'later']),
    );
  });

  it('Enter on a selected question opens its reply field', async () => {
    const s = scene();
    mount({ 'home.get': () => s.snap });
    await screen.findByRole('region', { name: '出番' });
    act(() => useUi.getState().select(s.q.id, true));
    press('Enter');
    expect(await screen.findByRole('textbox', { name: '返信' })).toBeInTheDocument();
  });

  it('keys do nothing while typing in the request field', async () => {
    const s = scene();
    mount({ 'home.get': () => s.snap });
    const input = await screen.findByRole('textbox', { name: '何を頼みますか' });
    press('j', input);
    expect(useUi.getState().selectedId).toBeNull();
  });

  it('holds chips in place while the pointer is over the screen, then moves them', async () => {
    const s = scene();
    const { rt } = mount({ 'home.get': () => s.snap });
    const lane = await screen.findByRole('region', { name: 'ローンチ準備' });
    const main = lane.closest('[data-region="main"]')!;
    fireEvent.pointerEnter(main);
    // The press release turns out failed: it would jump ahead of the working ones.
    const next = structuredClone(s.snap);
    next.trees[0]!.nodes = next.trees[0]!.nodes.map((n) => (n.id === s.press.id ? { ...n, state: 'failed' as const } : n));
    setSnap(rt, next);
    // The card itself is live; its place waits.
    await vi.waitFor(() =>
      expect(document.querySelector(`[data-session-chip="${s.press.id}"]`)).toHaveAttribute('data-state', 'failed'),
    );
    const ids = () => chipsIn(screen.getByRole('region', { name: 'ローンチ準備' })).map((c) => c.getAttribute('data-session-chip'));
    expect(ids()).toEqual([s.faq.id, s.research.id, s.mail.id, s.press.id]);
    fireEvent.pointerLeave(main);
    expect(ids()).toEqual([s.faq.id, s.press.id, s.research.id, s.mail.id]);
  });

  it('is one field when there is nothing yet; Enter starts a conversation and stays home', async () => {
    const s = session({ kind: 'chat' });
    const fake = mount({
      'home.get': () => homeSnapshot(),
      'project.list': () => ({ items: [] }),
      'session.create': () => s,
      'session.messages': () => ({ items: [], hasMore: false, streaming: null }),
      'session.send': () => ({ messageId: 'msg_1', runId: null, delivery: 'started' }),
    });
    const input = await screen.findByRole('textbox', { name: '何を頼みますか' });
    expect(screen.queryByRole('region')).toBeNull();
    fireEvent.change(input, { target: { value: '競合を調べて' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await vi.waitFor(() => expect(fake.calls.map((c) => c.method)).toContain('session.send'));
    expect(fake.calls.map((c) => c.method)).not.toContain('session.delegate');
    expect(useUi.getState().mode).toBe('home');
  });

  it('with 任せる on, the new conversation is delegated before the first message; Ctrl+Enter opens it', async () => {
    const s = session({ kind: 'chat' });
    const fake = mount({
      'home.get': () => homeSnapshot(),
      'project.list': () => ({ items: [] }),
      'session.create': () => s,
      'session.delegate': () => ({}),
      'session.messages': () => ({ items: [], hasMore: false, streaming: null }),
      'session.send': () => ({ messageId: 'msg_1', runId: null, delivery: 'started' }),
    });
    const input = await screen.findByRole('textbox', { name: '何を頼みますか' });
    const toggle = screen.getByRole('button', { name: '任せる' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(input, { target: { value: 'ローンチの準備' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await vi.waitFor(() => expect(useUi.getState()).toMatchObject({ mode: 'session', focusSessionId: s.id }));
    const methods = fake.calls.map((c) => c.method).filter((m) => m.startsWith('session.') && m !== 'session.messages');
    expect(methods).toEqual(['session.create', 'session.delegate', 'session.send']);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('コード works in a worktree of a repository project', async () => {
    const project = { id: 'prj_1', name: 'app', repoPath: '/repo', folderPath: null } as Project;
    const s = session({ kind: 'agent', projectId: project.id });
    const fake = mount({
      'home.get': () => homeSnapshot(),
      'project.list': () => ({ items: [project] }),
      'session.create': () => s,
      'session.messages': () => ({ items: [], hasMore: false, streaming: null }),
      'session.send': () => ({ messageId: 'msg_1', runId: null, delivery: 'started' }),
    });
    const input = await screen.findByRole('textbox', { name: '何を頼みますか' });
    await vi.waitFor(() => expect(fake.calls.map((c) => c.method)).toContain('project.list'));
    // No folder project: フォルダ cannot be chosen.
    fireEvent.click(screen.getByRole('radio', { name: 'フォルダ' }));
    expect(screen.getByRole('radio', { name: '作業場所なし' })).toHaveAttribute('aria-checked', 'true');
    await vi.waitFor(() => {
      fireEvent.click(screen.getByRole('radio', { name: 'コード' }));
      expect(screen.getByText('app')).toBeInTheDocument();
    });
    fireEvent.change(input, { target: { value: 'テストを足して' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await vi.waitFor(() => expect(fake.calls.map((c) => c.method)).toContain('session.send'));
    expect(fake.calls.find((c) => c.method === 'session.create')?.params).toMatchObject({
      kind: 'agent',
      projectId: project.id,
      workspace: { kind: 'worktree', projectId: project.id },
    });
  });
});
