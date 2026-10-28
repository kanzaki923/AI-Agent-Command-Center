/**
 * Test helpers (import from `@acc/daemon/testing`). Not used at runtime.
 *
 * ```ts
 * const d = await startTestDaemon();          // temp ACC_HOME, port 0, silent log
 * const client = await connectTestClient(d);  // typed @acc/client over WebSocket
 * await client.call('project.create', { name: 'x' });
 * await d.cleanup();                          // closes and deletes the temp dir
 * ```
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AccClient, type ClientOptions, createClient } from '@acc/client';
import type { AgentActor, HumanActor, SystemActor } from '@acc/protocol';
import {
  type CreateDaemonOptions,
  type Daemon,
  type RunningDaemon,
  type StartDaemonOptions,
  createDaemon,
  startDaemon,
} from './daemon';
import { silentLogger } from './core/log';

export const HUMAN: HumanActor = { kind: 'human', client: 'test' };
export const SYSTEM: SystemActor = { kind: 'system', component: 'test' };
export function agentActor(sessionId: string, runId: string): AgentActor {
  return { kind: 'agent', sessionId, runId };
}

export interface TestHome {
  home: string;
  /** Owned temp dirs are deleted; a caller-provided home is kept. */
  removeHome(): void;
}

function makeHome(home: string | undefined): TestHome {
  if (home) return { home, removeHome: () => {} };
  const dir = mkdtempSync(join(tmpdir(), 'acc-test-'));
  return {
    home: dir,
    removeHome: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

export type TestDaemon = RunningDaemon & TestHome & { cleanup(): Promise<void> };
export type TestDaemonNoServer = Daemon & TestHome & { cleanup(): Promise<void> };

/**
 * Start a real daemon (HTTP + WS) on an ephemeral port in a temp ACC_HOME. The process
 * environment is NOT inherited (so a developer's ACC_* variables never leak into tests);
 * pass `env` explicitly when needed.
 */
export async function startTestDaemon(opts: StartDaemonOptions = {}): Promise<TestDaemon> {
  const h = makeHome(opts.home);
  const d = await startDaemon({ log: silentLogger, port: 0, env: {}, ...opts, home: h.home });
  return Object.assign(d, h, {
    async cleanup() {
      await d.close();
      h.removeHome();
    },
  });
}

/** Daemon without network (call methods with `d.call(HUMAN, method, params)`). */
export async function createTestDaemon(
  opts: CreateDaemonOptions = {},
): Promise<TestDaemonNoServer> {
  const h = makeHome(opts.home);
  const d = await createDaemon({ log: silentLogger, env: {}, ...opts, home: h.home });
  return Object.assign(d, h, {
    async cleanup() {
      await d.close();
      h.removeHome();
    },
  });
}

/** Connect a typed client to a running test daemon and wait until it is open. */
export async function connectTestClient(
  d: RunningDaemon,
  opts: Partial<ClientOptions> = {},
): Promise<AccClient> {
  const client = createClient({ url: d.wsUrl, token: d.token, clientName: 'test', ...opts });
  await client.ready();
  return client;
}
