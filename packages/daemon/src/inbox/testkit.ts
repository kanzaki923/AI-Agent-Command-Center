/**
 * Test helpers for the supervisor track (T1): stand-ins for what other tracks implement
 * (session.spawn → T2, session.tree → T7) so the inbox / wake flow can be tested end to end,
 * and a controllable agent executor for the children. A stand-in is only installed while
 * the real method is still a stub, so these tests run against the real ones once merged.
 */
import {
  type Actor,
  type Params,
  type Result,
  type Run,
  type SessionCard,
  type SupervisorSettings,
  isTerminalRunStatus,
} from '@acc/protocol';
import { defineMethod } from '../api/registry';
import type { RunController } from '../contracts';
import type { DaemonContext } from '../core/context';
import { subtreeIds } from '../home/tree';
import { insertTestTask } from '../testing';
import { currentState } from './wake';

/** Change the supervisor limits of a running test daemon (config.json is re-read on get). */
export function setSupervisorLimits(ctx: DaemonContext, patch: Partial<SupervisorSettings>): void {
  const file = ctx.settings.config() as { supervisor?: SupervisorSettings };
  file.supervisor = { ...ctx.settings.get().supervisor, ...patch };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const aborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    const fail = () => reject(new DOMException('aborted', 'AbortError'));
    if (signal.aborted) fail();
    signal.addEventListener('abort', fail, { once: true });
  });

export interface ChildAgents {
  /** Agent runs started so far (in order). */
  readonly started: Run[];
  /** Runs still held. */
  held(): string[];
  /** Let the held run of a session finish (with its summary as the final answer). */
  finish(sessionId: string): void;
  /** Fail the held run of a session. */
  fail(sessionId: string, message?: string): void;
  /** Finish every held run. */
  finishAll(): void;
  /** Runs started from now on finish right away. */
  auto: boolean;
  /** Controllers of held runs (by run id). */
  readonly ctls: Map<string, RunController>;
}

/** Agent executor whose runs wait until the test lets them finish (or fail). */
export function installChildAgents(ctx: DaemonContext): ChildAgents {
  const gates = new Map<string, { sessionId: string; gate: Deferred }>();
  const started: Run[] = [];
  const ctls = new Map<string, RunController>();
  const agents: ChildAgents = {
    started,
    ctls,
    auto: false,
    held: () => [...gates.keys()],
    finish(sessionId) {
      for (const [runId, g] of gates) {
        if (g.sessionId !== sessionId) continue;
        gates.delete(runId);
        g.gate.resolve();
      }
    },
    fail(sessionId, message = '子の作業が失敗しました') {
      for (const [runId, g] of gates) {
        if (g.sessionId !== sessionId) continue;
        gates.delete(runId);
        g.gate.reject(new Error(message));
      }
    },
    finishAll() {
      for (const [runId, g] of gates) {
        gates.delete(runId);
        g.gate.resolve();
      }
    },
  };
  ctx.service('runs').registerExecutor('agent', async (ctl) => {
    started.push(ctl.run);
    ctls.set(ctl.run.id, ctl);
    ctl.setActivity('作業中');
    if (!agents.auto) {
      const gate = deferred();
      gates.set(ctl.run.id, { sessionId: ctl.run.sessionId, gate });
      try {
        await Promise.race([gate.promise, aborted(ctl.signal)]);
      } finally {
        gates.delete(ctl.run.id);
      }
    }
    const title = ctx.repos.sessions.get(ctl.run.sessionId)?.title ?? '';
    ctl.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `「${title}」を終えました。` }],
    });
  });
  return agents;
}

/**
 * `session.spawn` until T2 implements it: a child session (brief, first message), a task
 * assigned to it and its first run — and T2's completion rule for that task (§3.4: completed
 * → done, failed → failed, interrupted → ready; a stopped child's task stays paused).
 */
