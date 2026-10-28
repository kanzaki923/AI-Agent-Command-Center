import type { BudgetAllocation, CapabilityGrant, Session } from '@acc/protocol';
import { Check, Diamond, Minus, Plus, ShieldCheck, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useMemo, useState } from 'react';
import { grantOrchestrator, revokeGrant } from '../../daemon/orchestration';
import {
  useGrants,
  useMethods,
  useProjects,
  useSessionBudgets,
  useSessions,
} from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { useNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { formatClock } from '../../lib/format';
import {
  DEFAULT_GRANT_INPUT,
  EXPIRY_CHOICES,
  GRANT_PRESETS,
  type GrantPresetId,
  LIFETIME_LABEL,
  type LifetimeChoice,
  MAX_WORKERS_LIMIT,
  PRESET_ORDER,
  activeGrants,
  canOrchestrate,
  capabilityLines,
  describeGrant,
} from '../../model/grant';
import { useIsDemo } from '../../model/useDemo';
import { useUi } from '../../store/ui';
import { Button } from '../ui/Button';
import { Dialog, inputClass } from '../ui/Dialog';
import { Kbd } from '../ui/Kbd';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';

const NONE: never[] = [];

/** Active grants of a session, re-evaluated with the shared 1s clock (expiry). */
export function useSessionGrants(sessionId: string | null | undefined) {
  const grants = useGrants(sessionId).data ?? NONE;
  const now = useNow();
  const nowIso = new Date(now).toISOString();
  const active = activeGrants(grants, nowIso);
  return { grants, active, orchestrator: active.find(canOrchestrate) ?? null };
}

function activeBudget(budgets: readonly BudgetAllocation[] | undefined): BudgetAllocation | null {
  return budgets?.find((b) => b.status === 'active') ?? null;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** The orchestrator mark: a filled diamond in the accent colour (§5.1 goal bar uses it too). */
export function OrchestratorMark({
  size = 12,
  hollow = false,
}: {
  size?: number;
  hollow?: boolean;
}) {
  return (
    <Diamond
      size={size}
      strokeWidth={1.75}
      className={hollow ? 'text-fg-3' : 'text-accent'}
      fill={hollow ? 'none' : 'currentColor'}
      aria-hidden="true"
    />
  );
}

// ---------------------------------------------------------------------------
// Chip (composer toolbar) + details popover
// ---------------------------------------------------------------------------

function GrantDetails({
  session,
  grant,
  budget,
}: {
  session: Session;
  grant: CapabilityGrant;
  budget: BudgetAllocation | null;
}) {
  const rt = useRuntime();
  const projects = useProjects().data ?? NONE;
  const setGrantDialog = useUi((s) => s.setGrantDialog);
  const v = describeGrant(grant, projects);
  return (
    <div className="flex w-[340px] flex-col">
      <div className="flex items-start gap-2.5 px-3.5 pt-3 pb-2.5">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm bg-[color-mix(in_oklch,var(--accent)_16%,transparent)]">
          <OrchestratorMark size={12} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-ui font-medium text-fg">{v.title}</div>
          <div className="text-meta text-fg-3">
            {v.lifetime}
            {grant.lifetime === 'run' && ' · 次の実行が終わると自動で失効します'}
            {v.custom && !v.orchestrates && ' · 個別に設定された権限'}
          </div>
        </div>
      </div>
      <dl className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-1.5 border-t border-line-subtle px-3.5 py-2.5 text-ui">
        <dt className="text-meta text-fg-3">対象</dt>
        <dd className="min-w-0 truncate text-fg-2">
          {v.projects ? v.projects.join('、') : 'すべてのプロジェクト'}
        </dd>
        {v.workers && (
          <>
            <dt className="text-meta text-fg-3">Worker</dt>
            <dd className="text-fg-2">{v.workers}</dd>
          </>
        )}
        <dt className="text-meta text-fg-3">予算</dt>
        <dd className="text-fg-2 tabular">
          {budget ? (
            <>
              {usd(budget.limitUsd)}
              <span className="text-fg-3">
                {' '}
                · 配分済み {usd(budget.allocatedUsd)} · 使用 {usd(budget.spentUsd)}
              </span>
            </>
          ) : (
            <span className="text-fg-3">設定なし</span>
          )}
        </dd>
      </dl>
      {v.capabilities.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-line-subtle px-3.5 py-2.5">
          {v.capabilities.map((c) => (
            <li key={c} className="flex items-center gap-2 text-meta text-fg-2">
              <Check size={12} strokeWidth={2} className="text-fg-3" />
              {c}
            </li>
          ))}
          <li className="flex items-center gap-2 text-meta text-fg-3">
            <ShieldCheck size={12} strokeWidth={1.75} />
            統合の反映は常にあなたが承認します
          </li>
        </ul>
      )}
      <div className="flex justify-end gap-2 border-t border-line-subtle px-3 py-2">
        <Button size="sm" variant="ghost" onClick={() => setGrantDialog(session.id)}>
          設定を変える
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void revokeGrant(rt, session.id, grant)}
        >
          権限を取り消す
        </Button>
      </div>
    </div>
  );
}

