import type { ModelInfo, UsageDay, UsageStatsRow } from '@acc/protocol';
import { ChartBar, Table2 } from 'lucide-react';
import { useState } from 'react';
import { useUsageStats } from '../../daemon/cost';
import { useModels } from '../../daemon/queries';
import { cn } from '../../lib/cn';
import { shortModel } from '../../lib/models';
import { type UsageView, useUi } from '../../store/ui';
import { Tooltip } from '../ui/Tooltip';
import { type SegmentOption, Segmented } from './controls';

/**
 * 利用統計 (the second tab of the settings dialog). Spend comes first: the people this is for
 * pay per token (LiteLLM, API keys) and watch the cost. Tokens are shown beside it, and the
 * chart draws both per model on bars of their own scale, so a model that reads a lot for
 * little money and one that costs a lot for few tokens look different at a glance; the
 * figures (cost per 1M tokens, cache share, calls) are in the table. A ChatGPT plan reads
 * 契約枠, not $0. The full record of every call is the daemon's log (`usage.calls`).
 */

type Range = 'today' | '7d' | '30d';
const RANGE_OPTIONS: readonly SegmentOption<Range>[] = [
  { value: 'today', label: '今日' },
  { value: '7d', label: '7 日' },
  { value: '30d', label: '30 日' },
];

const icon = (I: typeof ChartBar) => <I size={13} strokeWidth={1.75} />;
const VIEW_OPTIONS: readonly SegmentOption<UsageView>[] = [
  { value: 'chart', label: 'グラフ', icon: icon(ChartBar), iconOnly: true },
  { value: 'table', label: '表', icon: icon(Table2), iconOnly: true },
];

/** `950` / `12.3k` / `4.5M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Number((n / 1000).toFixed(n < 10_000 ? 1 : 0))}k`;
  return `${Number((n / 1_000_000).toFixed(1))}M`;
}

/**
 * `$0.00` / `<$0.01` / `$8.20` / `$1,234.50`: always two decimals, so right-aligned figures
 * line up on the point; `≈` in front when it is an estimate.
 */
export function formatSpend(usd: number, estimated = false): string {
  const v =
    usd <= 0
      ? '$0.00'
      : usd < 0.005
        ? '<$0.01'
        : `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // `<$0.01` is loose already: no `≈` in front of it.
  return estimated && usd >= 0.005 ? `≈${v}` : v;
}

/** Percent of the logged input read from the prompt cache; null when nothing was logged. */
export function cacheShare(cache: UsageStatsRow['cache']): number | null {
  if (!cache || cache.inputTokens <= 0) return null;
  return Math.round((Math.min(cache.readTokens, cache.inputTokens) / cache.inputTokens) * 100);
}

/** What 1M tokens (input and output together) actually cost on a row; null without both. */
export function costPerMTok(r: Pick<UsageStatsRow, 'usd' | 'inputTokens' | 'outputTokens'>): number | null {
  const tokens = tokensOf(r);
  return tokens > 0 && r.usd > 0 ? (r.usd / tokens) * 1_000_000 : null;
}

/** `10/31` from a YYYY-MM-DD day. */
export function dayLabel(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(m)}/${Number(d)}`;
}

const tokensOf = (r: { inputTokens: number; outputTokens: number }) => r.inputTokens + r.outputTokens;

/** Whether a model runs on a ChatGPT plan (its use costs nothing per token). */
function usePlan(): (model: string) => boolean {
  const models = useModels().data?.models;
  return (model) => models?.some((m: ModelInfo) => m.id === model && m.provider === 'chatgpt') ?? false;
}

export function UsageStatsPanel() {
  const [range, setRange] = useState<Range>('30d');
  const view = useUi((s) => s.usageView);
  const setView = useUi((s) => s.setUsageView);
  const stats = useUsageStats(range).data;
  const onPlan = usePlan();
  // Spend first, then what was used.
  const rows = [...(stats?.rows ?? [])].sort((a, b) => b.usd - a.usd || tokensOf(b) - tokensOf(a));
  return (
    <div className="flex flex-col gap-3 pt-2 pb-4" data-testid="usage-stats">
      <div className="flex items-center gap-3">
        <Segmented<Range> label="期間" value={range} options={RANGE_OPTIONS} onChange={setRange} />
        <Segmented<UsageView> label="見え方" value={view} options={VIEW_OPTIONS} onChange={setView} />
        <span className="flex-1" />
        <span className="text-meta text-fg-3">合計</span>
        <span className="text-title tabular text-fg" data-testid="usage-total">
          {formatSpend(stats?.totalUsd ?? 0, stats?.estimated ?? false)}
        </span>
      </div>
      {rows.length === 0 || !stats ? (
        <p className="py-6 text-center text-ui text-fg-3">この期間はまだ使っていません</p>
      ) : view === 'table' ? (
        <UsageTable rows={rows} onPlan={onPlan} />
      ) : (
        <UsageChart rows={rows} days={range === 'today' ? null : stats.days} onPlan={onPlan} />
      )}
    </div>
  );
}

