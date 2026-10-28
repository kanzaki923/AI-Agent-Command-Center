import { AccClientError } from '@acc/client';
import type { SettingsView } from '@acc/protocol';
import { isTauri } from '../lib/platform';
import { useConfirm } from '../store/confirm';
import { toast, toastError } from '../store/toast';
import { qk } from './keys';
import type { AppRuntime } from './runtime';

/**
 * Stopping the Core Daemon from the UI (`system.shutdown`, humans only). The daemon outlives
 * the window on purpose, so this is the one place a person stops it from the app.
 *
 * - In the desktop app the shell starts a new daemon as soon as the connection drops, so for
 *   the person this is a restart: say so.
 * - With runs active the daemon refuses unless `force`; the confirmation names how many will
 *   be interrupted, and a run that started meanwhile (conflict) asks again with the new count.
 */
export interface ShutdownCopy {
  title: string;
  body: string;
  confirmLabel: string;
}

export function shutdownCopy(opts: {
  restart: boolean;
  activeRuns: number;
  autoResume: boolean;
}): ShutdownCopy {
  const verb = opts.restart ? '再起動' : '停止';
  const how = opts.restart
    ? 'Core Daemon を止めると、このアプリがすぐに新しい Core Daemon を起動します。'
    : 'UI を閉じても動き続ける Core Daemon を止めます。もう一度使うには Core Daemon を起動し直してください（開発中は pnpm dev:daemon）。';
  const runs =
    opts.activeRuns > 0
      ? `実行中の Run ${opts.activeRuns} 件は「中断」になります。Task は同じ worktree から再開でき、Orchestrator は${opts.autoResume ? '再起動後に自動で再開します' : '自動では再開しません（設定で変更できます）'}。`
      : '実行中の Run はありません。';
  return {
    title: `Core Daemon を${verb}しますか？`,
    body: `${how}${runs}`,
    confirmLabel: opts.activeRuns > 0 ? `${opts.activeRuns} 件を中断して${verb}` : `${verb}する`,
  };
}

/** Ask, then stop. `activeRuns` comes fresh from system.info (the cached counter may be stale). */
export async function confirmShutdown(rt: AppRuntime): Promise<void> {
  let activeRuns = 0;
  try {
    activeRuns = (await rt.client.call('system.info')).stats.activeRuns;
  } catch {
    // Unknown: ask without a count; the daemon still refuses (conflict) if runs are active.
  }
  ask(rt, activeRuns);
}

function ask(rt: AppRuntime, activeRuns: number): void {
  const restart = isTauri();
  const settings = rt.queryClient.getQueryData<SettingsView>(qk.settings);
  const copy = shutdownCopy({
    restart,
    activeRuns,
    autoResume: settings?.autoResumeOrchestrators ?? true,
  });
  useConfirm.getState().ask({
    ...copy,
    danger: true,
    onConfirm: () => void send(rt, activeRuns > 0, restart),
  });
}

async function send(rt: AppRuntime, force: boolean, restart: boolean): Promise<void> {
  try {
    const r = await rt.client.call('system.shutdown', { force });
    toast({
      title: restart ? 'Core Daemon を再起動しています' : 'Core Daemon を停止しました',
      detail:
        r.activeRuns > 0
          ? `実行中だった Run ${r.activeRuns} 件は中断しました。あとで再開できます`
          : undefined,
      tone: 'info',
      sticky: false,
    });
  } catch (err) {
    if (err instanceof AccClientError && err.code === 'conflict' && !force) {
      // A run started after the confirmation: ask again with the daemon's count.
      const n = (err.data as { activeRuns?: unknown } | undefined)?.activeRuns;
      ask(rt, typeof n === 'number' && n > 0 ? n : 1);
      return;
    }
    toastError(err, `Core Daemon を${restart ? '再起動' : '停止'}できませんでした`);
  }
}
