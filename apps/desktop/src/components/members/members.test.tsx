import type { Character, CharacterDetail, CharacterMemory, Session } from '@acc/protocol';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ASK_TIMEOUT_MS, askMember, mentionOf } from '../../daemon/members';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useToasts } from '../../store/toast';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { T0, card, homeSnapshot, iso, session } from '../../test/fixtures';
import { speakerTones } from '../focus/Speech';
import { Sidebar } from '../shell/Sidebar';
import { TooltipProvider } from '../ui/Tooltip';
import { PlanCard } from '../focus/Cards';
import { Composer } from '../focus/Composer';
import { AsideRemark } from './Aside';
import { MemberPage } from './MemberPage';
import { memberActivity } from './Roster';

const member = (over: Partial<Character> = {}): Character => ({
  id: 'chr_00000000000000000000000001',
  name: 'ハク',
  face: null,
  tone: 0,
  profile: 'のんびり屋の白い犬。',
  model: null,
  sortKey: 1,
  createdAt: iso(T0),
  updatedAt: iso(T0),
  archivedAt: null,
  ...over,
});

const HAKU = member();
const LUNA = member({ id: 'chr_00000000000000000000000002', name: 'ルナ', face: '🌙', tone: 1, sortKey: 2 });

function mount(ui: React.ReactNode, { members = [HAKU, LUNA], sessions = [] as Session[], page, without = [] }: {
  members?: Character[];
  sessions?: Session[];
  page?: CharacterDetail;
  /** Methods this daemon does not implement. */
  without?: string[];
} = {}) {
  const fake = createFakeClient({
    'character.list': () => ({ items: members }),
    'character.get': (p) =>
      page ?? { character: members.find((m) => m.id === p.characterId)!, sessions: [], monthUsd: 0, memories: [], changes: [], memoryUsd: 0 },
    'character.memory.update': (p) => ({ id: p.memoryId, text: p.text }),
    'character.memory.delete': () => ({ ok: true }),
    'character.memory.add': (p) => ({ id: 'mem_x', ...p }),
    'character.update': (p) => ({ ...members.find((m) => m.id === p.characterId)!, ...p }),
    'session.list': () => ({ items: sessions, nextCursor: null }),
    'project.list': () => ({ items: [] }),
    'home.get': () => homeSnapshot(),
  });
  for (const m of without) delete fake.handlers[m];
  render(
    <RuntimeProvider runtime={createRuntime(fake.client)}>
      <TooltipProvider>{ui}</TooltipProvider>
    </RuntimeProvider>,
  );
  return fake;
}

beforeEach(() => {
  useUi.setState({ mode: 'home', memberId: null, draftMemberId: null, back: [], forward: [] });
  useToasts.setState({ toasts: [] });
});

