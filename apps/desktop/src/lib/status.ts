import type { RunStatus, TaskStatus } from '@acc/protocol';

/**
 * Visual state keys (ui-design §2.4). Run statuses map onto these; `review` covers
 * "integration / review waiting"; `idle` is a session that never ran.
 */
export type DisplayState =
  | 'running'
  | 'awaiting_approval'
  | 'failed'
  | 'review'
  | 'interrupted'
  | 'completed'
  | 'queued'
  | 'cancelled'
  | 'idle';

export const STATE_LABEL: Record<DisplayState, string> = {
  running: '実行中',
  awaiting_approval: '承認待ち',
  failed: '失敗',
  review: '統合待ち',
  interrupted: '中断',
  completed: '完了',
  queued: '待機中',
  cancelled: '中止',
  idle: '未実行',
};

export const STATE_TOOLTIP: Partial<Record<DisplayState, string>> = {
  queued: '同時実行の空きを待っています',
  awaiting_approval: 'あなたの承認を待っています',
  failed: 'エラーで停止しました',
  cancelled: '停止されました',
  interrupted: 'プロセスが予期せず終了しました。再開または再試行できます',
  review: 'あなたのレビューを待っています',
  idle: 'まだ実行していません',
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  created: '準備中',
  queued: '待機中',
  running: '実行中',
  awaiting_approval: '承認待ち',
  completed: '完了',
  failed: '失敗',
  cancelled: '中止',
  interrupted: '中断',
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '未着手',
  ready: '着手可能',
  running: '進行中',
  review: 'レビュー待ち',
  done: '完了',
  failed: '失敗',
  cancelled: '中止',
  blocked: '依存待ち',
  paused: '停止中',
};

export function runStatusToState(s: RunStatus): DisplayState {
  switch (s) {
    case 'created':
    case 'running':
      return 'running';
    case 'queued':
      return 'queued';
    case 'awaiting_approval':
      return 'awaiting_approval';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'interrupted':
      return 'interrupted';
  }
}

/** States that need a human (ui-design §1: colour and motion are reserved for these). */
export const ATTENTION_STATES = ['awaiting_approval', 'failed', 'interrupted', 'review'] as const;
export type AttentionState = (typeof ATTENTION_STATES)[number];

export function isAttention(s: DisplayState): s is AttentionState {
  return (ATTENTION_STATES as readonly DisplayState[]).includes(s);
}

/** Order inside the attention zone: approvals -> failed -> interrupted -> review. */
export const ATTENTION_RANK: Record<AttentionState, number> = {
  awaiting_approval: 0,
  failed: 1,
  interrupted: 2,
  review: 3,
};

export function isActiveState(s: DisplayState): boolean {
  return s === 'running' || s === 'awaiting_approval' || s === 'queued';
}