/**
 * Composer toolbar chip (§6 "権限チップ"): `Orchestrator 権限: なし` opens the grant dialog;
 * once granted, an accent chip names what the chat may do, with × to revoke in place.
 */
export function GrantChip({ session }: { session: Session }) {
  const rt = useRuntime();
  const { active, orchestrator } = useSessionGrants(session.id);
  const budget = activeBudget(useSessionBudgets(session.id).data);
  const projects = useProjects().data ?? NONE;
  const setGrantDialog = useUi((s) => s.setGrantDialog);
  const connected = useConnectionState() === 'open';
  const grant = orchestrator ?? active[0] ?? null;

  return (
    <AnimatePresence initial={false} mode="popLayout">
      {grant ? (
        <motion.span
          key="granted"
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.12 } }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          className="acc-grant-glow group/chip inline-flex h-6 items-center rounded-xs"
          style={{ background: 'color-mix(in oklch, var(--accent) 14%, transparent)' }}
          data-testid="grant-chip"
        >
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex h-6 items-center gap-1.5 rounded-l-xs pr-1.5 pl-2 text-meta text-fg hover:bg-[color-mix(in_oklch,var(--accent)_10%,transparent)]"
              >
                <OrchestratorMark size={11} />
                <GrantSummary grant={grant} budget={budget} projects={projects} />
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" className="p-0">
              <GrantDetails session={session} grant={grant} budget={budget} />
            </PopoverContent>
          </Popover>
          <Tooltip content="権限を取り消す">
            <button
              type="button"
              aria-label="Orchestrator 権限を取り消す"
              disabled={!connected}
              onClick={(e) => {
                e.stopPropagation();
                void revokeGrant(rt, session.id, grant);
              }}
              className="flex h-6 w-5 items-center justify-center rounded-r-xs text-fg-3 hover:text-fg"
            >
              <X size={11} strokeWidth={2} />
            </button>
          </Tooltip>
        </motion.span>
      ) : (
        <motion.span
          key="none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
        >
          <Tooltip content="権限を与えると、このチャットが Task を分けて Worker を指揮できます">
            <button
              type="button"
              disabled={!connected}
              onClick={() => setGrantDialog(session.id)}
              className="flex h-6 items-center gap-1.5 rounded-xs px-1.5 text-meta text-fg-3 hover:bg-hover hover:text-fg-2"
            >
              <OrchestratorMark size={11} hollow />
              Orchestrator 権限: なし
            </button>
          </Tooltip>
        </motion.span>
      )}
    </AnimatePresence>
  );
}

