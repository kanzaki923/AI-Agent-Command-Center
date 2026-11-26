import type { Character, CharacterDetail, DigestOutcome, DigestStatus, ParamsInput } from '@acc/protocol';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { formatTimestamp } from '../lib/format';
import { toast, toastError } from '../store/toast';
import { useUi } from '../store/ui';
import { qk } from './keys';
import { type AppRuntime, useRuntime } from './runtime';

const NONE: Character[] = [];

/**
 * The roster (`character.list`, taken-off members included so old conversations keep their
 * face). character.* events refetch it (daemon/live.ts).
 */
export function useAllMembers(): Character[] {
  const rt = useRuntime();
  return (
    useQuery<Character[]>({
      queryKey: qk.characters,
      queryFn: () =>
        rt.callOr('character.list', { includeArchived: true }, { items: [] }).then((r) => r.items),
      staleTime: 30_000,
    }).data ?? NONE
  );
}

/** The members on the roster, in roster order. */
export function useMembers(): Character[] {
  const all = useAllMembers();
  return useMemo(() => all.filter((c) => !c.archivedAt), [all]);
}

/** One member by id (also one taken off the roster), or undefined. */
export function useMember(id: string | null | undefined): Character | undefined {
  const all = useAllMembers();
  return useMemo(() => (id ? all.find((c) => c.id === id) : undefined), [all, id]);
}

/** A member's page: its conversations and what they cost this month. */
export function useMemberPage(id: string | null) {
  const rt = useRuntime();
  return useQuery<CharacterDetail>({
    queryKey: qk.character(id ?? ''),
    queryFn: () => rt.client.call('character.get', { characterId: id! }),
    enabled: !!id,
  });
}

/** The face of a member: its own one character, or the first letter of its name. */
export function faceOf(c: Pick<Character, 'face' | 'name'>): string {
  return c.face?.trim() || ([...c.name.trim()][0] ?? '?');
}

const refresh = (rt: AppRuntime) => void rt.queryClient.invalidateQueries({ queryKey: ['character'] });

async function attempt<T>(rt: AppRuntime, fn: () => Promise<T>, failed: string): Promise<T | null> {
  try {
    const out = await fn();
    refresh(rt);
    return out;
  } catch (err) {
    toastError(err, failed);
    return null;
  }
}

export const createMember = (rt: AppRuntime, p: ParamsInput<'character.create'>) =>
  attempt(rt, () => rt.client.call('character.create', p), 'メンバーを作れませんでした');

export const updateMember = (rt: AppRuntime, p: ParamsInput<'character.update'>) =>
  attempt(rt, () => rt.client.call('character.update', p), 'メンバーを変えられませんでした');

export const archiveMember = (rt: AppRuntime, characterId: string, archived = true) =>
  attempt(
    rt,
    () => rt.client.call('character.archive', { characterId, archived }),
    archived ? '名簿から外せませんでした' : '名簿に戻せませんでした',
  );

export const reorderMembers = (rt: AppRuntime, characterIds: string[]) =>
  attempt(rt, () => rt.client.call('character.reorder', { characterIds }), '並べ替えられませんでした');

/** Keep the character a speaker played as a member of the roster. */
export const keepMember = (rt: AppRuntime, sessionId: string) =>
  attempt(rt, () => rt.client.call('character.keep', { sessionId }), '名簿に残せませんでした');

/** Choose who a conversation is with (before anything is said), or nobody (null). */
export const setSessionMember = (rt: AppRuntime, sessionId: string, characterId: string | null) =>
  attempt(
    rt,
    () => rt.client.call('session.update', { sessionId, characterId }),
    '会話の相手を変えられませんでした',
  );

/** Seat a member in the assistant's place, or empty the seat (null). */
export const setAssistantSeat = async (rt: AppRuntime, characterId: string | null) => {
  const out = await attempt(
    rt,
    () => rt.client.call('settings.update', { assistant: { characterId } }),
    '右腕の席を変えられませんでした',
  );
  if (out) void rt.queryClient.invalidateQueries({ queryKey: qk.settings });
  return out;
};

/** The member in the assistant's seat (null: none). */
export function useAssistantSeat(settingsSeat: string | null | undefined): Character | undefined {
  const member = useMember(settingsSeat ?? null);
  return member && !member.archivedAt ? member : undefined;
}

/** When a memory is from: 今日 / 昨日 / N日前 within a month, the month (and year) before. */
export function memoryWhen(at: string, now = new Date()): string {
  const d = new Date(at);
  const day = (x: Date) => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days <= 0) return '今日';
  if (days === 1) return '昨日';
  if (days < 30) return `${days}日前`;
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}月` : `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

export const addMemory = (rt: AppRuntime, p: ParamsInput<'character.memory.add'>) =>
  attempt(rt, () => rt.client.call('character.memory.add', p), '覚えさせられませんでした');

export const updateMemory = (rt: AppRuntime, memoryId: string, text: string) =>
  attempt(rt, () => rt.client.call('character.memory.update', { memoryId, text }), '直せませんでした');

export const deleteMemory = (rt: AppRuntime, memoryId: string) =>
  attempt(rt, () => rt.client.call('character.memory.delete', { memoryId }), '忘れさせられませんでした');

let askSeq = 0;

