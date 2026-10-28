import { isTauri as tauriDetect } from '@tauri-apps/api/core';

/** True inside the Tauri WebView (false in the browser dev mode and in tests). */
export function isTauri(): boolean {
  try {
    return tauriDetect();
  } catch {
    return false;
  }
}

/** macOS reads `Ctrl` as `⌘` in shortcut labels and handlers. */
export const isMac: boolean =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
