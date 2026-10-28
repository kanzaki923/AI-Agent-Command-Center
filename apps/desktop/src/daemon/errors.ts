import { AccClientError } from '@acc/client';

/** Contract methods the daemon has not implemented yet answer not_found + reason. */
export function isNotImplemented(err: unknown): boolean {
  if (!(err instanceof AccClientError) || err.code !== 'not_found') return false;
  const data = err.data as { reason?: unknown } | undefined;
  return data?.reason === 'not_implemented';
}

export function isConnectionError(err: unknown): boolean {
  return (
    err instanceof AccClientError &&
    (err.code === 'connection_lost' || err.code === 'timeout' || err.code === 'closed')
  );
}

export interface UserFacingError {
  title: string;
  /** Errors and decisions stay until dismissed (ui-design §8.5). */
  sticky: boolean;
  /** `limit_exceeded` is informational, not an error (§8.4). */
  tone: 'error' | 'info';
  detail: string;
}

/** One or two Japanese sentences: what happened + what to do (ui-design §8.4). */
export function describeError(err: unknown): UserFacingError {
  const detail = err instanceof Error ? err.message : String(err);
  if (isNotImplemented(err)) {
    return {
      title: 'この操作はまだ Core Daemon に実装されていません',
      sticky: false,
      tone: 'info',
      detail,
    };
  }
  if (err instanceof AccClientError) {
    switch (err.code) {
      case 'invalid_params':
        return { title: '入力内容を確認してください', sticky: false, tone: 'error', detail };
      case 'forbidden': {
        const perm = (err.data as { permission?: string } | undefined)?.permission;
        return {
          title: perm ? `この操作には「${perm}」権限が必要です` : 'この操作の権限がありません',
          sticky: false,
          tone: 'error',
          detail,
        };
      }
      case 'budget_exceeded':
        return { title: '予算の上限に達しました', sticky: true, tone: 'error', detail };
      case 'conflict':
        return { title: err.message, sticky: false, tone: 'error', detail };
      case 'limit_exceeded':
        return {
          title: '同時実行の上限に達したため、待機列に追加しました',
          sticky: false,
          tone: 'info',
          detail,
        };
      case 'not_found':
        return { title: '対象が見つかりませんでした', sticky: false, tone: 'error', detail };
      case 'connection_lost':
      case 'timeout':
      case 'closed':
        return {
          title: 'Core Daemon に接続できませんでした。再接続後にもう一度お試しください',
          sticky: false,
          tone: 'error',
          detail,
        };
      case 'internal':
        break;
    }
  }
  return { title: '予期しないエラーが発生しました', sticky: true, tone: 'error', detail };
}
