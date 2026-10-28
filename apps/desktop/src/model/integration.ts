import type {
  DiffStats,
  Integration,
  IntegrationStatus,
  IntegrationStep,
  Task,
} from '@acc/protocol';
import type { DisplayState } from '../lib/status';

/**
 * Integration review (concept §6, §12.1 steps 7–9): what the steps mean, what the human
 * decides, and exactly what "承認して反映" will do to the target branch.
 */

export const INTEGRATION_STATUS_LABEL: Record<IntegrationStatus, string> = {
  pending: '準備中',
  running: 'マージ中',
  verifying: 'テスト中',
  awaiting_approval: '反映待ち',
  conflict: 'コンフリクト',
  applied: '反映済み',
  failed: '失敗',
  rejected: '却下',
  cancelled: '中止',
};

export function integrationState(status: IntegrationStatus): DisplayState {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'running':
    case 'verifying':
      return 'running';
    case 'awaiting_approval':
      return 'review';
    case 'conflict':
    case 'failed':
      return 'failed';
    case 'applied':
      return 'completed';
    case 'rejected':
    case 'cancelled':
      return 'cancelled';
  }
}

export function stepState(step: IntegrationStep): DisplayState {
  switch (step.status) {
    case 'pending':
      return 'queued';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'cancelled';
  }
}

/** Status in progress: the view shows live step progress and disables decisions. */
export function isIntegrationActive(i: Integration): boolean {
  return i.status === 'running' || i.status === 'verifying' || i.status === 'pending';
}

export function canApprove(i: Integration): boolean {
  return i.status === 'awaiting_approval';
}

/** Rejecting is possible until the result is final and while nothing is running. */
export function canReject(i: Integration): boolean {
  return i.status === 'awaiting_approval' || i.status === 'conflict' || i.status === 'failed';
}

export function canRerun(i: Integration): boolean {
  return i.status === 'conflict' || i.status === 'failed' || i.status === 'awaiting_approval';
}

export function stepDurationMs(step: IntegrationStep): number | null {
  if (!step.startedAt || !step.endedAt) return null;
  return Date.parse(step.endedAt) - Date.parse(step.startedAt);
}

export interface ApplyPlan {
  /** Dialog heading (§9.3: `main に変更を反映しますか？`). */
  title: string;
  /** Sentences that say exactly what happens. */
  lines: string[];
  confirmLabel: string;
  /** Tests did not pass or were skipped: the human should know before applying. */
  caution: string | null;
}

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : null);

/** The confirmation for 承認して反映: target branch, fast-forward, what is included. */
export function applyPlan(
  i: Integration,
  opts: { tasks?: Task[]; stats?: DiffStats | null } = {},
): ApplyPlan {
  const target = i.targetRef ?? '反映先ブランチ';
  const verify = i.steps.find((s) => s.kind === 'verify');
  const n = i.taskIds.length || i.workspaceIds.length;
  const titles = (opts.tasks ?? [])
    .filter((t) => i.taskIds.includes(t.id))
    .map((t) => `「${t.title}」`);
  const what =
    titles.length > 0 && titles.length <= 3
      ? `${titles.join('、')}の変更`
      : `${n} 件の Task の変更`;
  const size = opts.stats
    ? `（${opts.stats.files} ファイル、+${opts.stats.additions} −${opts.stats.deletions}）`
    : '';
  const from = short(i.baseSha);
  const to = short(i.headSha);
  const lines = [
    `${what}${size}を ${target} に反映します。`,
    `統合ブランチ ${i.branch ?? ''} の検証済みの状態まで、${target} を早送り（fast-forward）します${from && to ? `（${from} → ${to}）` : ''}。新しいマージコミットは作りません。`,
    '各 Task の worktree とブランチはそのまま残ります。',
  ];
  let caution: string | null = null;
  if (verify?.status === 'skipped')
    caution = 'テストコマンドが設定されていないため、統合後のテストは実行していません。';
  else if (verify && verify.status !== 'succeeded') caution = '統合後のテストが成功していません。';
  return { title: `${target} に変更を反映しますか？`, lines, confirmLabel: '反映する', caution };
}

/** One-line summary for cards and the task tree: `2/4 ステップ · テスト成功`. */
export function integrationSummary(i: Integration): string {
  const done = i.steps.filter((s) => s.status === 'succeeded').length;
  const verify = i.steps.find((s) => s.kind === 'verify');
  const conflict = i.steps.find((s) => s.conflictFiles.length > 0);
  if (conflict) return `コンフリクト ${conflict.conflictFiles.length} ファイル · ${conflict.title}`;
  const test =
    verify?.status === 'succeeded'
      ? 'テスト成功'
      : verify?.status === 'failed'
        ? 'テスト失敗'
        : verify?.status === 'running'
          ? 'テスト中'
          : verify?.status === 'skipped'
            ? 'テストなし'
            : null;
  return [`${done}/${i.steps.length} ステップ`, test].filter(Boolean).join(' · ');
}