function GrantSummary({
  grant,
  budget,
  projects,
}: {
  grant: CapabilityGrant;
  budget: BudgetAllocation | null;
  projects: ReturnType<typeof useProjects>['data'];
}) {
  const v = describeGrant(grant, projects ?? NONE);
  const workers =
    v.workers && grant.limits.maxWorkers != null ? `Worker ${grant.limits.maxWorkers}` : null;
  const parts = [workers, budget ? usd(budget.limitUsd) : null, v.lifetime].filter(
    (x): x is string => !!x,
  );
  return (
    <span className="flex items-center gap-1.5">
      <span className="font-medium">{v.title}</span>
      {parts.map((p) => (
        <span key={p} className="flex items-center gap-1.5 text-fg-2">
          <span className="text-fg-4">·</span>
          <span className="tabular">{p}</span>
        </span>
      ))}
    </span>
  );
}

/** Focus header badge: the chat's role, crossfading `チャット` → `◆ Orchestrator` (§3.1). */
export function RoleBadge({ session, fallback }: { session: Session; fallback: string }) {
  const { orchestrator } = useSessionGrants(session.kind === 'chat' ? session.id : null);
  const label = orchestrator ? 'Orchestrator' : fallback;
  return (
    <AnimatePresence initial={false} mode="popLayout">
      <motion.span
        key={label}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.12 } }}
        transition={{ duration: 0.18 }}
        className={cn(
          'flex shrink-0 items-center gap-1 text-ui',
          orchestrator ? 'text-fg-2' : 'text-fg-3',
        )}
      >
        {orchestrator && <OrchestratorMark size={11} />}
        {label}
      </motion.span>
    </AnimatePresence>
  );
}

const FLOW = ['目標', 'Task に分割', 'Worker が並列に作業', '統合とテスト', 'あなたが承認'];

/**
 * An orchestrator chat before its first message: what this chat can now do, within which
 * limits, and how the work will flow — the grant made legible (concept §3.1).
 */
export function OrchestratorIntro({
  session,
  grant,
}: {
  session: Session;
  grant: CapabilityGrant;
}) {
  const projects = useProjects().data ?? NONE;
  const budget = activeBudget(useSessionBudgets(session.id).data);
  const v = describeGrant(grant, projects);
  const facts = [
    v.workers,
    budget ? `予算 ${usd(budget.limitUsd)}` : null,
    v.lifetime,
    v.projects ? `対象: ${v.projects.join('、')}` : '対象: すべてのプロジェクト',
  ].filter((x): x is string => !!x);
  return (
    <div className="mx-auto flex h-full w-full max-w-[760px] flex-col px-6 pt-6">
      {/* Who gave the role and when stays on record, like it will in the conversation. */}
      <GrantLine grant={grant} change="given" />
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="mx-auto flex max-w-[560px] flex-1 flex-col items-center justify-center pb-16 text-center"
        data-testid="orchestrator-intro"
      >
        <span className="acc-grant-glow flex size-10 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--accent)_16%,transparent)]">
          <OrchestratorMark size={16} />
        </span>
        <h2 className="mt-4 text-heading text-fg">このチャットは Orchestrator です</h2>
        <p className="mt-1.5 text-ui text-fg-3">
          目標を伝えると、Task に分けて Worker
          を並列に動かします。統合の反映は必ずあなたが承認します。
        </p>
        <ul className="mt-4 flex flex-wrap justify-center gap-1.5">
          {facts.map((f) => (
            <li key={f} className="rounded-xs bg-selected px-2 py-0.5 text-meta text-fg-2 tabular">
              {f}
            </li>
          ))}
        </ul>
        <ol
          className="mt-6 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-meta text-fg-3"
          aria-label="作業の流れ"
        >
          {FLOW.map((s, i) => (
            <li key={s} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-fg-4">→</span>}
              <span className={i === FLOW.length - 1 ? 'text-fg-2' : undefined}>{s}</span>
            </li>
          ))}
        </ol>
      </motion.div>
    </div>
  );
}

