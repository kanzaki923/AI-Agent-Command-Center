import type {
  Approval,
  ApprovalRemember,
  AutoModeJudge,
  Event,
  EventPayload,
  PermissionProfile,
  PermissionRule,
  Project,
  Run,
  SettingsView,
  ToolDecider,
  ToolDecisionCounts,
} from '@acc/protocol';
import { shorten } from '../lib/tools';
import type { ApprovalView } from './approval';

/**
 * Tool permissions as people see them (ui-design §5.6). The goal is "safe and zero approval
 * requests": agents work in their own worktree, the Core Daemon's hard rules stop what must
 * never happen, and what was decided automatically stays visible afterwards. An approval is
 * the rare exception, and remembering it ("この Run / この Task / このプロジェクト") keeps it rare.
 */

export type ToolDecided = EventPayload<'tool.decided'>;

export const DEFAULT_PROFILE: PermissionProfile = 'autonomous';

export interface ProfileInfo {
  label: string;
  /** One line: what runs without asking. */
  line: string;
}

/** Order shown in pickers: the recommended default first. */
export const PROFILES: readonly PermissionProfile[] = ['autonomous', 'standard', 'careful'];

export const PROFILE_INFO: Record<PermissionProfile, ProfileInfo> = {
  autonomous: {
    label: 'おまかせ',
    line: 'worktree の中で完結する作業はすべて確認なしで進めます。決められないものは理由を添えて止め、あなたには聞きません。',
  },
  standard: {
    label: '標準',
    line: 'おまかせと同じですが、新しい依存の追加・worktree の外の読み取り・未知のツールはあなたに確認します。',
  },
  careful: {
    label: '慎重',
    line: '読み取り・編集・読み取りだけのコマンドだけを確認なしで進めます。ほかのコマンドと統合後のテストはあなたに確認します。',
  },
};

/** What holds in every profile (said once under every picker). */
export const HARD_RULES_LINE =
  'どのプロファイルでも、push・worktree の外への書き込み・資格情報・.git の変更などは Core Daemon が止めます。main への反映は常にあなたが承認します。';

export function effectiveProfile(
  project: Pick<Project, 'permissionProfile'> | null | undefined,
  settings: Pick<SettingsView, 'defaultPermissionProfile'> | null | undefined,
): PermissionProfile {
  return project?.permissionProfile ?? settings?.defaultPermissionProfile ?? DEFAULT_PROFILE;
}

/** Who decided, as a small badge (same words in the chat, the panel and the Timeline). */
export const DECIDER: Record<ToolDecider, { badge: string; tooltip: string }> = {
  rule: { badge: 'ルール', tooltip: 'Core Daemon のルールで決めました' },
  classifier: { badge: 'Auto mode', tooltip: 'Claude Code の Auto mode（安全性の分類器）が決めました' },
  remembered: { badge: '記憶', tooltip: 'あなたが「今後も許可」で覚えさせた許可に一致しました' },
  human: { badge: 'あなた', tooltip: 'あなたが承認しました' },
  runtime: { badge: 'エージェント', tooltip: 'エージェントの実行環境が自分で決めました' },
};

/** Where auto mode judged (`tool.decided.judge`, `Run.permission.judge`). */
const JUDGE_TEXT: Record<AutoModeJudge, string> = {
  server: 'Anthropic のサーバーで判定',
  client: '手元の分類器で判定',
};

/** The decider's tooltip, naming where auto mode judged when the daemon could tell. */
export function deciderTooltip(d: Pick<ToolDecided, 'decidedBy' | 'judge'>): string {
  const base = DECIDER[d.decidedBy].tooltip;
  return d.decidedBy === 'classifier' && d.judge ? `${base}（${JUDGE_TEXT[d.judge]}）` : base;
}

export type DecisionTone = 'allowed' | 'blocked' | 'asked';

export interface DecisionView {
  tone: DecisionTone;
  /** `自動で許可` / `ブロック` / `あなたに確認`. */
  label: string;
  decider: ToolDecider;
  /** `deciderTooltip()`: who decided, with where auto mode judged. */
  deciderTooltip: string;
  /** First sentence of the reason (what the agent was told, for blocks). */
  reason: string | null;
  /** The full reason, for the expanded view. */
  fullReason: string | null;
}

/**
 * First sentence of a daemon reason. Reasons are Japanese one-liners, sometimes followed by
 * the English text the agent also got, and may carry the `[AI Agent Command Center]` prefix.
 */
export function firstSentence(reason: string | null | undefined, max = 90): string | null {
  if (!reason) return null;
  const line = reason.replace(/^\s*\[AI Agent Command Center\]\s*/, '').split('\n')[0] ?? '';
  const cut = line.indexOf('。');
  const s = (cut === -1 ? line : line.slice(0, cut)).trim();
  return s ? shorten(s, max) : null;
}

export function describeDecision(
  d: Pick<ToolDecided, 'decision' | 'decidedBy' | 'reason' | 'judge'>,
): DecisionView {
  const tone: DecisionTone = d.decision === 'denied' ? 'blocked' : d.decision === 'asked' ? 'asked' : 'allowed';
  return {
    tone,
    label:
      tone === 'blocked'
        ? 'ブロック'
        : tone === 'asked'
          ? 'あなたに確認'
          : d.decidedBy === 'human'
            ? 'あなたが承認'
            : d.decidedBy === 'remembered'
              ? '記憶した許可'
              : '自動で許可',
    decider: d.decidedBy,
    deciderTooltip: deciderTooltip(d),
    reason: firstSentence(d.reason),
    fullReason: d.reason,
  };
}

