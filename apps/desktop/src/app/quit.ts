import { AccClientError } from '@acc/client';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { SettingsView } from '@acc/protocol';
import { qk } from '../daemon/keys';
import type { AppRuntime } from '../daemon/runtime';
import { resumesAfterRestart } from '../daemon/shutdown';
import { isTauri } from '../lib/platform';
import { useConfirm } from '../store/confirm';
import { toastError } from '../store/toast';

/**
 * Quitting from the tray menu (src-tauri/src/tray.rs). Closing the window only hides it and
 * the Core Daemon keeps working, so this is the one way the person stops everything: the app
 * and the daemon behind it. It asks only when something would stop.
 */

/** Emitted by the shell when 終了 is picked in the tray menu. */
export const QUIT_EVENT = 'acc://quit-requested';

export interface QuitShell {
  /** While on, the shell refuses to start a daemon (the UI's reconnect would revive it). */
  setQuitting(on: boolean): Promise<void>;
  exit(): Promise<void>;
}

const tauriShell: QuitShell = {
  setQuitting: (on) => invoke('set_quitting', { on }),
  exit: () => invoke('exit_app'),
};

export interface QuitCopy {
  title: string;
  body: string;
  confirmLabel: string;
}

/**
 * What the confirmation says; null when nothing would stop (then it quits without asking).
 * What happens to interrupted work next time is said as the settings have it: with 再起動のあと
 * 再開 on, opening the app again continues it (and spends again), so "あとで再開できます" would
 * make someone who quit to stop spending expect the opposite.
 */
export function quitCopy(opts: { activeRuns: number; schedules: number; autoResume: boolean }): QuitCopy | null {
  const { activeRuns, schedules } = opts;
  if (activeRuns === 0 && schedules === 0) return null;
  const lines: string[] = [];
  if (activeRuns > 0) {
    lines.push(
      opts.autoResume
        ? `動いている ${activeRuns} 件は中断します。任せた作業は、次にアプリを開くと自動で続きを始めます。`
        : `動いている ${activeRuns} 件は中断します。再開するまで止まったままです。`,
    );
  }
  if (schedules > 0) lines.push(`定期実行 ${schedules} 件は、次にアプリを開くまで動きません。`);
  return {
    title: '終了しますか？',
    body: lines.join(''),
    confirmLabel: activeRuns > 0 ? `${activeRuns} 件を中断して終了` : '終了する',
  };
}

/** How long quitting waits for a connection that is (re)connecting before saying it cannot reach the daemon. */
export const QUIT_CONNECT_WAIT_MS = 5_000;

/** Resolves true once the client is open, false when it is not within `ms`. */
function connected(rt: AppRuntime, ms: number): Promise<boolean> {
  if (rt.client.state === 'open') return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, ms);
    const off = rt.client.onStateChange((s) => {
      if (s !== 'open') return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });
}

export async function confirmQuit(
  rt: AppRuntime,
  shell: QuitShell = tauriShell,
  waitMs = QUIT_CONNECT_WAIT_MS,
): Promise<void> {
  // A moment without a connection (reconnecting): wait for it rather than leave a daemon working
  // behind a tray icon that is gone.
  if (!(await connected(rt, waitMs))) {
    useConfirm.getState().ask({
      title: 'Core Daemon に接続できません',
      body: '止められなかった場合、作業と定期実行は裏で動き続けます。つながってから終了すると、まとめて止められます。',
      confirmLabel: 'このまま終了',
      onConfirm: () => void shell.exit(),
    });
    return;
  }
  // Fresh counts (the cached ones may be stale); unknown counts as nothing to say.
  const [activeRuns, schedules] = await Promise.all([
    rt.client.call('system.info').then(
      (i) => i.stats.activeRuns,
      () => 0,
    ),
    rt.callOr('schedule.list', { enabled: true }, { items: [] }).then(
      (r) => r.items.length,
      () => 0,
    ),
  ]);
  ask(rt, shell, activeRuns, schedules);
}

function ask(rt: AppRuntime, shell: QuitShell, activeRuns: number, schedules: number): void {
  const copy = quitCopy({ activeRuns, schedules, autoResume: resumesAfterRestart(rt.queryClient.getQueryData<SettingsView>(qk.settings)) });
  if (!copy) {
    void stop(rt, shell, false, schedules);
    return;
  }
  useConfirm.getState().ask({
    ...copy,
    danger: activeRuns > 0,
    onConfirm: () => void stop(rt, shell, activeRuns > 0, schedules),
  });
}

async function stop(rt: AppRuntime, shell: QuitShell, force: boolean, schedules: number) {
  await shell.setQuitting(true);
  try {
    await rt.client.call('system.shutdown', { force });
  } catch (err) {
    await shell.setQuitting(false);
    if (err instanceof AccClientError && err.code === 'conflict' && !force) {
      // Something started after the counts were taken: ask again with the daemon's count.
      const n = (err.data as { activeRuns?: unknown } | undefined)?.activeRuns;
      ask(rt, shell, typeof n === 'number' && n > 0 ? n : 1, schedules);
      return;
    }
    toastError(err, '終了できませんでした');
    return;
  }
  await shell.exit();
}

/** Wire the tray's 終了 to the app (main.tsx). Desktop shell only. */
export function installQuit(rt: AppRuntime): () => void {
  if (!isTauri()) return () => {};
  let off: (() => void) | null = null;
  let disposed = false;
  void listen(QUIT_EVENT, () => void confirmQuit(rt)).then((unlisten) => {
    if (disposed) unlisten();
    else off = unlisten;
  });
  return () => {
    disposed = true;
    off?.();
  };
}