/** Chat stream line: "◆ Orchestrator 権限を付与しました …" / "◇ … が終了しました". */
export function GrantLine({
  grant,
  change,
}: {
  grant: CapabilityGrant;
  change: 'given' | 'ended';
}) {
  const projects = useProjects().data ?? NONE;
  const v = describeGrant(grant, projects);
  const by =
    grant.grantedBy.kind === 'human'
      ? 'あなた'
      : grant.grantedBy.kind === 'agent'
        ? 'Orchestrator'
        : 'システム';
  const at = change === 'given' ? grant.createdAt : (grant.revokedAt ?? grant.createdAt);
  return (
    <div className="flex items-center gap-3 py-1" data-testid={`grant-line-${change}`}>
      <span className="h-px min-w-6 flex-1 bg-line-subtle" />
      {/* One flowing sentence: in a narrow column it wraps as text, not as columns. */}
      <span className="max-w-[560px] text-center text-meta [word-break:keep-all] text-fg-3">
        <span className="mr-1.5 inline-block align-[-1px]">
          <OrchestratorMark size={10} hollow={change === 'ended'} />
        </span>
        {change === 'given' ? (
          <>
            <span className="text-fg-2">
              {by}が「{v.title}」の権限を付与しました
            </span>
            {v.workers && <span className="whitespace-nowrap"> · {v.workers}</span>}
            <span className="whitespace-nowrap"> · {v.lifetime}</span>
          </>
        ) : (
          <span>{v.title} の権限が終了しました</span>
        )}
        <span className="whitespace-nowrap text-fg-3 tabular"> · {formatClock(at)}</span>
      </span>
      <span className="h-px min-w-6 flex-1 bg-line-subtle" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grant dialog
// ---------------------------------------------------------------------------

function Segmented<T extends string | number | null>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex h-7 rounded-sm border border-line bg-canvas p-0.5"
    >
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex h-full items-center rounded-[4px] px-2.5 text-ui transition-colors duration-[120ms]',
            o.value === value ? 'bg-selected text-fg' : 'text-fg-3 hover:text-fg-2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-4 py-2.5">
      <div className="w-24 shrink-0 pt-1">
        <div className="text-ui text-fg-2">{label}</div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {children}
        {hint && <div className="text-meta text-fg-3">{hint}</div>}
      </div>
    </div>
  );
}

const BUDGET_CHOICES = [1, 5, 20] as const;

