/** Test helpers of the home track (not used at runtime). */
import {
  type Attention,
  type AttentionKind,
  type Run,
  type RunKind,
  type Schedule,
  DEFAULT_SCHEDULE_RUN,
} from '@acc/protocol';
import type { RunController } from '../contracts';
import type { DaemonContext } from '../core/context';
import { LedgerStore, dayOf } from '../cost/ledger';
import { HUMAN } from '../testing';

const TEST: { kind: 'system'; component: string } = { kind: 'system', component: 'test' };

/** Open an attention item and emit attention.opened, as the attention module (T4) does. */
export function openAttention(
  ctx: DaemonContext,
  sessionId: string,
  kind: AttentionKind,
  title = `${kind} の出番`,
  priority = 10,
): Attention {
  return ctx.db.transaction(() => {
    const session = ctx.repos.sessions.require(sessionId);
    const attention = ctx.repos.attention.insert({
      id: ctx.ids.next('attention'),
      kind,
      status: 'open',
      sessionId,
      rootSessionId: session.rootSessionId,
      title,
      detail: null,
      choices: [],
      allowText: true,
      priority,
      refs: {},
      resolution: null,
      createdAt: ctx.clock.iso(),
      resolvedAt: null,
    });
    ctx.bus.emit({ type: 'attention.opened', actor: TEST, payload: { attention } });
    return attention;
  });
}

export function resolveAttention(ctx: DaemonContext, id: string): Attention {
  return ctx.db.transaction(() => {
    const attention = ctx.repos.attention.update(id, (a) => ({
      ...a,
      status: 'resolved',
      resolution: { choiceId: null, text: null, by: HUMAN },
      resolvedAt: ctx.clock.iso(),
    }));
    ctx.bus.emit({ type: 'attention.resolved', actor: TEST, payload: { attention } });
    return attention;
  });
}

/**
 * Record spend the way the ledger (T5) does: a ledger row for today, `Session.cost` of the
 * session and its ancestors, and `session.cost_updated` for each.
 */
export function recordCost(ctx: DaemonContext, sessionId: string, usd: number): void {
  ctx.db.transaction(() => {
    const session = ctx.repos.sessions.require(sessionId);
    new LedgerStore(ctx.db).insert({
      ts: ctx.clock.iso(),
      day: dayOf(ctx.clock.iso(), ctx.settings.get().limits.timezone),
      session_id: sessionId,
      root_session_id: session.rootSessionId,
      project_id: session.projectId,
      run_id: null,
      model: 'mock/echo',
      component: 'llm',
      cost_micro: Math.round(usd * 1_000_000),
      input_tokens: 0,
      output_tokens: 0,
      source: 'estimated',
    });
    let cur: typeof session | undefined = session;
    while (cur) {
      const own = cur.id === sessionId;
      const next = ctx.repos.sessions.update(cur.id, (s) => ({
        ...s,
        cost: {
          ownUsd: s.cost.ownUsd + (own ? usd : 0),
          treeUsd: s.cost.treeUsd + usd,
          source: 'estimated',
        },
      }));
      ctx.bus.emit({
        type: 'session.cost_updated',
        actor: TEST,
        payload: {
          sessionId: next.id,
          rootSessionId: next.rootSessionId,
          ownUsd: next.cost.ownUsd,
          treeUsd: next.cost.treeUsd,
          source: next.cost.source,
        },
      });
      cur = cur.parentSessionId ? ctx.repos.sessions.get(cur.parentSessionId) : undefined;
    }
  });
}

/** Insert an output artifact (a document) of a session. */
export function insertDocument(
  ctx: DaemonContext,
  sessionId: string,
  title: string,
  createdAt = ctx.clock.iso(),
) {
  return ctx.repos.artifacts.insert({
    id: ctx.ids.next('artifact'),
    projectId: null,
    sessionId,
    runId: null,
    taskId: null,
    workspaceId: null,
    title,
    createdBy: HUMAN,
    createdAt,
    kind: 'document',
    data: { format: 'markdown', content: `# ${title}`, path: null },
  });
}

/** Insert an enabled schedule row (the schedules module, T6, owns creation). */
export function insertSchedule(
  ctx: DaemonContext,
  sessionId: string,
  nextRunAt: string,
  title = '週次レポート',
): Schedule {
  const now = ctx.clock.iso();
  return ctx.repos.schedules.insert({
    id: ctx.ids.next('schedule'),
    sessionId,
    title,
    prompt: 'まとめて',
    trigger: { kind: 'cron', expr: '0 9 * * 1', tz: 'UTC' },
    run: DEFAULT_SCHEDULE_RUN,
    catchUp: 'latest',
    maxLatenessMin: 720,
    enabled: true,
    nextRunAt,
    lastRun: null,
    expiresAt: null,
    createdBy: HUMAN,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Replace the executor of a run kind with one that holds every run until `release(runId)`
 * (or cancel), handing its controller to the test.
 */
export function holdRuns(ctx: DaemonContext, kind: RunKind) {
  const releases = new Map<string, () => void>();
  const controllers = new Map<string, RunController>();
  ctx.service('runs').registerExecutor(
    kind,
    (ctl) =>
      new Promise<void>((resolve, reject) => {
        releases.set(ctl.run.id, resolve);
        controllers.set(ctl.run.id, ctl);
        ctl.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  );
  return {
    controllers,
    release(runId: string) {
      releases.get(runId)?.();
    },
  };
}

/** Start a run in a session and wait until its executor holds it (`running`). */
export async function startHeldRun(
  ctx: DaemonContext,
  sessionId: string,
  kind: RunKind,
  held: ReturnType<typeof holdRuns>,
): Promise<{ run: Run; ctl: RunController }> {
  const run = ctx.service('runs').start({ sessionId, kind, createdBy: HUMAN });
  for (let i = 0; i < 200 && !held.controllers.has(run.id); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const ctl = held.controllers.get(run.id);
  if (!ctl) throw new Error(`run ${run.id} did not start`);
  return { run: ctx.repos.runs.require(run.id), ctl };
}

/** End a held run and wait until it is terminal. */
export async function finishHeldRun(
  ctx: DaemonContext,
  held: ReturnType<typeof holdRuns>,
  runId: string,
): Promise<Run> {
  held.release(runId);
  return ctx.service('runs').waitForEnd(runId);
}
