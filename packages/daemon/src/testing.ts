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
import type {
  Actor,
  AgentActor,
  BudgetAllocation,
  CapabilityGrant,
  HumanActor,
  SystemActor,
  Task,
} from '@acc/protocol';
import type { DaemonContext } from './core/context';
import {
  type CreateDaemonOptions,
  type Daemon,
  type RunningDaemon,
  type StartDaemonOptions,
  createDaemon,
  startDaemon,
} from './daemon';
import { silentLogger } from './core/log';
import { type OrchestratorPresetInput, grantOrchestratorPreset } from './orchestrator/grant';

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

/**
 * Insert a Task row directly (no events, no dependency checks), for tests that need a task
 * in a given state. Every field has a default, so fixtures keep compiling when the Task
 * schema grows; prefer `task.create` when the test is about task behaviour itself.
 */
export function insertTestTask(
  ctx: DaemonContext,
  fields: Pick<Task, 'projectId'> & Partial<Task>,
): Task {
  const now = ctx.clock.iso();
  return ctx.repos.tasks.insert({
    id: ctx.ids.next('task'),
    parentTaskId: null,
    title: 'Test task',
    description: '',
    acceptanceCriteria: [],
    status: 'ready',
    statusReason: null,
    priority: 'normal',
    dependsOn: [],
    assigneeSessionId: null,
    workspaceId: null,
    resultSummary: null,
    createdBy: HUMAN,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...fields,
  });
}

/**
 * Answer every "run the integration tests?" approval as a human, as the person watching an
 * orchestration would (agent-started attempts wait for one). Returns an unsubscribe.
 */
export function approveIntegrationTests(ctx: DaemonContext): () => void {
  return ctx.bus.subscribe({ types: ['approval.requested'] }, (e) => {
    if (e.type !== 'approval.requested') return;
    const a = e.payload.approval;
    if (a.kind !== 'integration') return;
    void ctx
      .call(HUMAN, 'approval.respond', { approvalId: a.id, decision: 'approve' })
      .catch(() => undefined);
  });
}

/**
 * Give a chat the older orchestrator preset (tasks, task.spawnWorker, the blocking waits) as
 * a human. `session.grantOrchestration` now delegates (the supervisor preset), so tests of the
 * older path grant it here. Async like the method it stands in for.
 */
export async function grantOlderPreset(
  ctx: DaemonContext,
  p: OrchestratorPresetInput,
  actor: Actor = HUMAN,
): Promise<{ grant: CapabilityGrant; budget: BudgetAllocation | null }> {
  return grantOrchestratorPreset(ctx, p, actor);
}