/** The spend of a row: 契約枠 on a plan, else dollars. */
function Spend({ row: r, onPlan }: { row: UsageStatsRow; onPlan: (m: string) => boolean }) {
  if (r.usd <= 0 && onPlan(r.model)) return <span className="text-fg-3">契約枠</span>;
  return <span className={r.usd > 0 ? 'text-fg' : 'text-fg-3'}>{formatSpend(r.usd, r.estimated)}</span>;
}

// ---------------------------------------------------------------------------
// Chart: spend per day stacked by model, then per model spend and tokens on bars of
// their own scale
// ---------------------------------------------------------------------------

/** Models that get a colour of their own; the rest fold into その他. */
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];
const OTHER_COLOR = 'var(--text-tertiary)';
const OTHER = 'その他';
const TOKENS_COLOR = 'color-mix(in oklch, var(--text-tertiary) 55%, transparent)';

/**
 * The colour of each model: the ones that spent most in the range, in the fixed order of the
 * series, so a model has the same colour in the columns and in its row.
 */
export function seriesColors(rows: readonly UsageStatsRow[]): Map<string, string> {
  const spent = rows.filter((r) => r.usd > 0).sort((a, b) => b.usd - a.usd);
  return new Map(spent.slice(0, SERIES.length).map((r, i) => [r.model, SERIES[i]!]));
}

function UsageChart({
  rows,
  days,
  onPlan,
}: {
  rows: UsageStatsRow[];
  days: UsageDay[] | null;
  onPlan: (m: string) => boolean;
}) {
  const colors = seriesColors(rows);
  const maxUsd = Math.max(0, ...rows.map((r) => r.usd));
  const maxTokens = Math.max(1, ...rows.map(tokensOf));
  return (
    <div className="flex flex-col gap-4" data-testid="usage-chart">
      {days && days.length > 1 && days.some((d) => d.usd > 0) && (
        <DayColumns days={days} colors={colors} />
      )}
      <div role="list" aria-label="モデルごとの費用とトークン" className="flex flex-col">
        <div className={cn(BAR_COLS, 'pb-1 text-micro text-fg-3')} aria-hidden>
          <span>モデル</span>
          <span />
          <span className="text-right">費用</span>
          <span className="text-right">トークン</span>
        </div>
        {rows.map((r) => (
          <ModelBars
            key={r.model}
            row={r}
            color={colors.get(r.model) ?? OTHER_COLOR}
            maxUsd={maxUsd}
            maxTokens={maxTokens}
            onPlan={onPlan}
          />
        ))}
      </div>
      <div className="flex items-center gap-4 text-micro text-fg-3" data-testid="usage-legend">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-xs bg-fg-3" aria-hidden />
          費用
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1 w-3 rounded-xs" style={{ background: TOKENS_COLOR }} aria-hidden />
          トークン
        </span>
      </div>
    </div>
  );
}

/** A day's spend as parts per model in the order of the series; the rest as one その他. */
export function dayParts(
  d: UsageDay,
  colors: ReadonlyMap<string, string>,
): { model: string; usd: number; color: string }[] {
  const order = [...colors.keys()];
  const own = d.models
    .filter((m) => colors.has(m.model))
    .sort((a, b) => order.indexOf(a.model) - order.indexOf(b.model));
  const rest = d.models.filter((m) => !colors.has(m.model)).reduce((n, m) => n + m.usd, 0);
  return [
    ...own.map((m) => ({ ...m, color: colors.get(m.model)! })),
    ...(rest > 0 ? [{ model: OTHER, usd: rest, color: OTHER_COLOR }] : []),
  ];
}

const DAY_HEIGHT = 44;