describe('the roster at the foot of the sidebar', () => {
  it('shows each member by face only, with a ring on those at work, and opens the page', async () => {
    const working = session({ title: '競合調査', characterId: LUNA.id, state: 'working', now: '「競合」を検索' });
    mount(<Sidebar />, { sessions: [working] });
    const roster = await screen.findByRole('group', { name: 'メンバー' });
    const haku = await within(roster).findByRole('button', { name: 'ハク' });
    const luna = within(roster).getByRole('button', { name: 'ルナ' });
    expect(haku).toHaveTextContent('ハ');
    expect(luna).toHaveTextContent('🌙');
    expect(haku.dataset.busy).toBeUndefined();
    await waitFor(() => expect(luna.dataset.busy).toBe('true'));
    fireEvent.click(haku);
    expect(useUi.getState()).toMatchObject({ mode: 'member', memberId: HAKU.id });
  });

  it('a conversation with a member shows its face on its row', async () => {
    const talk = session({ title: '週末なにする', characterId: HAKU.id, lastActivityAt: new Date().toISOString() });
    mount(<Sidebar />, { sessions: [talk] });
    const row = (await screen.findByRole('button', { name: '週末なにする' })).closest<HTMLElement>('[data-sidebar-item]')!;
    await waitFor(() => expect(row.querySelector(`[data-member-face="${HAKU.id}"]`)).not.toBeNull());
  });

  it('with nobody on the roster, only a quiet + is there', async () => {
    mount(<Sidebar />, { members: [] });
    const roster = await screen.findByRole('group', { name: 'メンバー' });
    expect(within(roster).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['メンバーを追加']);
  });

  it('is not there at all when the daemon has no members', async () => {
    mount(<Sidebar />, { without: ['character.list'] });
    expect(screen.getByRole('group', { name: 'メンバー' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('group', { name: 'メンバー' })).toBeNull());
    expect(document.querySelector('[data-add-member]')).toBeNull();
  });
});

describe('the page of a member', () => {
  it('shows the profile, the conversations it was in and the month spend; the profile saves on leaving', async () => {
    useUi.setState({ mode: 'member', memberId: HAKU.id });
    const talk = session({ title: '週末なにする', characterId: HAKU.id });
    const fake = mount(<MemberPage />, { page: { character: HAKU, sessions: [talk], monthUsd: 1.24, memories: [], changes: [], memoryUsd: 0 } });
    const profile = await screen.findByRole('textbox', { name: 'プロフィール' });
    expect(profile).toHaveValue('のんびり屋の白い犬。');
    expect(await screen.findByRole('button', { name: /週末なにする/ })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-member-cost]')).toHaveTextContent('$1.24'));
    fireEvent.change(profile, { target: { value: '梅おにぎりが好き' } });
    fireEvent.blur(profile);
    await waitFor(() =>
      expect(fake.calls).toContainEqual({ method: 'character.update', params: { characterId: HAKU.id, profile: '梅おにぎりが好き' } }),
    );
  });

  it('talking with the member opens a draft with it chosen', async () => {
    useUi.setState({ mode: 'member', memberId: HAKU.id });
    mount(<MemberPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'ハクと話す' }));
    expect(useUi.getState()).toMatchObject({ mode: 'session', focusSessionId: null, draftMemberId: HAKU.id });
  });

  it("going from one member's page to another's, the face editor shows and keeps the other's face", async () => {
    useUi.setState({ mode: 'member', memberId: HAKU.id });
    const fake = mount(<MemberPage />);
    await screen.findByRole('textbox', { name: 'プロフィール' });
    act(() => useUi.getState().openMember(LUNA.id));
    await waitFor(() => expect(document.querySelector(`[data-member-page="${LUNA.id}"]`)).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '顔と色' }));
    const input = await screen.findByRole('textbox', { name: '顔の文字' });
    expect(input).toHaveValue('🌙');
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '顔の文字' })).toBeNull());
    expect(fake.calls.filter((c) => c.method === 'character.update')).toEqual([]);
  });

  it('a new face is saved once on Enter, which closes the editor', async () => {
    useUi.setState({ mode: 'member', memberId: HAKU.id });
    const fake = mount(<MemberPage />);
    fireEvent.click(await screen.findByRole('button', { name: '顔と色' }));
    const input = await screen.findByRole('textbox', { name: '顔の文字' });
    expect(input).toHaveValue('');
    fireEvent.change(input, { target: { value: '犬' } });
    // Still composing: Enter belongs to the IME.
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(screen.getByRole('textbox', { name: '顔の文字' })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '顔の文字' })).toBeNull());
    expect(fake.calls.filter((c) => c.method === 'character.update')).toEqual([
      { method: 'character.update', params: { characterId: HAKU.id, face: '犬' } },
    ]);
  });

  it('works with an older daemon that leaves out memories and changes, and shows nothing spent as $0.00', async () => {
    useUi.setState({ mode: 'member', memberId: HAKU.id });
    const old = { character: HAKU, sessions: [], monthUsd: 0 } as unknown as CharacterDetail;
    mount(<MemberPage />, { page: old });
    await waitFor(() => expect(document.querySelector('[data-member-cost]')).toHaveTextContent('$0.00'));
    expect(screen.queryByText('最近の変化')).toBeNull();
    expect(screen.getByRole('region', { name: '覚えたこと' })).toBeInTheDocument();
  });

  it("an archived member's menu starts with its item, not a separator", async () => {
    const gone = member({ archivedAt: iso(T0) });
    useUi.setState({ mode: 'member', memberId: gone.id });
    mount(<MemberPage />, { members: [gone, LUNA] });
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'その他の操作' }), { button: 0, ctrlKey: false });
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('separator')).toBeNull();
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['名簿に戻す']);
  });

  it('back and forward come back to the page', () => {
    useUi.getState().openMember(HAKU.id);
    useUi.getState().goHome();
    useUi.getState().goBack();
    expect(useUi.getState()).toMatchObject({ mode: 'member', memberId: HAKU.id });
  });
});

