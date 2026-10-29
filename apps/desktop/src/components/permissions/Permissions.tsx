import type { PermissionProfile, PermissionRule, Run } from '@acc/protocol';
import { Repeat, ShieldBan, ShieldCheck } from 'lucide-react';
import { useMemo } from 'react';
import { revokePermissionRule } from '../../daemon/actions';
import { usePermissionRules, useSessionEventVersion, useTasks } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { cn } from '../../lib/cn';
import {
  DECIDER,
  HARD_RULES_LINE,
  PROFILES,
  PROFILE_INFO,
  decisionSummaryText,
  describeDecision,
  gateText,
  recentBlocks,
  ruleScopeText,
  summarizeDecisions,
} from '../../model/permissions';
import { useTimeline } from '../../store/timeline';
import { useUi } from '../../store/ui';
import { Button } from '../ui/Button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Menu';
import { TimeStamp } from '../ui/Meta';

const NONE: never[] = [];

/**
 * The three profiles as a radio list, each with one plain line of what runs without asking
 * (§5.6). `inherit` adds "全体の既定に従う" first (a project that follows the global default).
 */
export function ProfilePicker({
  value,
  onChange,
  inherit,
  label,
}: {
  /** null = follows the global default (only with `inherit`). */
  value: PermissionProfile | null;
  onChange: (v: PermissionProfile | null) => void;
  /** The global default, when the project may follow it. */
  inherit?: PermissionProfile;
  label: string;
}) {
  const options: { value: PermissionProfile | null; title: string; line: string }[] = [
    ...(inherit
      ? [
          {
            value: null,
            title: `全体の既定に従う（${PROFILE_INFO[inherit].label}）`,
            line: '設定の「エージェントの権限」を変えると、このプロジェクトも変わります。',
          },
        ]
      : []),
    ...PROFILES.map((p) => ({
      value: p,
      title: p === 'autonomous' ? `${PROFILE_INFO[p].label}（推奨）` : PROFILE_INFO[p].label,
      line: PROFILE_INFO[p].line,
    })),
  ];
  const move = (dir: 1 | -1) => {
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + dir + options.length) % options.length]!;
    onChange(next.value);
    return next.value;
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex flex-col overflow-hidden rounded-sm border border-line"
      onKeyDown={(e) => {
        // Arrow keys move the choice like native radios (and the focus with it).
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const v = move(e.key === 'ArrowDown' ? 1 : -1);
        const el = e.currentTarget.querySelector<HTMLElement>(`[data-profile="${v ?? 'inherit'}"]`);
        el?.focus();
      }}
    >
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value ?? 'inherit'}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-profile={o.value ?? 'inherit'}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex items-start gap-2.5 border-b border-line-subtle px-3 py-2 text-left last:border-b-0',
              checked ? 'bg-selected' : 'hover:bg-hover',
            )}
          >
            <span
              className={cn(
                'mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-full border',
                checked ? 'border-accent' : 'border-line-strong',
              )}
            >
              {checked && <span className="size-1.5 rounded-full bg-accent" />}
            </span>
            <span className="min-w-0">
              <span className={cn('block text-ui', checked ? 'text-fg' : 'text-fg-2')}>{o.title}</span>
              <span className="block text-meta text-fg-3">{o.line}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function HardRulesNote() {
  return (
    <p className="mt-1.5 flex gap-1.5 text-meta text-fg-3">
      <ShieldCheck size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" />
      {HARD_RULES_LINE}
    </p>
  );
}