/**
 * Spend of each day as a column stacked by model (the first series at the base), the peak
 * labelled; hovering a column lists the day by model.
 */
function DayColumns({ days, colors }: { days: UsageDay[]; colors: ReadonlyMap<string, string> }) {
  const max = Math.max(...days.map((d) => d.usd));
  const peak = days.findIndex((d) => d.usd === max);
  const labelAll = days.length <= 7;
  return (
    <div className="flex flex-col gap-1" data-testid="usage-days">
      <div
        className="flex items-end gap-[2px] border-b border-line-subtle"
        style={{ height: DAY_HEIGHT + 18 }}
        aria-label="日ごとの費用"
      >
        {days.map((d, i) => {
          const parts = dayParts(d, colors);
          return (
            <Tooltip key={d.day} content={<DayTip day={d} parts={parts} />}>
              <span className="flex h-full flex-1 cursor-default flex-col items-center justify-end">
                {i === peak && (
                  <span className="pb-0.5 text-micro whitespace-nowrap text-fg-2 tabular">
                    {formatSpend(d.usd)}
                  </span>
                )}
                {/* From the base up: the first series sits at the bottom, 2px apart. */}
                <span className="flex w-full max-w-6 flex-col-reverse gap-[2px]" data-testid="usage-day">
                  {parts.map((p, j) => (
                    <span
                      key={p.model}
                      className={cn('w-full', j === parts.length - 1 && 'rounded-t-xs')}
                      data-part={p.model}
                      style={{ height: Math.max(1, (p.usd / max) * DAY_HEIGHT), background: p.color }}
                    />
                  ))}
                </span>
              </span>
            </Tooltip>
          );
        })}
      </div>
      <div className={cn('flex text-micro text-fg-3 tabular', labelAll ? '' : 'justify-between')}>
        {labelAll ? (
          days.map((d) => (
            <span key={d.day} className="flex-1 text-center">
              {dayLabel(d.day)}
            </span>
          ))
        ) : (
          <>
            <span>{dayLabel(days[0]!.day)}</span>
            <span>{dayLabel(days[days.length - 1]!.day)}</span>
          </>
        )}
      </div>
    </div>
  );
}

/** A day by model: the total on top, then each model with its colour and spend. */
function DayTip({ day: d, parts }: { day: UsageDay; parts: ReturnType<typeof dayParts> }) {
  return (
    <span className="flex flex-col gap-0.5 tabular">
      <span>
        {dayLabel(d.day)} · {formatSpend(d.usd)} · {formatTokens(tokensOf(d))} トークン
      </span>
      {parts.map((p) => (
        <span key={p.model} className="flex items-center gap-1.5">
          <span className="size-2 shrink-0 rounded-xs" style={{ background: p.color }} aria-hidden />
          <span className="flex-1">{p.model === OTHER ? OTHER : shortModel(p.model) || p.model}</span>
          <span className="pl-3">{formatSpend(p.usd)}</span>
        </span>
      ))}
    </span>
  );
}

/** name · bars · spend · tokens */
const BAR_COLS = 'grid grid-cols-[112px_minmax(0,1fr)_80px_56px] items-center gap-3';

/**
 * One model: a bar of its spend (against the highest spend) in its colour over a thin bar of
 * its tokens (against the most tokens). Which of the two is longer tells what a token costs
 * there; the colour ties the row to its part of the day columns.
 */
