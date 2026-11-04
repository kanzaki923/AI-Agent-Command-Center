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
/** Whether work cut off by a stop continues on the next start (settings: 再起動のあと再開). */
export function resumesAfterRestart(settings: SettingsView | undefined): boolean {
  return settings?.autoResume ?? settings?.autoResumeOrchestrators ?? true;
}

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
    ? 'Core Daemon を止めて、すぐに起動し直します。'
    : 'UI を閉じても動き続ける Core Daemon を止めます。もう一度使うには Core Daemon を起動し直してください（開発中は pnpm dev:daemon）。';
  const next = opts.restart ? '起動し直したあと' : '次に起動したとき';
  const runs =
    opts.activeRuns > 0
      ? `動いている ${opts.activeRuns} 件は中断します。${opts.autoResume ? `任せた作業は、${next}自動で続きを始めます。` : '再開するまで止まったままです（設定の「再起動のあと再開」で変えられます）。'}`
      : '動いている作業はありません。';
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
    autoResume: resumesAfterRestart(settings),
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
          ? `動いていた ${r.activeRuns} 件を中断しました。${resumesAfterRestart(rt.queryClient.getQueryData<SettingsView>(qk.settings)) ? '任せた作業は、起動したら自動で続きを始めます' : '再開するまで止まったままです'}`
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
