import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './platform';

/**
 * OS notifications behind one small function. Inside Tauri the shell's notification plugin
 * (tauri-plugin-notification, registered in src-tauri/src/lib.rs; the main window's
 * capability allows exactly its is_permission_granted / request_permission / notify
 * commands); in the browser the Web Notification API. Neither present: nothing happens.
 *
 * The plugin's commands are invoked directly rather than through its `window.Notification`
 * shim: on Windows the shim starts as "denied" until asked, while the desktop plugin always
 * reports granted — the commands are the plugin's actual answer.
 */

export interface OsNotification {
  title: string;
  body?: string;
  /** Same tag = the OS replaces the previous notification instead of stacking another. */
  tag?: string;
  /** Browser only: clicking focuses the window and runs this. */
  onClick?: () => void;
}

interface TauriNotificationApi {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<string>;
  sendNotification(options: { title: string; body?: string }): Promise<unknown>;
}

/** The plugin's commands (`plugin:notification|…`), the same calls its JS package makes. */
const tauriPlugin: TauriNotificationApi = {
  // null = "prompt" (mobile); the desktop plugin answers true.
  isPermissionGranted: async () =>
    (await invoke<boolean | null>('plugin:notification|is_permission_granted')) === true,
  requestPermission: () => invoke<string>('plugin:notification|request_permission'),
  sendNotification: (options) => invoke('plugin:notification|notify', { options }),
};

function tauriApi(): TauriNotificationApi | null {
  return isTauri() ? tauriPlugin : null;
}

function webApi(): typeof Notification | null {
  return typeof Notification === 'function' ? Notification : null;
}

export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported';

export function notificationBackend(): 'tauri' | 'web' | 'none' {
  if (tauriApi()) return 'tauri';
  if (webApi()) return 'web';
  return 'none';
}

export async function notificationPermission(): Promise<NotifyPermission> {
  const t = tauriApi();
  if (t) {
    try {
      return (await t.isPermissionGranted()) ? 'granted' : 'default';
    } catch {
      return 'unsupported';
    }
  }
  const w = webApi();
  if (!w) return 'unsupported';
  return w.permission;
}

/** Ask once (call from a user gesture in the browser: a toggle or button). */
export async function requestNotificationPermission(): Promise<NotifyPermission> {
  const t = tauriApi();
  try {
    if (t) return (await t.requestPermission()) === 'granted' ? 'granted' : 'denied';
    const w = webApi();
    if (!w) return 'unsupported';
    if (w.permission !== 'default') return w.permission;
    return await w.requestPermission();
  } catch {
    return 'unsupported';
  }
}

/** Send if permitted; never prompts (a prompt out of nowhere is worse than no notification). */
export async function notify(n: OsNotification): Promise<boolean> {
  try {
    const t = tauriApi();
    if (t) {
      if (!(await t.isPermissionGranted())) return false;
      await t.sendNotification({ title: n.title, ...(n.body ? { body: n.body } : {}) });
      return true;
    }
    const w = webApi();
    if (!w || w.permission !== 'granted') return false;
    const shown = new w(n.title, { ...(n.body ? { body: n.body } : {}), ...(n.tag ? { tag: n.tag } : {}) });
    if (n.onClick) {
      shown.onclick = () => {
        window.focus();
        n.onClick?.();
        shown.close();
      };
    }
    return true;
  } catch {
    return false;
  }
}

/** The person is looking at this window (visible and focused). */
export function windowFocused(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible' && document.hasFocus();
}
