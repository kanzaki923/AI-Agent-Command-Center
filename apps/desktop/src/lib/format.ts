import type { CostSource, Usage } from '@acc/protocol';

/** Elapsed `mm:ss`, or `h:mm:ss` from one hour (ui-design §9.4). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `14:03` */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `14:03:21` */
export function formatClockSeconds(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Tooltip form: `2026/10/29 14:03:21` */
export function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${formatClockSeconds(iso)}`;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Today: `14:03` (or `3 分前` within the hour when `relative`), yesterday `昨日 14:03`,
 * older `10/27`.
 */
export function formatTimestamp(iso: string, now: number, relative = false): string {
  const t = Date.parse(iso);
  const diff = now - t;
  if (relative && diff >= 0 && diff < 60_000) return 'たった今';
  if (relative && diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分前`;
  const today = startOfDay(now);
  if (t >= today) return formatClock(iso);
  if (t >= today - 86_400_000) return `昨日 ${formatClock(iso)}`;
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export type DayBucket = 'today' | 'yesterday' | 'week' | 'older';
export const DAY_BUCKET_LABEL: Record<DayBucket, string> = {
  today: '今日',
  yesterday: '昨日',
  week: '今週',
  older: 'それ以前',
};

export function dayBucket(iso: string, now: number): DayBucket {
  const t = Date.parse(iso);
  const today = startOfDay(now);
  if (t >= today) return 'today';
  if (t >= today - 86_400_000) return 'yesterday';
  if (t >= today - 6 * 86_400_000) return 'week';
  return 'older';
}

export interface CostView {
  text: string;
  tooltip: string | null;
  source: CostSource;
}

/**
 * reported `$0.42`, estimated `≈$0.42` (tooltip explains), unknown `—` (concept §5.1).
 * `demo` appends `（デモ）` and is always $0.00.
 */
export function formatCost(
  usd: number,
  source: CostSource,
  opts: { demo?: boolean } = {},
): CostView {
  if (opts.demo) return { text: '$0.00（デモ）', tooltip: 'デモモードでは費用はかかりません', source };
  if (source === 'unknown') return { text: '—', tooltip: 'コストを取得できない接続です', source };
  const v = usd < 10 ? usd.toFixed(2) : usd.toFixed(1);
  if (source === 'estimated') return { text: `≈$${v}`, tooltip: 'トークン数からの推定値です', source };
  return { text: `$${v}`, tooltip: null, source };
}

/**
 * Sum usages: the result is `unknown` only when nothing was measured, `estimated` when any
 * part is an estimate.
 */
export function sumUsage(usages: Usage[]): { costUsd: number; costSource: CostSource } {
  let cost = 0;
  let anyReported = false;
  let anyEstimated = false;
  for (const u of usages) {
    if (u.costSource === 'unknown') continue;
    cost += u.costUsd;
    if (u.costSource === 'estimated') anyEstimated = true;
    else anyReported = true;
  }
  const costSource: CostSource = anyEstimated ? 'estimated' : anyReported ? 'reported' : 'unknown';
  return { costUsd: cost, costSource };
}

/** `+58 −12` (U+2212 minus). */
export function formatDiffStat(additions: number, deletions: number): string {
  return `+${additions} −${deletions}`;
}

export function formatCount(n: number): string {
  return `${n} 件`;
}
