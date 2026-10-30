import { invoke, isTauri as tauriDetect } from '@tauri-apps/api/core';

/** True inside the Tauri WebView (false in the browser dev mode and in tests). */
export function isTauri(): boolean {
  try {
    return tauriDetect();
  } catch {
    return false;
  }
}

/**
 * Whether the shell gave the window a translucent material (acrylic / mica / vibrancy): the
 * UI lets the desktop through its ground only then (ui-rework spec §1.3). Never in the browser.
 */
export async function glassAvailable(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return (await invoke<boolean>('get_glass')) === true;
  } catch {
    return false;
  }
}

/** macOS reads `Ctrl` as `⌘` in shortcut labels and handlers. */
export const isMac: boolean =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