/** Totals for the run's summary chip. */
export interface DecisionSummary {
  /** Decided without a human (allowed + blocked). */
  auto: number;
  allowed: number;
  blocked: number;
  asked: number;
}

export function summarizeDecisions(c: ToolDecisionCounts | null | undefined): DecisionSummary | null {
  if (!c) return null;
  return { auto: c.allowed + c.denied, allowed: c.allowed, blocked: c.denied, asked: c.asked };
}

/** `自動判断 12 件 · ブロック 1 件` (the asks only when there were any). */
export function decisionSummaryText(s: DecisionSummary): string {
  const parts = [`自動判断 ${s.auto} 件`];
  if (s.blocked > 0) parts.push(`ブロック ${s.blocked} 件`);
  if (s.asked > 0) parts.push(`確認 ${s.asked} 件`);
  return parts.join(' · ');
}

/** `おまかせ · Auto mode` / `慎重 · ルール` — how a run decides its tool uses. */
export function gateText(p: NonNullable<Run['permission']>): string {
  if (p.gate !== 'classifier') return `${PROFILE_INFO[p.profile].label} · ルールで判断`;
  const where = p.judge === 'server' ? '（サーバー判定）' : p.judge === 'client' ? '（手元の分類器）' : '';
  return `${PROFILE_INFO[p.profile].label} · Auto mode が判断${where}`;
}

/**
 * The tool decisions of one session, by tool call id (the chat joins them to its tool
 * blocks). Later decisions of the same call win (an ask that a human then answered).
 */
export function decisionsByToolCall(events: readonly Event[], sessionId: string): Map<string, ToolDecided> {
  const out = new Map<string, ToolDecided>();
  for (const e of events) {
    if (e.type !== 'tool.decided' || e.sessionId !== sessionId) continue;
    if (e.payload.toolCallId) out.set(e.payload.toolCallId, e.payload);
  }
  return out;
}

/** The latest blocked tool uses of a run, newest first. */
export function recentBlocks(events: readonly Event[], runId: string, max = 5): ToolDecided[] {
  const out: ToolDecided[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < max; i--) {
    const e = events[i]!;
    if (e.type === 'tool.decided' && e.payload.runId === runId && e.payload.decision === 'denied') out.push(e.payload);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Remembering an approval
// ---------------------------------------------------------------------------

export type RememberScope = Exclude<ApprovalRemember, 'once'>;

export interface RememberOption {
  scope: RememberScope;
  label: string;
  /** Its key in the remember chooser (shortcuts.ts: `1` / `2` / `3`). */
  shortcut: 'rememberRun' | 'rememberTask' | 'rememberProject';
  available: boolean;
  /** Why it is not available (tooltip). */
  unavailable: string | null;
}

export const REMEMBER_LABEL: Record<RememberScope, string> = {
  run: 'この Run',
  task: 'この Task',
  project: 'このプロジェクト',
};

/** What a remembered approval is called afterwards (`この Run では今後も許可`). */
export const REMEMBERED_TEXT: Record<RememberScope, string> = {
  run: 'この Run では今後も許可',
  task: 'この Task では今後も許可',
  project: 'このプロジェクトでは今後も許可',
};

/**
 * Whether an approval can be remembered at all: only tool uses (the daemon turns them into a
 * rule), and never high-risk ones (§7.2: `A` is disabled there).
 */
export function canRemember(approval: Approval, view: Pick<ApprovalView, 'risk' | 'rememberAs'>): boolean {
  return approval.kind === 'tool_use' && !!approval.projectId && view.risk !== 'high' && view.rememberAs !== null;
}

export function rememberOptions(approval: Approval): RememberOption[] {
  return [
    { scope: 'run', label: REMEMBER_LABEL.run, shortcut: 'rememberRun', available: !!approval.runId, unavailable: approval.runId ? null : 'Run のない承認です' },
    {
      scope: 'task',
      label: REMEMBER_LABEL.task,
      shortcut: 'rememberTask',
      available: !!approval.taskId,
      unavailable: approval.taskId ? null : 'Task のない実行なので、Task 単位では覚えられません',
    },
    { scope: 'project', label: REMEMBER_LABEL.project, shortcut: 'rememberProject', available: true, unavailable: null },
  ];
}

/** One sentence under the remember chooser: what changes, and that hard rules still apply. */
export function rememberHint(view: Pick<ApprovalView, 'targetKind' | 'rememberAs'>): string {
  const what = view.targetKind === 'command' ? '同じ種類のコマンド' : view.targetKind === 'file' ? '同じ場所への同じ操作' : '同じ操作';
  const lead = view.rememberAs ? `覚える内容：${view.rememberAs}。` : '';
  return `${lead}${what}を、選んだ範囲では確認なしで進めます。Core Daemon のルールで止める操作は対象外です。このプロジェクトを選んだ場合は、プロジェクトの設定から取り消せます。`;
}

/** `この Run` / `Task「…」` / `プロジェクト全体` for the remembered-rules list. */
export function ruleScopeText(rule: PermissionRule, taskTitle?: (taskId: string) => string | undefined): string {
  if (rule.scope === 'project') return 'プロジェクト全体';
  if (rule.scope === 'task') {
    const t = rule.taskId ? taskTitle?.(rule.taskId) : undefined;
    return t ? `Task「${shorten(t, 24)}」` : 'Task';
  }
  return 'その Run の間';
}