describe('what a member remembers', () => {
  const mem = (over: Partial<CharacterMemory>): CharacterMemory => ({
    id: 'mem_00000000000000000000000001',
    characterId: HAKU.id,
    kind: 'self',
    aboutId: null,
    text: 'リスに梅おにぎりを奪われた',
    work: false,
    at: new Date().toISOString(),
    source: 'auto',
    createdAt: iso(T0),
    updatedAt: iso(T0),
    ...over,
  });

  it("lists itself, its ties with faces and the person; the person's lines are marked; it can be corrected and made to forget", async () => {
    useUi.setState({ mode: 'member', memberId: HAKU.id });
    const memories = [
      mem({}),
      mem({ id: 'mem_00000000000000000000000002', kind: 'relation', aboutId: LUNA.id, text: 'ズボラな案にはツッコむ' }),
      mem({ id: 'mem_00000000000000000000000003', kind: 'you', text: '朝が弱い', source: 'person' }),
    ];
    const fake = mount(<MemberPage />, {
      page: {
        character: HAKU,
        sessions: [],
        monthUsd: 1,
        memories,
        changes: [{ at: iso(T0), change: 'added', kind: 'self', text: 'リスに梅おにぎりを奪われた', by: 'digest' }],
        memoryUsd: 0.05,
      },
    });
    const section = await screen.findByRole('region', { name: '覚えたこと' });
    const row = await within(section).findByText('リスに梅おにぎりを奪われた');
    expect(within(row.closest('li')!).getByText('今日')).toBeInTheDocument();
    const tie = within(section).getByText('ズボラな案にはツッコむ').closest('li')!;
    expect(tie.querySelector('[data-face]')).toHaveTextContent('🌙');
    const you = within(section).getByText('朝が弱い').closest('li')!;
    expect(you.dataset.source).toBe('person');
    expect(within(you).getByLabelText('あなたが書いた')).toBeInTheDocument();
    // The month's spend counts sorting too, split out.
    expect(document.querySelector('[data-member-cost]')).toHaveTextContent('$1.05');
    expect(screen.getByRole('list', { name: '最近の変化' })).toHaveTextContent('リスに梅おにぎりを奪われた');

    const li = row.closest('li')!;
    fireEvent.click(within(li).getByRole('button', { name: '直す' }));
    const input = within(li).getByRole('textbox', { name: '記憶を直す' });
    fireEvent.change(input, { target: { value: 'リスに鮭おにぎりを奪われた' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(fake.calls).toContainEqual({
        method: 'character.memory.update',
        params: { memoryId: memories[0]!.id, text: 'リスに鮭おにぎりを奪われた' },
      }),
    );
    fireEvent.click(within(you).getByRole('button', { name: '忘れさせる' }));
    await waitFor(() =>
      expect(fake.calls).toContainEqual({ method: 'character.memory.delete', params: { memoryId: memories[2]!.id } }),
    );
  });

  it('reaches 直す and 忘れさせる by keyboard, and 元に戻す brings a forgotten memory back as it was', async () => {
    useUi.setState({ mode: 'member', memberId: HAKU.id });
    const tie = mem({ id: 'mem_00000000000000000000000002', kind: 'relation', aboutId: LUNA.id, text: 'ズボラな案にはツッコむ' });
    const fake = mount(<MemberPage />, {
      page: { character: HAKU, sessions: [], monthUsd: 0, memories: [tie], changes: [], memoryUsd: 0 },
    });
    const li = (await screen.findByText('ズボラな案にはツッコむ')).closest('li')!;
    const forget = within(li).getByRole('button', { name: '忘れさせる' });
    // Faded, not display:none: Tab reaches it.
    expect(forget.parentElement).not.toHaveClass('hidden');
    expect(forget.parentElement).toHaveClass('opacity-0');
    forget.focus();
    expect(forget).toHaveFocus();
    fireEvent.click(forget);
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => t.action?.label === '元に戻す')).toBe(true));
    const undo = useToasts.getState().toasts.find((t) => t.action?.label === '元に戻す')!;
    expect(undo.action?.undo).toBe(true);
    expect(undo.sticky).toBe(false);
    act(() => undo.action!.run());
    await waitFor(() =>
      expect(fake.calls).toContainEqual({
        method: 'character.memory.add',
        params: { characterId: HAKU.id, kind: 'relation', text: 'ズボラな案にはツッコむ', aboutId: LUNA.id },
      }),
    );
  });

  it('has it remember something about the person', async () => {
    useUi.setState({ mode: 'member', memberId: HAKU.id });
    const fake = mount(<MemberPage />);
    const buttons = await screen.findAllByRole('button', { name: '覚えさせる' });
    fireEvent.click(buttons.at(-1)!);
    const input = screen.getByRole('textbox', { name: '覚えさせること' });
    fireEvent.change(input, { target: { value: '費用にうるさい' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(fake.calls).toContainEqual({
        method: 'character.memory.add',
        params: { characterId: HAKU.id, kind: 'you', text: '費用にうるさい' },
      }),
    );
  });
});

describe('speaker voices', () => {
  it('a member brings its own face and colour; a persona takes the next of the first four', () => {
    const parent = 'ses_00000000000000000000000009';
    const nodes = [
      { ...card({ id: 'ses_00000000000000000000000001', parentId: parent }), role: 'speaker' as const, characterId: LUNA.id },
      { ...card({ id: 'ses_00000000000000000000000002', parentId: parent }), role: 'speaker' as const, characterId: null },
    ];
    const tones = speakerTones(nodes, (id) => (id === LUNA.id ? { tone: 5, face: '🌙' } : undefined));
    expect(tones.get('ses_00000000000000000000000001')).toEqual({ tone: 5, face: '🌙' });
    expect(tones.get('ses_00000000000000000000000002')).toEqual({ tone: 0 });
  });
});

describe('what members are doing', () => {
  it('takes the working conversation over a queued one', () => {
    const q = session({ characterId: HAKU.id, state: 'queued' });
    const w = session({ characterId: HAKU.id, state: 'working' });
    const idle = session({ characterId: LUNA.id, state: 'idle' });
    const busy = memberActivity([q, w, idle]);
    expect(busy.get(HAKU.id)?.id).toBe(w.id);
    expect(busy.has(LUNA.id)).toBe(false);
  });
});

describe('calling a member in with @name', () => {
  it('lists members after @, picks one with Enter, and sends the ask to the member instead of the conversation', async () => {
    useUi.setState({ drafts: {}, asking: {} });
    const s = session({ kind: 'chat', title: 'API の命名' });
    let answer!: (v: unknown) => void;
    const fake = createFakeClient({
      'character.list': () => ({ items: [HAKU, LUNA] }),
      'character.aside': () => new Promise((r) => (answer = r)),
    });
    render(
      <RuntimeProvider runtime={createRuntime(fake.client)}>
        <TooltipProvider>
          <Composer session={s} activeRun={null} onSent={() => {}} />
        </TooltipProvider>
      </RuntimeProvider>,
    );
    const input = screen.getByRole('textbox', { name: 'メッセージ' });
    fireEvent.change(input, { target: { value: '@ル' } });
    const list = await screen.findByRole('listbox', { name: '呼ぶメンバー' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['🌙ルナ']);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('@ルナ ');
    fireEvent.change(input, { target: { value: '@ルナ どう思う？' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(fake.calls).toContainEqual({
        method: 'character.aside',
        params: { sessionId: s.id, characterId: LUNA.id, text: '@ルナ どう思う？' },
      }),
    );
    expect(fake.calls.some((c) => c.method === 'session.send')).toBe(false);
    // Waiting for the answer in this window.
    expect(useUi.getState().asking[s.id]).toEqual([expect.objectContaining({ characterId: LUNA.id, text: '@ルナ どう思う？' })]);
    answer({ ask: {}, reply: {} });
    await waitFor(() => expect(useUi.getState().asking[s.id]).toEqual([]));
  });

  it('an @ that names nobody on the roster is an ordinary message', async () => {
    useUi.setState({ drafts: {}, asking: {} });
    const s = session({ kind: 'chat' });
    const fake = createFakeClient({
      'character.list': () => ({ items: [HAKU] }),
      'session.send': () => ({ messageId: 'msg_00000000000000000000000009', runId: null, delivery: 'delivered' }),
    });
    render(
      <RuntimeProvider runtime={createRuntime(fake.client)}>
        <TooltipProvider>
          <Composer session={s} activeRun={null} onSent={() => {}} />
        </TooltipProvider>
      </RuntimeProvider>,
    );
    const input = screen.getByRole('textbox', { name: 'メッセージ' });
    fireEvent.change(input, { target: { value: '@everyone 見て' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'session.send')).toBe(true));
  });
});

describe('the @ list and the ask, with care for the words', () => {
  const s = session({ kind: 'chat' });
  function composer(handlers: Parameters<typeof createFakeClient>[0] = {}) {
    useUi.setState({ drafts: {}, asking: {} });
    const fake = createFakeClient({ 'character.list': () => ({ items: [HAKU, LUNA] }), ...handlers });
    render(
      <RuntimeProvider runtime={createRuntime(fake.client)}>
        <TooltipProvider>
          <Composer session={s} activeRun={null} onSent={() => {}} />
        </TooltipProvider>
      </RuntimeProvider>,
    );
    return { fake, input: screen.getByRole('textbox', { name: 'メッセージ' }) };
  }

  it.each([
    ['isComposing', { isComposing: true }],
    ['keyCode 229', { keyCode: 229 }],
  ])('while an IME is composing (%s), Enter, Tab and arrows in the open list pick and send nothing', async (_, ime) => {
    const { fake, input } = composer();
    fireEvent.change(input, { target: { value: '@' } });
    const list = await screen.findByRole('listbox', { name: '呼ぶメンバー' });
    const selected = () => within(list).getAllByRole('option').findIndex((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected()).toBe(0);
    for (const key of ['ArrowDown', 'ArrowUp', 'Tab', 'Enter']) fireEvent.keyDown(input, { key, ...ime });
    expect(input).toHaveValue('@');
    expect(selected()).toBe(0);
    expect(fake.calls.some((c) => c.method === 'character.aside' || c.method === 'session.send')).toBe(false);
  });

  it('a too long ask is not sent and the words stay', async () => {
    const { fake, input } = composer({ 'character.aside': () => ({ ask: {}, reply: {} }) });
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'character.list')).toBe(true));
    const long = `@ルナ ${'あ'.repeat(4000)}`;
    fireEvent.change(input, { target: { value: long } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(fake.calls.some((c) => c.method === 'character.aside')).toBe(false);
    expect(input).toHaveValue(long);
    expect(useToasts.getState().toasts.map((t) => t.title)).toEqual([expect.stringContaining('4,000 文字まで')]);
  });

  it('a failed ask puts the words back into the composer', async () => {
    const { fake, input } = composer({
      'character.aside': () => {
        throw new Error('down');
      },
    });
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'character.list')).toBe(true));
    fireEvent.change(input, { target: { value: '@ルナ どう思う？' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'character.aside')).toBe(true));
    await waitFor(() => expect(input).toHaveValue('@ルナ どう思う？'));
  });
});

describe('who an @name calls in', () => {
  const YAMADA = member({ id: 'chr_00000000000000000000000003', name: '山田 太郎' });
  const YAMA = member({ id: 'chr_00000000000000000000000004', name: '山田' });
  const BOB = member({ id: 'chr_00000000000000000000000005', name: 'Bob' });
  const roster = [YAMA, YAMADA, BOB];

  it('takes the longest name the text starts with, in any case, followed by a space or the end', () => {
    expect(mentionOf('@山田 太郎 どう？', roster).member).toBe(YAMADA);
    expect(mentionOf('@山田 どう？', roster).member).toBe(YAMA);
    expect(mentionOf('＠山田', roster).member).toBe(YAMA);
    expect(mentionOf('@bob hi', roster).member).toBe(BOB);
    expect(mentionOf('@BOB', roster).member).toBe(BOB);
    expect(mentionOf('@Bobby hi', roster)).toEqual({ member: null, mention: true });
    expect(mentionOf('@ Bob', roster)).toEqual({ member: null, mention: false });
    expect(mentionOf('hi @Bob', roster)).toEqual({ member: null, mention: false });
  });
});

describe('asking a member', () => {
  it('waits as long as the daemon may take, and refreshes the member pages after', async () => {
    const fake = createFakeClient({ 'character.aside': () => ({ ask: {}, reply: {} }) });
    const opts: unknown[] = [];
    const call = fake.client.call.bind(fake.client) as (m: string, p: unknown) => Promise<unknown>;
    fake.client.call = ((method: string, params: unknown, o?: unknown) => {
      opts.push(o);
      return call(method, params);
    }) as typeof fake.client.call;
    const rt = createRuntime(fake.client);
    const invalidate = vi.spyOn(rt.queryClient, 'invalidateQueries');
    const s = session({ kind: 'chat' });
    await expect(askMember(rt, s.id, LUNA.id, '@ルナ どう？')).resolves.toBe(true);
    expect(ASK_TIMEOUT_MS).toBeGreaterThanOrEqual(240_000);
    expect(opts.at(-1)).toEqual({ timeoutMs: ASK_TIMEOUT_MS });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['character', 'get'] });
    rt.dispose();
  });
});

