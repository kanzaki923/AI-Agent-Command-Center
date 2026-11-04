import type { Character, CharacterDetail, CharacterMemory, Session } from '@acc/protocol';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { T0, card, homeSnapshot, iso, session } from '../../test/fixtures';
import { speakerTones } from '../focus/Speech';
import { Sidebar } from '../shell/Sidebar';
import { TooltipProvider } from '../ui/Tooltip';
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

function mount(ui: React.ReactNode, { members = [HAKU, LUNA], sessions = [] as Session[], page }: {
  members?: Character[];
  sessions?: Session[];
  page?: CharacterDetail;
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
  render(
    <RuntimeProvider runtime={createRuntime(fake.client)}>
      <TooltipProvider>{ui}</TooltipProvider>
    </RuntimeProvider>,
  );
  return fake;
}

beforeEach(() => {
  useUi.setState({ mode: 'home', memberId: null, draftMemberId: null, back: [], forward: [] });
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
