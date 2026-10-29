import type { Project, Session } from '@acc/protocol';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { T0, attention, card, homeSnapshot, homeTree, iso, session } from '../../test/fixtures';
import { Sidebar } from '../shell/Sidebar';
import { TooltipProvider } from '../ui/Tooltip';
import { OLDER_AFTER_MS } from './model';

const project = (id: string, name: string): Project => ({
  id,
  name,
  description: null,
  repoPath: null,
  folderPath: null,
  defaultBranch: null,
  defaultModel: null,
  testCommand: null,
  commitAuthor: null,
  permissionProfile: null,
  createdAt: iso(T0),
  updatedAt: iso(T0),
  archivedAt: null,
});

const now = Date.now();
const recent = (ms = 0) => iso(now - 60_000 + ms);

function mount({
  sessions,
  projects = [],
  snap = homeSnapshot(),
}: {
  sessions: Session[];
  projects?: Project[];
  snap?: ReturnType<typeof homeSnapshot>;
}) {
  const fake = createFakeClient({
    'session.list': () => ({ items: sessions, nextCursor: null }),
    'project.list': () => ({ items: projects }),
    'home.get': () => snap,
    'session.archive': (p) => ({ ...sessions.find((s) => s.id === p.sessionId)!, archivedAt: iso(now) }),
  });
  render(
    <RuntimeProvider runtime={createRuntime(fake.client)}>
      <TooltipProvider>
        <Sidebar />
      </TooltipProvider>
    </RuntimeProvider>,
  );
  return fake;
}

const row = (name: string) => screen.getByRole('button', { name });
const item = (name: string) => row(name).closest<HTMLElement>('[data-sidebar-item]')!;

/** A delegated tree: root with three children (working, needing you, done). */
function tree() {
  const root = session({ title: 'ローンチ準備', state: 'supervising', lastActivityAt: recent(10) });
  const kids = [
    session({ title: '競合調査', parentSessionId: root.id, state: 'working', stateSince: recent(), createdAt: iso(T0 + 1) }),
    session({ title: 'FAQ', parentSessionId: root.id, state: 'needs_you', createdAt: iso(T0 + 2) }),
    session({ title: 'プレス', parentSessionId: root.id, state: 'done', createdAt: iso(T0 + 3) }),
  ];
  return { root, kids, all: [root, ...kids] };
}

beforeEach(() =>
  useUi.setState({ mode: 'home', focusSessionId: null, collapsed: {}, back: [], forward: [], projectId: null }),
);