function ModelBars({
  row: r,
  color,
  maxUsd,
  maxTokens,
  onPlan,
}: {
  row: UsageStatsRow;
  color: string;
  maxUsd: number;
  maxTokens: number;
  onPlan: (m: string) => boolean;
}) {
  const tokens = tokensOf(r);
  const share = cacheShare(r.cache);
  const perM = costPerMTok(r);
  const tip = [
    `入力 ${formatTokens(r.inputTokens)}${share === null ? '' : `（キャッシュから ${share}%）`}`,
    `出力 ${formatTokens(r.outputTokens)}`,
    perM === null ? null : `100 万トークンあたり ${formatSpend(perM)}`,
    r.calls > 0 ? `呼び出し ${r.calls}${r.failedCalls > 0 ? `（失敗 ${r.failedCalls}）` : ''}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Tooltip content={tip}>
      <div role="listitem" data-testid="usage-bar" className={cn(BAR_COLS, 'h-8 cursor-default')}>
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className="size-2 shrink-0 rounded-xs"
            style={{ background: r.usd > 0 ? color : 'transparent' }}
            data-testid="usage-swatch"
            aria-hidden
          />
          <span className="truncate text-meta text-fg">{shortModel(r.model) || r.model}</span>
        </span>
        <span className="flex flex-col gap-[3px]">
          <span
            className="h-2 rounded-xs"
            data-part="spend"
            style={{
              width: r.usd > 0 && maxUsd > 0 ? `max(2px, ${(r.usd / maxUsd) * 100}%)` : 0,
              background: color,
            }}
          />
          <span
            className="h-1 rounded-xs"
            data-part="tokens"
            style={{
              width: tokens > 0 ? `max(2px, ${(tokens / maxTokens) * 100}%)` : 0,
              background: TOKENS_COLOR,
            }}
          />
        </span>
        <span className="text-right text-meta tabular">
          <Spend row={r} onPlan={onPlan} />
        </span>
        <span className="text-right text-meta text-fg-3 tabular">{formatTokens(tokens)}</span>
      </div>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Table: the figures
// ---------------------------------------------------------------------------

const COLS = 'grid grid-cols-[minmax(0,1fr)_80px_52px_52px_72px_56px_48px] items-center gap-2';

function UsageTable({ rows, onPlan }: { rows: UsageStatsRow[]; onPlan: (m: string) => boolean }) {
  return (
    <div role="table" aria-label="モデルごとの利用" className="flex flex-col">
      <div role="row" className={`${COLS} border-b border-line-subtle pb-1 text-micro text-fg-3`}>
        <span role="columnheader">モデル</span>
        <span role="columnheader" className="text-right">費用</span>
        <span role="columnheader" className="text-right">入力</span>
        <span role="columnheader" className="text-right">出力</span>
        <Tooltip content="入力と出力を合わせた 100 万トークンあたりの費用">
          <span role="columnheader" className="cursor-default text-right">
            100 万あたり
          </span>
        </Tooltip>
        <span role="columnheader" className="text-right">キャッシュ</span>
        <span role="columnheader" className="text-right">呼び出し</span>
      </div>
      {rows.map((r) => (
        <Row key={r.model} row={r} onPlan={onPlan} />
      ))}
    </div>
  );
}

function Row({ row: r, onPlan }: { row: UsageStatsRow; onPlan: (m: string) => boolean }) {
  const share = cacheShare(r.cache);
  const perM = costPerMTok(r);
  const cacheTip = [
    `読み ${formatTokens(r.cache?.readTokens ?? 0)} · 書き ${formatTokens(r.cache?.writeTokens ?? 0)} トークン`,
    r.prefixBreaks > 0 ? `先頭が前回と変わった呼び出し ${r.prefixBreaks} 回` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const none = <span className="text-fg-3">—</span>;
  return (
    <div role="row" data-testid="usage-row" className={`${COLS} py-1.5 text-meta tabular`}>
      <Tooltip content={r.model}>
        <span role="cell" className="truncate text-fg">
          {shortModel(r.model) || r.model}
        </span>
      </Tooltip>
      <span role="cell" className="text-right">
        <Spend row={r} onPlan={onPlan} />
      </span>
      <span role="cell" className="text-right text-fg-2">
        {formatTokens(r.inputTokens)}
      </span>
      <span role="cell" className="text-right text-fg-2">
        {formatTokens(r.outputTokens)}
      </span>
      <span role="cell" className="text-right text-fg-2" data-testid="usage-per-m">
        {perM === null ? none : formatSpend(perM)}
      </span>
      <Tooltip content={share === null ? null : cacheTip}>
        <span role="cell" className="text-right text-fg-2" data-testid="usage-cache">
          {share === null ? none : `${share}%`}
          {r.prefixBreaks > 0 && <span className="ml-0.5 text-st-needs_you">!</span>}
        </span>
      </Tooltip>
      {/* Agents (Claude Code) make their own calls: the daemon does not count them. */}
      <Tooltip content={r.failedCalls > 0 ? `うち失敗 ${r.failedCalls} 回` : null}>
        <span role="cell" className="text-right text-fg-2">
          {r.calls > 0 ? r.calls : none}
          {r.failedCalls > 0 && <span className="ml-0.5 text-st-failed">!</span>}
        </span>
      </Tooltip>
    </div>
  );
}
