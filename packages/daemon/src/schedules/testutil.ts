/** Test helpers for the schedules module (not used at runtime). */
import type { Actor, Params, Result } from '@acc/protocol';
import type { SpawnOptions, SpawnerService } from '../contracts';
import type { DaemonContext } from '../core/context';
import type { DaemonModule } from '../module';
import { modules as defaultModules } from '../modules';
import { insertRun } from '../policy/testutil';
import { createSchedulesModule } from './index';
import type { TimerHost } from './scheduler';

/** A timer that only fires when the test says so. */
export class ManualTimers implements TimerHost {
  readonly armed: { fn: () => void; ms: number }[] = [];

  set(fn: () => void, ms: number): unknown {
    const t = { fn, ms };
    this.armed.push(t);
    return t;
  }

  clear(handle: unknown): void {
    const i = this.armed.indexOf(handle as { fn: () => void; ms: number });
    if (i >= 0) this.armed.splice(i, 1);
  }

  /** Delay of the armed timer (ms), or null. */
  get delay(): number | null {
    return this.armed[0]?.ms ?? null;
  }

  /** Fire the armed timer, as if its time had come (possibly late, after a sleep). */
  fire(): void {
    const t = this.armed.shift();
    t?.fn();
  }
}

export interface SpawnCall {
  params: Params<'session.spawn'>;
  actor: Actor;
  opts: SpawnOptions | undefined;
}

/**
 * Stands in for the Spawn track's spawner: creates the child session the way spec §3.3 says
 * (under the parent, in its tree, with the brief, `scheduleId` and a first message carrying
 * `meta.schedule`), its budget per `opts.budget`, and a running run (end it with setRunStatus).
 */
export class FakeSpawner {
  readonly calls: SpawnCall[] = [];
  /** Throw this from the next spawns (e.g. a budget_exceeded ApiError). */
  failWith: Error | null = null;

  service(ctx: DaemonContext): SpawnerService {
    return { spawn: (params, actor, opts) => this.spawn(ctx, params, actor, opts) };
  }

  spawn(
    ctx: DaemonContext,
    params: Params<'session.spawn'>,
    actor: Actor,
    opts?: SpawnOptions,
  ): Promise<Result<'session.spawn'>> {
    this.calls.push({ params, actor, opts });
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(
      ctx.db.transaction(() => {
        const parent = ctx.repos.sessions.require(params.parentSessionId!);
        const now = ctx.clock.iso();
        const id = ctx.ids.next('session');
        let budgetId: string | null = null;
        if (opts?.budget) {
          const budgets = ctx.service('budget');
          const subject = { kind: 'session' as const, id };
          budgetId = (
            opts.budget.parentBudgetId
              ? budgets.allocate({
                  parentId: opts.budget.parentBudgetId,
                  subject,
                  limitUsd: opts.budget.limitUsd,
                  actor,
                })
              : budgets.createRoot({ subject, limitUsd: opts.budget.limitUsd, actor })
          ).id;
        }
        const session = ctx.repos.sessions.insert({
          id,
          projectId: params.projectId ?? parent.projectId,
          kind: params.mode,
          title: params.title,
          model: params.model ?? null,
          runtime: null,
          systemPrompt: null,
          workspaceId: null,
          taskId: null,
          parentSessionId: parent.id,
          rootSessionId: parent.rootSessionId,
          brief: {
            goal: params.goal,
            doneWhen: params.doneWhen ?? [],
            fromSessionId: null,
            reviewBy: params.reviewBy,
            givenAt: now,
          },
          scheduleId: opts?.scheduleId ?? null,
          activeRunId: null,
          pinned: false,
          createdBy: actor,
          createdAt: now,
          updatedAt: now,
          lastActivityAt: now,
          archivedAt: null,
        });
        ctx.repos.messages.insert({
          id: ctx.ids.next('message'),
          sessionId: id,
          runId: null,
          role: 'user',
          content: [{ type: 'text', text: params.goal }],
          author: actor,
          model: null,
          createdAt: now,
          meta:
            opts?.scheduleId && opts.scheduledFor
              ? { kind: 'schedule', scheduleId: opts.scheduleId, scheduledFor: opts.scheduledFor }
              : null,
        });
        const run = insertRun(ctx, { sessionId: id, status: 'running', budgetId });
        return { session, runId: run.id, budgetId, waitingFor: [] };
      }),
    );
  }
}

/** The default module list with the schedules module driven by a fake spawner and timer. */
export function scheduleTestModules(spawner: FakeSpawner, timers: ManualTimers): DaemonModule[] {
  return defaultModules.map((m) =>
    m.name === 'schedules'
      ? createSchedulesModule({ spawner: (ctx) => spawner.service(ctx), timers })
      : m,
  );
}