function GrantForm({ session, onDone }: { session: Session; onDone: () => void }) {
  const rt = useRuntime();
  const methods = useMethods();
  const projects = useProjects().data ?? NONE;
  const uiProject = useUi((s) => s.projectId);
  const setProjectDialog = useUi((s) => s.setProjectDialog);
  const demo = useIsDemo();
  const [preset, setPreset] = useState<GrantPresetId>(DEFAULT_GRANT_INPUT.preset);
  const [projectId, setProjectId] = useState<string | null>(
    session.projectId ?? uiProject ?? projects[0]?.id ?? null,
  );
  const [maxWorkers, setMaxWorkers] = useState(DEFAULT_GRANT_INPUT.maxWorkers);
  const [budget, setBudget] = useState<number | null>(DEFAULT_GRANT_INPUT.budgetUsd);
  const [customBudget, setCustomBudget] = useState('');
  const [lifetime, setLifetime] = useState<LifetimeChoice>(DEFAULT_GRANT_INPUT.lifetime);
  const [expiresInMs, setExpiresInMs] = useState<number | null>(DEFAULT_GRANT_INPUT.expiresInMs);
  const p = GRANT_PRESETS[preset];
  const project = projects.find((x) => x.id === projectId) ?? null;
  const budgetUsd = budget === -1 ? Number(customBudget) || null : budget;

  const sentence = useMemo(() => {
    // A half-width space between Japanese and a Latin word reads better (§9.1 style).
    const where = project ? `「${project.name}」で ` : 'すべてのプロジェクトで ';
    const doing = p.spawns
      ? `Task を分け、Worker を ${maxWorkers} 人まで並列に起動できます`
      : 'Task を作成・整理できます（Worker は起動しません）';
    const money = p.spawns && budgetUsd ? `Worker に配れる予算は ${usd(budgetUsd)} です。` : '';
    const until =
      lifetime === 'run'
        ? '次の実行が終わると自動で失効します。'
        : expiresInMs
          ? `${EXPIRY_CHOICES.find((e) => e.ms === expiresInMs)?.label ?? ''}後に失効します。`
          : '取り消すまで有効です。';
    return `このチャットは${where}${doing}。${money}${until}`;
  }, [project, p.spawns, maxWorkers, budgetUsd, lifetime, expiresInMs]);

  const submit = async () => {
    onDone();
    await grantOrchestrator(
      rt,
      {
        sessionId: session.id,
        projectId,
        preset,
        maxWorkers,
        budgetUsd: p.spawns ? budgetUsd : null,
        lifetime,
        expiresInMs: lifetime === 'session' ? expiresInMs : null,
      },
      methods,
    );
    if (projectId && session.projectId !== projectId) {
      // The conversation now works for that project (its workers and tasks live there).
      rt.client.call('session.update', { sessionId: session.id, projectId }).catch(() => {});
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void submit();
        }
      }}
      className="flex flex-col"
    >
      <div role="radiogroup" aria-label="役割" className="grid grid-cols-3 gap-2">
        {PRESET_ORDER.map((id) => {
          const x = GRANT_PRESETS[id];
          const on = id === preset;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setPreset(id)}
              className={cn(
                'flex min-h-[92px] flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors duration-[120ms]',
                on
                  ? 'border-[var(--focus-ring)] bg-selected'
                  : 'border-line bg-canvas hover:border-line-strong',
              )}
            >
              <span className="flex w-full items-center gap-1.5 text-ui font-medium text-fg">
                {id === 'orchestrate' ? <OrchestratorMark size={11} hollow={!on} /> : null}
                {x.label}
                {id === 'orchestrate' && (
                  <span className="ml-auto text-micro font-normal text-fg-3">推奨</span>
                )}
              </span>
              <span className="text-meta text-fg-3">{x.summary}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-2 divide-y divide-line-subtle">
        <Row
          label="対象"
          hint={
            !project ? (
              <span>
                プロジェクトがないと Worker は worktree を作れません。
                <button
                  type="button"
                  className="ml-1 text-accent hover:underline"
                  onClick={() => setProjectDialog({ kind: 'new' })}
                >
                  プロジェクトを追加
                </button>
              </span>
            ) : (
              <span className="font-mono">{project.repoPath}</span>
            )
          }
        >
          <select
            aria-label="対象のプロジェクト"
            className={cn(inputClass, 'h-7 w-auto min-w-56')}
            value={projectId ?? ''}
            onChange={(e) => setProjectId(e.target.value || null)}
          >
            {projects.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
            <option value="">すべてのプロジェクト</option>
          </select>
        </Row>
        {p.spawns && (
          <Row
            label="Worker 数"
            hint="同時に動かせる Worker の上限です。超える起動は Core Daemon が拒否します。"
          >
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="減らす"
                onClick={() => setMaxWorkers((n) => Math.max(1, n - 1))}
                className="flex size-7 items-center justify-center rounded-sm border border-line text-fg-2 hover:border-line-strong hover:text-fg"
              >
                <Minus size={13} strokeWidth={1.75} />
              </button>
              <span className="w-14 text-center text-ui text-fg tabular" aria-live="polite">
                {maxWorkers} 人
              </span>
              <button
                type="button"
                aria-label="増やす"
                onClick={() => setMaxWorkers((n) => Math.min(MAX_WORKERS_LIMIT, n + 1))}
                className="flex size-7 items-center justify-center rounded-sm border border-line text-fg-2 hover:border-line-strong hover:text-fg"
              >
                <Plus size={13} strokeWidth={1.75} />
              </button>
            </div>
          </Row>
        )}
        {p.spawns && (
          <Row
            label="予算"
            hint={
              demo
                ? 'デモモードでは費用はかかりません。'
                : 'Worker に配分できる上限です。使い切ると Worker は止まります。'
            }
          >
            <div className="flex items-center gap-2">
              <Segmented
                label="予算"
                value={budget}
                onChange={setBudget}
                options={[
                  ...BUDGET_CHOICES.map((v) => ({ value: v, label: `$${v}` })),
                  { value: -1, label: 'その他' },
                  { value: null, label: 'なし' },
                ]}
              />
              {budget === -1 && (
                <input
                  autoFocus
                  inputMode="decimal"
                  aria-label="予算（USD）"
                  value={customBudget}
                  onChange={(e) => setCustomBudget(e.target.value.replace(/[^\d.]/g, ''))}
                  placeholder="10"
                  className={cn(inputClass, 'h-7 w-20 tabular')}
                />
              )}
            </div>
          </Row>
        )}
        <Row label="有効期間">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="有効期間"
              value={lifetime}
              onChange={setLifetime}
              options={[
                { value: 'run', label: LIFETIME_LABEL.run },
                { value: 'session', label: LIFETIME_LABEL.session },
              ]}
            />
            {lifetime === 'session' && (
              <Segmented
                label="期限"
                value={expiresInMs}
                onChange={setExpiresInMs}
                options={EXPIRY_CHOICES.map((e) => ({ value: e.ms, label: e.label }))}
              />
            )}
          </div>
        </Row>
      </div>

      <div className="mt-2 rounded-md border border-line-subtle bg-canvas px-3.5 py-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5">
            <OrchestratorMark size={12} />
          </span>
          <p className="text-ui text-fg" data-testid="grant-sentence">
            {sentence}
          </p>
        </div>
        <ul className="mt-2 flex flex-wrap gap-1.5 pl-[22px]">
          {capabilityLines(p.permissions).map((c) => (
            <li key={c} className="rounded-xs bg-selected px-1.5 py-px text-meta text-fg-2">
              {c}
            </li>
          ))}
        </ul>
        <p className="mt-2 flex items-center gap-1.5 pl-[22px] text-meta text-fg-3">
          <ShieldCheck size={12} strokeWidth={1.75} />
          制約は Core Daemon が強制します。統合の反映は常にあなたが承認します。
        </p>
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <span className="mr-auto flex items-center gap-1 text-meta text-fg-3">
          <Kbd keys="Mod+Enter" /> で付与
        </span>
        <Button variant="ghost" onClick={onDone}>
          キャンセル
        </Button>
        <Button type="submit" variant="primary" disabled={budget === -1 && !budgetUsd}>
          権限を与える
        </Button>
      </div>
    </form>
  );
}

/** Mounted once (App). Opens for `ui.grantDialogSessionId`. */
export function GrantDialog() {
  const sessionId = useUi((s) => s.grantDialogSessionId);
  const setGrantDialog = useUi((s) => s.setGrantDialog);
  const session = (useSessions().data ?? NONE).find((s) => s.id === sessionId) ?? null;
  return (
    <Dialog
      open={!!session}
      onOpenChange={(o) => !o && setGrantDialog(null)}
      title="このチャットを Orchestrator にする"
      description="権限を与えると、このチャットが Task を分け、Worker を指揮して作業を進めます。"
      className="w-[640px]"
    >
      {session && (
        <GrantForm key={session.id} session={session} onDone={() => setGrantDialog(null)} />
      )}
    </Dialog>
  );
}
