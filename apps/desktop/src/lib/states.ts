import {
  type AttentionKind,
  type OutputKind,
  SESSION_STATE_PRECEDENCE,
  type SessionRole,
  type SessionState,
} from '@acc/protocol';
import {
  Bot,
  CircleCheck,
  CircleDashed,
  CirclePause,
  Circle,
  Clock,
  Coins,
  Diamond,
  Eye,
  FileText,
  Files,
  Folder,
  GitBranch,
  GitCompare,
  Hand,
  Link,
  LoaderCircle,
  type LucideIcon,
  MessageCircleQuestion,
  MessageSquare,
  Repeat,
  ShieldQuestion,
  Table,
  TriangleAlert,
} from 'lucide-react';

/**
 * The visual vocabulary shared by every screen (ui-redesign spec §1). Colours, icons, labels
 * and orderings live here and only here; components read them instead of choosing their own.
 */

export interface StateMeta {
  /** CSS colour (a state token from index.css). */
  color: string;
  icon: LucideIcon;
  /** Tooltip / screen reader label. */
  label: string;
}

export const STATE_META: Record<SessionState, StateMeta> = {
  needs_you: { color: 'var(--st-needs_you)', icon: Hand, label: 'あなたの出番' },
  failed: { color: 'var(--st-failed)', icon: TriangleAlert, label: '失敗' },
  working: { color: 'var(--st-working)', icon: LoaderCircle, label: '作業中' },
  supervising: { color: 'var(--st-supervising)', icon: Diamond, label: '子の作業待ち' },
  queued: { color: 'var(--st-queued)', icon: CircleDashed, label: '順番待ち' },
  review: { color: 'var(--st-review)', icon: Eye, label: '確認待ち' },
  stopped: { color: 'var(--st-stopped)', icon: CirclePause, label: '停止中' },
  done: { color: 'var(--st-done)', icon: CircleCheck, label: '完了' },
  idle: { color: 'var(--st-idle)', icon: Circle, label: '待機' },
};

/** Sort / count order: needs_you > failed > working > supervising > queued > review > stopped > done > idle. */
export const STATE_ORDER: readonly SessionState[] = SESSION_STATE_PRECEDENCE;

const RANK = new Map(STATE_ORDER.map((s, i) => [s, i]));
export function stateRank(state: SessionState): number {
  return RANK.get(state) ?? STATE_ORDER.length;
}

/** Stable sort by state priority; items of the same state keep their given (daemon) order. */
export function sortByState<T>(items: readonly T[], stateOf: (item: T) => SessionState): T[] {
  return items
    .map((item, i) => ({ item, i, r: stateRank(stateOf(item)) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.item);
}

/** A human (needs_you) or a problem (failed) is involved: the chip gets a coloured frame. */
export function isAlarm(state: SessionState): boolean {
  return state === 'needs_you' || state === 'failed';
}

/** Something is still moving or waiting (not settled). Settled = done / idle / stopped. */
export function isSettled(state: SessionState): boolean {
  return state === 'done' || state === 'idle' || state === 'stopped';
}

// ---------------------------------------------------------------------------------- icons

export const ROLE_META: Record<SessionRole, { icon: LucideIcon; label: string; filled: boolean }> = {
  chat: { icon: MessageSquare, label: '会話', filled: false },
  agent: { icon: Bot, label: 'エージェント', filled: false },
  supervisor: { icon: Diamond, label: '任せた会話', filled: true },
};

/** Who started a session; `ai` has no mark (the tree position says it). */
export const SCHEDULE_ICON: LucideIcon = Clock;

export const ATTENTION_META: Record<AttentionKind, { icon: LucideIcon; label: string }> = {
  question: { icon: MessageCircleQuestion, label: '質問' },
  approval: { icon: ShieldQuestion, label: '確認' },
  failure: { icon: TriangleAlert, label: '失敗' },
  review: { icon: Eye, label: '確認待ち' },
  budget: { icon: Coins, label: '予算' },
  stuck: { icon: Repeat, label: '止まっている' },
};

export const OUTPUT_META: Record<OutputKind, { icon: LucideIcon; label: string }> = {
  document: { icon: FileText, label: '文書' },
  data: { icon: Table, label: '表' },
  link: { icon: Link, label: 'リンク' },
  files: { icon: Files, label: 'ファイル' },
  code: { icon: GitCompare, label: '変更' },
};

/** Workspace kinds as the UI names them; `none` shows nothing. */
export type WorkspaceKind = 'none' | 'folder' | 'worktree';
export const WORKSPACE_META: Record<Exclude<WorkspaceKind, 'none'>, { icon: LucideIcon; label: string }> = {
  folder: { icon: Folder, label: 'フォルダ' },
  worktree: { icon: GitBranch, label: 'コード' },
};

// ---------------------------------------------------------------------------------- numbers

/** `$0.21`; under half a cent `<$0.01`; zero (or nothing) → null (show nothing). */
export function formatUsd(usd: number | null | undefined): string | null {
  if (usd == null || !Number.isFinite(usd) || usd <= 0) return null;
  if (usd < 0.005) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** Budget meter tone: over 80% amber, at the limit red. */
export function budgetTone(usedUsd: number, limitUsd: number): 'ok' | 'warn' | 'over' {
  if (limitUsd <= 0) return 'over';
  const r = usedUsd / limitUsd;
  if (r >= 1) return 'over';
  if (r > 0.8) return 'warn';
  return 'ok';
}

const MIN = 60_000;
const HOUR = 60 * MIN;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Time since a state began. Ongoing (`settled: false`): `30秒` `4分` `2時間` `3日`.
 * Finished: `たった今` `12分前` `3時間前` `昨日` `10/27`.
 */
export function formatSince(sinceIso: string, now: number, settled: boolean): string {
  const t = Date.parse(sinceIso);
  const ms = Math.max(0, now - t);
  if (!settled) {
    if (ms < MIN) return `${Math.floor(ms / 1000)}秒`;
    if (ms < HOUR) return `${Math.floor(ms / MIN)}分`;
    if (ms < 24 * HOUR) return `${Math.floor(ms / HOUR)}時間`;
    return `${Math.floor(ms / (24 * HOUR))}日`;
  }
  if (ms < MIN) return 'たった今';
  if (ms < HOUR) return `${Math.floor(ms / MIN)}分前`;
  const today = startOfDay(now);
  if (t >= today) return `${Math.floor(ms / HOUR)}時間前`;
  if (t >= today - 24 * HOUR) return '昨日';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** `9:00` (today), `明日 9:00`, `10/31 9:00` for a future time (next schedule run). */
export function formatNextRun(iso: string, now: number): string {
  const d = new Date(iso);
  const clock = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  const t = d.getTime();
  const today = startOfDay(now);
  if (t < today + 24 * HOUR) return clock;
  if (t < today + 48 * HOUR) return `明日 ${clock}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${clock}`;
}

/** Display title of a session; an empty title reads as what it is. */
export function sessionTitle(s: { title: string; kind?: 'chat' | 'agent' }): string {
  if (s.title.trim()) return s.title;
  return s.kind === 'agent' ? '無題のエージェント' : '新しい会話';
}
