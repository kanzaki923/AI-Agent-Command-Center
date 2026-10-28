import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../lib/platform';

/** What the Tauri `get_connection` command and the Vite dev endpoint both return. */
export interface DaemonConnection {
  url: string;
  wsUrl: string;
  token: string;
  pid: number;
  spawned: boolean;
}

export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonUnavailableError';
  }
}

/**
 * Tauri: Rust starts the daemon if needed (idempotent, a few ms when it is already up).
 * Browser: the Vite dev middleware reads `$ACC_HOME/daemon.json`.
 * Called before every (re)connect, since a restarted daemon has a new token.
 */
export async function getConnection(): Promise<DaemonConnection> {
  if (isTauri()) {
    try {
      return await invoke<DaemonConnection>('get_connection');
    } catch (err) {
      throw new DaemonUnavailableError(String(err));
    }
  }
  const res = await fetch('/__acc/connection', { cache: 'no-store' });
  if (!res.ok) {
    throw new DaemonUnavailableError(
      'Core Daemon が起動していません（`pnpm dev:daemon` で起動してください）',
    );
  }
  return (await res.json()) as DaemonConnection;
}