/** Remembered approvals of a project, with a way to take each back. */
export function RememberedRules({ projectId }: { projectId: string }) {
  const rt = useRuntime();
  const connected = useConnectionState() === 'open';
  const rules = usePermissionRules(projectId).data ?? NONE;
  const tasks = useTasks().data;
  const taskTitle = useMemo(() => {
    const m = new Map((tasks ?? NONE).map((t) => [t.id, t.title]));
    return (id: string) => m.get(id);
  }, [tasks]);
  if (rules.length === 0) {
    return (
      <p className="text-meta text-fg-3" data-testid="no-remembered-rules">
        まだありません。承認するときに「今後も許可」を選ぶと、ここに並びます。
      </p>
    );
  }
  return (
    <ul className="flex flex-col overflow-hidden rounded-sm border border-line-subtle" data-testid="remembered-rules">
      {rules.map((r: PermissionRule) => (
        <li key={r.id} className="flex min-h-9 items-center gap-2 border-b border-line-subtle px-2.5 py-1.5 last:border-b-0">
          <Repeat size={12} strokeWidth={1.75} className="shrink-0 text-fg-3" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ui text-fg">{r.description}</span>
            <span className="flex items-center gap-1.5 text-meta text-fg-3">
              {ruleScopeText(r, taskTitle)}
              <span className="text-fg-4">·</span>
              <TimeStamp iso={r.createdAt} relative />
            </span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={!connected}
            onClick={() => void revokePermissionRule(rt, r)}
            aria-label={`「${r.description}」を取り消す`}
          >
            取り消す
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Per-run summary chip (Focus header): `自動判断 12 件 · ブロック 1 件`. Quiet text; the
 * popover says how this run decides, what was blocked lately, and leads to the Timeline.
 */
export function RunDecisionsChip({ run }: { run: Run }) {
  const rt = useRuntime();
  // Re-read the latest blocks whenever an event of this session arrives.
  const version = useSessionEventVersion(run.sessionId);
  const summary = summarizeDecisions(run.toolDecisions);
  const blocks = useMemo(
    () => recentBlocks(rt.streams.events.events, run.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rt, run.id, version],
  );
  if (!summary && !run.permission) return null;
  const openTimeline = () => {
    useTimeline.getState().setFilters({ runId: run.id, sessionId: null, groups: ['grant', 'approval'] });
    useUi.getState().setMode('timeline');
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="decisions-chip"
          className="flex h-6 shrink-0 items-center gap-1.5 rounded-xs px-1.5 text-meta text-fg-3 hover:bg-hover hover:text-fg-2"
        >
          {summary && summary.blocked > 0 ? (
            <ShieldBan size={12} strokeWidth={1.75} className="text-fg-2" />
          ) : (
            <ShieldCheck size={12} strokeWidth={1.75} />
          )}
          <span className="tabular">{summary ? decisionSummaryText(summary) : '自動判断 0 件'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] p-3">
        <div className="flex flex-col gap-2.5 text-ui" data-testid="decisions-popover">
          {run.permission && (
            <div>
              <div className="text-micro text-fg-3">この Run の判断</div>
              <div className="text-fg">{gateText(run.permission)}</div>
              <div className="text-meta text-fg-3">{PROFILE_INFO[run.permission.profile].line}</div>
              {run.permission.note && <div className="mt-0.5 text-meta text-fg-3">{run.permission.note}</div>}
            </div>
          )}
          {summary && (
            <dl className="grid grid-cols-3 gap-2 rounded-sm bg-canvas px-2.5 py-2 text-center">
              <div>
                <dt className="text-micro text-fg-3">自動で許可</dt>
                <dd className="text-title text-fg tabular">{summary.allowed}</dd>
              </div>
              <div>
                <dt className="text-micro text-fg-3">ブロック</dt>
                <dd className="text-title text-fg tabular">{summary.blocked}</dd>
              </div>
              <div>
                <dt className="text-micro text-fg-3">あなたに確認</dt>
                <dd className="text-title text-fg tabular">{summary.asked}</dd>
              </div>
            </dl>
          )}
          {blocks.length > 0 && (
            <div>
              <div className="mb-1 text-micro text-fg-3">最近のブロック</div>
              <ul className="flex flex-col gap-1">
                {blocks.map((b, i) => {
                  const v = describeDecision(b);
                  return (
                    <li key={`${b.toolCallId ?? ''}:${i}`} className="text-meta">
                      <div className="flex items-center gap-1.5 text-fg-2">
                        <ShieldBan size={11} strokeWidth={1.75} className="shrink-0" />
                        <span className="truncate font-mono">{b.summary ?? b.toolName}</span>
                        <span className="ml-auto shrink-0 text-fg-3">{DECIDER[b.decidedBy].badge}</span>
                      </div>
                      {v.reason && <div className="pl-[17px] text-fg-3">{v.reason}</div>}
                    </li>
                  );
                })}
              </ul>
              <p className="mt-1 text-meta text-fg-3">エージェントには理由を伝えてあり、別の方法で作業を続けます。</p>
            </div>
          )}
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" onClick={openTimeline}>
              タイムラインで見る
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
