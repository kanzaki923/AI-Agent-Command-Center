/**
 * Node-only helpers (`@acc/client/node`): locate the local daemon via `$ACC_HOME/daemon.json`.
 * Browser code must not import this file.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DaemonInfo, WS_PATH } from '@acc/protocol';
import type { ConnectionInfo } from './client';

export function resolveAccHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.ACC_HOME ?? join(homedir(), '.acc');
}

export function daemonInfoPath(home: string = resolveAccHome()): string {
  return join(home, 'daemon.json');
}

/** Read daemon.json; null if missing or malformed. */
export function readDaemonInfo(home: string = resolveAccHome()): DaemonInfo | null {
  try {
    return DaemonInfo.parse(JSON.parse(readFileSync(daemonInfoPath(home), 'utf8')));
  } catch {
    return null;
  }
}

export function connectionInfoFrom(info: DaemonInfo, host = '127.0.0.1'): ConnectionInfo {
  return { url: `ws://${host}:${info.port}${WS_PATH}`, token: info.token };
}

/**
 * `connectionInfo` option for createClient that re-reads daemon.json on every reconnect
 * (a restarted daemon has a new port/token).
 */
export function daemonConnectionInfo(home: string = resolveAccHome()): () => ConnectionInfo {
  return () => {
    const info = readDaemonInfo(home);
    if (!info) throw new Error(`Core Daemon is not running (no ${daemonInfoPath(home)})`);
    return connectionInfoFrom(info);
  };
}