describe('<Sidebar> conversation tree', () => {
  it('shows each conversation with its state and its folded children as dots by priority', async () => {
    const { all } = tree();
    const chat = session({ title: 'お詫びメール', kind: 'chat', state: 'idle', lastActivityAt: recent() });
    mount({ sessions: [...all, chat] });
    await screen.findByRole('button', { name: 'ローンチ準備' });
    // Folded by default: the children are dots, not rows.
    expect(screen.queryByRole('button', { name: 'FAQ' })).toBeNull();
    const dots = item('ローンチ準備').querySelector('[data-child-dots]')!;
    expect([...dots.querySelectorAll('[data-state]')].map((d) => d.getAttribute('data-state'))).toEqual([
      'needs_you',
      'working',
      'done',
    ]);
    expect(within(item('ローンチ準備')).getByRole('img', { name: '子の作業待ち' })).toBeInTheDocument();
    expect(within(item('お詫びメール')).getByRole('img', { name: '待機' })).toBeInTheDocument();
    expect(item('お詫びメール').querySelector('[data-child-toggle]')).toBeNull();
  });

  it('unfolds children with tree rows, and a row opens its conversation', async () => {
    const { all, kids } = tree();
    mount({ sessions: all });
    const toggle = await screen.findByRole('button', { name: '子を表示' });
    fireEvent.click(toggle);
    expect(row('FAQ')).toBeInTheDocument();
    expect(item('競合調査').getAttribute('data-depth')).toBe('1');
    // A working child without children shows how long it has worked.
    expect(item('競合調査').querySelector('time')).toHaveTextContent('1分');
    fireEvent.click(row('FAQ'));
    expect(useUi.getState()).toMatchObject({ mode: 'session', focusSessionId: kids[1]!.id });
    expect(row('FAQ')).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: '子をたたむ' }));
    expect(screen.queryByRole('button', { name: 'FAQ' })).toBeNull();
    // The fold is remembered (persisted with the rest of the UI state).
    expect(Object.values(useUi.getState().collapsed)).toEqual([true]);
  });

  it('unfolds the ancestors of the open conversation by itself', async () => {
    const { all, kids } = tree();
    useUi.setState({ mode: 'session', focusSessionId: kids[2]!.id });
    mount({ sessions: all });
    expect(await screen.findByRole('button', { name: 'プレス' })).toHaveAttribute('aria-current', 'page');
    // Folding it by hand holds while that conversation stays open...
    fireEvent.click(screen.getByRole('button', { name: '子をたたむ' }));
    expect(screen.queryByRole('button', { name: 'プレス' })).toBeNull();
    // ...and opening another child of the tree unfolds it again.
    useUi.getState().openSession(kids[0]!.id);
    expect(await screen.findByRole('button', { name: '競合調査' })).toHaveAttribute('aria-current', 'page');
  });

  it('groups by project only with two or more projects, the conversations without one first', async () => {
    const free = session({ title: '雑談', lastActivityAt: recent(1) });
    const web = session({ title: 'ログイン改善', projectId: 'prj_web', lastActivityAt: recent(2) });
    mount({ sessions: [free, web], projects: [project('prj_web', 'acme-web')] });
    await screen.findByRole('button', { name: 'ログイン改善' });
    expect(screen.queryByRole('button', { name: 'acme-web' })).toBeNull();
    expect(document.querySelector('[data-sidebar-group]')).toBeNull();
  });

  it('shows project headings that fold, with a menu for a new conversation in that project', async () => {
    const free = session({ title: '雑談', lastActivityAt: recent(1) });
    const web = session({ title: 'ログイン改善', projectId: 'prj_web', lastActivityAt: recent(2) });
    mount({ sessions: [free, web], projects: [project('prj_web', 'acme-web'), project('prj_doc', '資料')] });
    const heading = await screen.findByRole('button', { name: 'acme-web' });
    const order = [...document.querySelectorAll('[data-sidebar-row], [data-sidebar-group]')].map(
      (el) => el.getAttribute('data-sidebar-group') ?? el.getAttribute('aria-label'),
    );
    expect(order).toEqual(['雑談', 'acme-web', 'ログイン改善', '資料']);
    fireEvent.click(heading);
    expect(screen.queryByRole('button', { name: 'ログイン改善' })).toBeNull();
    expect(heading).toHaveAttribute('aria-expanded', 'false');

    fireEvent.pointerDown(screen.getByRole('button', { name: '資料 の操作' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: '新しい会話' }));
    expect(useUi.getState()).toMatchObject({ mode: 'session', focusSessionId: null, projectId: 'prj_doc' });
  });

  it('folds conversations settled for a week into 以前', async () => {
    const fresh = session({ title: '今週の会話', state: 'done', lastActivityAt: recent() });
    const old = session({ title: '先月の会話', state: 'done', lastActivityAt: iso(now - OLDER_AFTER_MS - 60_000) });
    mount({ sessions: [fresh, old] });
    const older = await screen.findByRole('button', { name: '以前' });
    expect(older).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: '先月の会話' })).toBeNull();
    fireEvent.click(older);
    expect(row('先月の会話')).toBeInTheDocument();
  });

  it('shows the next scheduled run and the attention count from the home snapshot', async () => {
    const morning = session({ title: '朝のまとめ', kind: 'chat', lastActivityAt: recent() });
    const at = new Date(now + 60 * 60_000);
    at.setSeconds(0, 0);
    const snap = homeSnapshot({
      trees: [homeTree(card({ id: morning.id }), [], { nextRunAt: at.toISOString() })],
      attention: [attention({ id: morning.id })],
      totals: { working: 0, needsYou: 1, failed: 0, spendTodayUsd: 0, dailyLimitUsd: null, estimated: false },
    });
    mount({ sessions: [morning], snap });
    await waitFor(() => expect(item('朝のまとめ').querySelector('[data-next-run]')).not.toBeNull());
    expect(item('朝のまとめ').querySelector('[data-next-run]')!.textContent).toMatch(/\d+:\d\d/);
    expect(screen.getByRole('button', { name: /ホーム/ })).toHaveTextContent('1');
  });

  it('archives from the row menu (right click)', async () => {
    const chat = session({ title: 'Excel の重複', kind: 'chat', lastActivityAt: recent() });
    const fake = mount({ sessions: [chat] });
    await screen.findByRole('button', { name: 'Excel の重複' });
    fireEvent.contextMenu(item('Excel の重複'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /アーカイブ/ }));
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'session.archive')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Excel の重複' })).toBeNull());
  });

  it('moves with the arrow keys: down / up between rows, right unfolds, left goes back to the parent', async () => {
    const { all } = tree();
    const other = session({ title: '雑談', lastActivityAt: iso(now - 3_600_000) });
    mount({ sessions: [...all, other] });
    const root = await screen.findByRole('button', { name: 'ローンチ準備' });
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    expect(row('競合調査')).toBeInTheDocument();
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('競合調査'));
    fireEvent.keyDown(row('競合調査'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(root);
    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    expect(screen.queryByRole('button', { name: '競合調査' })).toBeNull();
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('雑談'));
  });
});