export function installTestSpawn(ctx: DaemonContext): boolean {
  if (ctx.methods.has('session.spawn')) return false;
  ctx.methods.register(
    defineMethod('session.spawn', {
      scope: (p, call) => {
        const parentId =
          p.parentSessionId ?? (call.actor.kind === 'agent' ? call.actor.sessionId : null);
        const parent = parentId ? ctx.repos.sessions.get(parentId) : undefined;
        return {
          projectIds: parent?.projectId ? [parent.projectId] : [],
          sessionIds: parentId ? [parentId] : [],
        };
      },
      handler: (p, call) => testSpawn(ctx, p, call.actor),
    }),
  );
  const off = ctx.bus.subscribe({ types: ['run.status_changed'] }, (e) => {
    if (e.type !== 'run.status_changed' || !isTerminalRunStatus(e.payload.to)) return;
    const run = ctx.repos.runs.get(e.payload.runId);
    if (!run || run.kind !== 'agent') return;
    const task = ctx.repos.tasks.findOne({
      where: { assignee_session_id: run.sessionId, status: 'running' },
    });
    if (!task) return;
    const next =
      run.status === 'completed'
        ? 'done'
        : run.status === 'failed'
          ? 'failed'
          : run.status === 'interrupted'
            ? 'ready'
            : null;
    if (next) {
      ctx
        .service('tasks')
        .setStatus(task.id, next, { kind: 'system', component: 'test-spawn' }, run.statusReason);
    }
  });
  ctx.onClose(off);
  return true;
}

function testSpawn(
  ctx: DaemonContext,
  p: Params<'session.spawn'>,
  actor: Actor,
): Result<'session.spawn'> {
  return ctx.db.transaction(() => {
    const parentId = p.parentSessionId ?? (actor.kind === 'agent' ? actor.sessionId : null);
    const parent = parentId ? ctx.repos.sessions.require(parentId) : null;
    const brief = {
      goal: p.goal,
      doneWhen: p.doneWhen ?? [],
      fromSessionId: actor.kind === 'agent' ? actor.sessionId : null,
      reviewBy: p.reviewBy,
      givenAt: ctx.clock.iso(),
    };
    const child = ctx.service('sessions').create(
      {
        kind: p.mode,
        title: p.title,
        parentSessionId: parent?.id ?? null,
        projectId: p.projectId ?? parent?.projectId ?? null,
        brief,
        model: p.mode === 'chat' ? 'mock/fast' : null,
        runtime: p.mode === 'agent' ? 'mock' : null,
      },
      actor,
    );
    const message = ctx.service('sessions').appendMessage({
      sessionId: child.id,
      role: 'user',
      content: [{ type: 'text', text: p.goal }],
      author: actor,
      meta: { kind: 'brief', brief },
    });
    insertTestTask(ctx, {
      projectId: child.projectId,
      title: p.title,
      status: 'running',
      assigneeSessionId: child.id,
      createdBy: actor,
    });
    const run = ctx.service('runs').start({
      sessionId: child.id,
      kind: p.mode === 'agent' ? 'agent' : 'chat',
      createdBy: actor,
      // The task is found by its assignee: the older worker rules (workers.onRunEnded, which
      // follow run.taskId) stay out of the way, like T2's completion will replace them.
      trigger: 'spawn',
      triggerMessageId: message.id,
      model: child.model,
      runtime: child.runtime,
    });
    return {
      session: ctx.repos.sessions.require(child.id),
      runId: run.id,
      budgetId: null,
      waitingFor: [],
    };
  });
}

/** `session.tree` until T7 implements it: the tree's sessions with their derived state. */
export function installTestTree(ctx: DaemonContext): boolean {
  if (ctx.methods.has('session.tree')) return false;
  ctx.methods.register(
    defineMethod('session.tree', {
      scope: (p) => ({ projectIds: [], sessionIds: [p.sessionId] }),
      handler: (p) => {
        const s = ctx.repos.sessions.require(p.sessionId);
        const depth = new Map<string, number>();
        const nodes: SessionCard[] = subtreeIds(ctx, s.rootSessionId).map((id) => {
          const n = ctx.repos.sessions.require(id);
          const dep = n.parentSessionId ? (depth.get(n.parentSessionId) ?? 0) + 1 : 0;
          depth.set(id, dep);
          return {
            id: n.id,
            parentId: n.parentSessionId,
            depth: dep,
            title: n.title,
            role: n.kind,
            state: currentState(ctx, n),
            stateSince: n.stateSince,
            now: n.now,
            costUsd: n.cost.ownUsd,
            budget: null,
            outputs: [],
            attentionIds: [],
            startedBy: n.createdBy.kind === 'human' ? 'human' : 'ai',
            scheduleId: n.scheduleId,
            lastActivityAt: n.lastActivityAt,
          };
        });
        return { rootSessionId: s.rootSessionId, nodes };
      },
    }),
  );
  return true;
}