describe('a speaker that is a member with no profile yet', () => {
  it('shows the persona it was given instead of an empty line', async () => {
    const blank = { ...HAKU, profile: '' };
    const spawn = {
      id: 't1',
      name: 'mcp__acc__session__spawn',
      input: { title: 'ハク', goal: '最初の意見', mode: 'chat', persona: 'のんびり屋。', characterId: HAKU.id },
      output: JSON.stringify({ session: { id: 'ses_h' } }),
      done: true,
      isError: false,
      desc: { category: 'control' as const, label: '', activity: '', target: null, additions: null, deletions: null },
      at: iso(T0),
      endedAt: null,
      decision: null,
    };
    const child = { ...card({ id: 'ses_h', title: 'ハク', role: 'speaker', parentId: 'ses_root', depth: 1 }), characterId: HAKU.id };
    mount(<PlanCard rationale={null} spawns={[spawn]} children={[child]} />, { members: [blank] });
    const cast = screen.getByRole('region', { name: '話し手' });
    // The member is known once the keep button goes.
    await waitFor(() => expect(within(cast).queryByRole('button', { name: /名簿に残す/ })).toBeNull());
    expect(within(cast).getByRole('listitem')).toHaveTextContent('のんびり屋。');
  });
});

describe('a remark in the conversation', () => {
  it("shows the member's face and name; the name opens its page", async () => {
    mount(<AsideRemark characterId={LUNA.id} text="cancel に一票〜" />);
    const name = await screen.findByRole('button', { name: 'ルナ' });
    expect(screen.getByText('cancel に一票〜')).toBeInTheDocument();
    fireEvent.click(name);
    expect(useUi.getState()).toMatchObject({ mode: 'member', memberId: LUNA.id });
  });

  it('keeps the words of a member that is not loaded, under a neutral face and メンバー', async () => {
    mount(<AsideRemark characterId="chr_00000000000000000000000099" text="まだ読み込み中" />);
    expect(screen.getByText('まだ読み込み中')).toBeInTheDocument();
    expect(screen.getByText('メンバー')).toBeInTheDocument();
    expect(document.querySelector('[data-face]')).toHaveTextContent('?');
  });
});