/**
 * How long an @name ask may take: the daemon may first fold the conversation into its running
 * summary, then make a model call of up to 120s (the client's default is 30s).
 */
export const ASK_TIMEOUT_MS = 270_000;

/**
 * Ask a member for one remark in a conversation (@name). The ask shows at once as waiting
 * (ui `asking`); the daemon adds both messages when the answer is there.
 */
export async function askMember(rt: AppRuntime, sessionId: string, characterId: string, text: string): Promise<boolean> {
  const id = `ask-${++askSeq}`;
  const { setAsking } = useUi.getState();
  setAsking(sessionId, id, { characterId, text });
  try {
    await rt.client.call('character.aside', { sessionId, characterId, text }, { timeoutMs: ASK_TIMEOUT_MS });
    // The remark is spent on the member's page (cost, conversations).
    void rt.queryClient.invalidateQueries({ queryKey: ['character', 'get'] });
    return true;
  } catch (err) {
    toastError(err, '一言をもらえませんでした');
    return false;
  } finally {
    setAsking(sessionId, id, null);
  }
}

/**
 * The member an @name at the start of a message calls in, and whether one was meant. The
 * longest roster name the text starts with after the @ (any case), followed by a space or the
 * end, so names with spaces ("山田 太郎") can be called too.
 */
export function mentionOf(text: string, members: readonly Character[]): { member: Character | null; mention: boolean } {
  const t = text.trim();
  if (!/^[@＠]\S/.test(t)) return { member: null, mention: false };
  const rest = t.slice(1);
  let best: Character | null = null;
  for (const c of members) {
    const name = c.name;
    if (!name || (best && best.name.length >= name.length)) continue;
    if (rest.slice(0, name.length).toLowerCase() !== name.toLowerCase()) continue;
    const next = rest.charAt(name.length);
    if (next === '' || /\s/.test(next)) best = c;
  }
  return { member: best, mention: true };
}

/**
 * How sorting a member's memories stands (character.digestStatus). Refetched with the member's
 * page (every `character.*` event) and once a minute, since "when" moves with the clock.
 */
export function useDigestStatus(id: string | null) {
  const rt = useRuntime();
  return useQuery<DigestStatus>({
    queryKey: qk.digestStatus(id ?? ''),
    queryFn: () => rt.client.call('character.digestStatus', { characterId: id! }),
    enabled: !!id,
    refetchInterval: 60_000,
  });
}

const DIGEST_TOAST: Record<DigestOutcome, string> = {
  done: '整理しました',
  nothing_new: '新しく覚えることはありませんでした',
  off: 'メンバーの記憶はオフです',
  limit: '今日の裏の整理の上限に達しています',
  rejected: '一度に忘れすぎるため、今回の整理は使いませんでした',
  failed: '整理できませんでした',
};

/** Sort a member's memories now (character.digest), and say how it went. */
export async function digestNow(rt: AppRuntime, member: Pick<Character, 'id' | 'name'>): Promise<void> {
  try {
    const { outcome } = await rt.client.call('character.digest', { characterId: member.id });
    refresh(rt);
    const why =
      outcome === 'failed'
        ? (await rt.client.call('character.digestStatus', { characterId: member.id }).catch(() => null))
            ?.lastError
        : null;
    toast({
      title: DIGEST_TOAST[outcome],
      detail: why ?? undefined,
      tone: outcome === 'failed' ? 'error' : outcome === 'done' ? 'success' : 'info',
      sticky: false,
    });
  } catch (err) {
    toastError(err, '整理できませんでした');
  }
}

export type DigestTone = 'muted' | 'warn' | 'fail';

/**
 * One line for a member's page: why nothing is remembered yet, or when it will be. The first
 * thing that holds sorting back wins (off, no model, a failure, a limit), then what there is to
 * read and when the member has been quiet long enough.
 */
export function digestLine(
  s: DigestStatus,
  now: number,
): { text: string; tone: DigestTone; hint?: string } {
  const at = (iso: string) => formatTimestamp(iso, now);
  if (!s.enabled) return { text: '記憶はオフ', tone: 'muted', hint: '設定の「メンバーの記憶」でオンにできます' };
  if (s.offline) {
    return {
      text: '整理のモデルがありません',
      tone: 'warn',
      hint: '名簿に呼べるモデルがないため、ほとんど覚えられません。設定の「裏の整理」でモデルを選んでください',
    };
  }
  const waitUntil = [s.retryAt, s.pausedUntil].filter((x): x is string => !!x).sort().at(-1);
  if (s.lastError && waitUntil) {
    return { text: `失敗: ${s.lastError}`, tone: 'fail', hint: `${at(waitUntil)} にもう一度試します（${s.model}）` };
  }
  if (s.limitReached) return { text: '今日の上限に達しました', tone: 'warn', hint: '設定の「裏の整理」の上限か、1 日の上限です' };
  if (s.newLines === 0) return { text: '新しく覚えることはありません', tone: 'muted' };
  if (!s.enough) return { text: `まだ少なめ（${s.newLines} 行）`, tone: 'muted', hint: 'もう少し話すと整理します' };
  if (s.quietAt) {
    return { text: `${at(s.quietAt)} ごろ整理`, tone: 'muted', hint: 'どの会話でも 30 分話さなかったら整理します' };
  }
  return { text: 'まもなく整理', tone: 'muted' };
}
