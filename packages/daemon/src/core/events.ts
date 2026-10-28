import {
  type Actor,
  type Delta,
  type DeltaInput,
  Delta as DeltaSchema,
  type Event,
  type EventFilter,
  type EventOf,
  type EventPayload,
  type EventRefs,
  type EventType,
  eventMatchesFilter,
  eventPayloads,
  matchPattern,
} from '@acc/protocol';
import type { Clock } from './clock';
import type { Db, SqlValue } from './db';
import type { IdGenerator } from './ids';
import type { Logger } from './log';

export interface EmitInput<T extends EventType> {
  type: T;
  actor: Actor;
  payload: EventPayload<T>;
  /** Envelope refs. Missing refs are derived from the payload (see deriveRefs). */
  refs?: Partial<EventRefs>;
}

export interface ListEventsQuery extends EventFilter {
  /** Return events with seq > since. */
  since?: number;
  limit?: number;
}

export interface ListEventsResult {
  events: Event[];
  lastSeq: number;
  hasMore: boolean;
}

export type EventListener = (event: Event) => void;
export type DeltaListener = (delta: Delta) => void;

interface EventRow {
  seq: number;
  id: string;
  type: string;
  ts: string;
  project_id: string | null;
  session_id: string | null;
  run_id: string | null;
  task_id: string | null;
  actor: string;
  payload: string;
}

/**
 * Persisted, ordered event log + in-process pub/sub.
 *
 * - `emit` appends to the `events` table (monotonic `seq`) inside the caller's transaction
 *   (if any) and notifies subscribers only after commit, so listeners never observe events
 *   that were rolled back.
 * - Deltas are ephemeral streaming fragments: published to subscribers, never stored.
 */
export class EventBus {
  private readonly listeners = new Set<{ filter: EventFilter | undefined; fn: EventListener }>();
  private readonly deltaListeners = new Set<{
    filter: EventFilter | undefined;
    fn: DeltaListener;
  }>();

  constructor(
    private readonly db: Db,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  emit<T extends EventType>(input: EmitInput<T>): EventOf<T> {
    const schema = eventPayloads[input.type];
    const payload = schema.parse(input.payload) as EventPayload<T>;
    const derived = deriveRefs(payload);
    const refs: EventRefs = {
      projectId: input.refs?.projectId ?? derived.projectId ?? null,
      sessionId: input.refs?.sessionId ?? derived.sessionId ?? null,
      runId: input.refs?.runId ?? derived.runId ?? null,
      taskId: input.refs?.taskId ?? derived.taskId ?? null,
    };
    const id = this.ids.next('event');
    const ts = this.clock.iso();
    const { lastInsertRowid } = this.db.run(
      `INSERT INTO events (id, type, ts, project_id, session_id, run_id, task_id, actor, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.type,
        ts,
        refs.projectId,
        refs.sessionId,
        refs.runId,
        refs.taskId,
        JSON.stringify(input.actor),
        JSON.stringify(payload),
      ],
    );
    const event = {
      seq: lastInsertRowid,
      id,
      ts,
      actor: input.actor,
      ...refs,
      type: input.type,
      payload,
    } as EventOf<T>;
    this.db.afterCommit(() => this.publish(event as Event));
    return event;
  }

  private publish(event: Event): void {
    for (const l of this.listeners) {
      if (!eventMatchesFilter(event, l.filter)) continue;
      try {
        l.fn(event);
      } catch (err) {
        this.log.error('event listener failed', { type: event.type, err });
      }
    }
  }

  /** Subscribe to events committed from now on. Returns an unsubscribe function. */
  subscribe(filter: EventFilter | undefined, fn: EventListener): () => void {
    const entry = { filter, fn };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  publishDelta(input: DeltaInput): void {
    const delta = DeltaSchema.parse(input);
    for (const l of this.deltaListeners) {
      // Deltas honour only sessionId/runId filters (they carry no project/task refs and
      // `types` applies to persisted events).
      if (l.filter?.sessionId && l.filter.sessionId !== delta.sessionId) continue;
      if (l.filter?.runId && l.filter.runId !== delta.runId) continue;
      try {
        l.fn(delta);
      } catch (err) {
        this.log.error('delta listener failed', { err });
      }
    }
  }

  subscribeDeltas(filter: EventFilter | undefined, fn: DeltaListener): () => void {
    const entry = { filter, fn };
    this.deltaListeners.add(entry);
    return () => {
      this.deltaListeners.delete(entry);
    };
  }

  /**
   * Resolve with the first committed event matching `filter` and `predicate`, or null on
   * timeout/abort. Subscribes before returning, so call it before triggering the action
   * you wait for (or re-check state after subscribing).
   */
  waitFor(
    filter: EventFilter | undefined,
    predicate: (e: Event) => boolean,
    opts: { timeoutMs: number; signal?: AbortSignal | undefined },
  ): Promise<Event | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (e: Event | null) => {
        if (done) return;
        done = true;
        unsubscribe();
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(e);
      };
      const onAbort = () => finish(null);
      const unsubscribe = this.subscribe(filter, (e) => {
        if (predicate(e)) finish(e);
      });
      const timer = setTimeout(() => finish(null), opts.timeoutMs);
      if (opts.signal?.aborted) finish(null);
      else opts.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  lastSeq(): number {
    return this.db.get<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM events')?.seq ?? 0;
  }

  list(q: ListEventsQuery = {}): ListEventsResult {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    const since = q.since ?? 0;
    clauses.push('seq > ?');
    params.push(since);
    const refCols = [
      ['project_id', q.projectId],
      ['session_id', q.sessionId],
      ['run_id', q.runId],
      ['task_id', q.taskId],
    ] as const;
    for (const [col, v] of refCols) {
      if (v) {
        clauses.push(`${col} = ?`);
        params.push(v);
      }
    }
    if (q.types && q.types.length > 0) {
      // Exact types go to SQL; patterns are matched in SQL via LIKE on the prefix and then
      // re-checked in JS for exactness.
      const ors: string[] = [];
      for (const t of q.types) {
        if (t === '*') {
          ors.push('1');
        } else if (t.includes('*')) {
          const prefix = t.slice(0, t.indexOf('*'));
          ors.push("type LIKE ? ESCAPE '\\'");
          params.push(prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + '%');
        } else {
          ors.push('type = ?');
          params.push(t);
        }
      }
      clauses.push(`(${ors.join(' OR ')})`);
    }
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 5000);
    const rows = this.db.all<EventRow>(
      `SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY seq ASC LIMIT ?`,
      [...params, limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const lastSeq = page.length > 0 ? page[page.length - 1]!.seq : since;
    let events = page.map(rowToEvent);
    if (q.types?.some((t) => t.includes('*') && t !== '*')) {
      events = events.filter((e) => q.types!.some((p) => matchPattern(p, e.type)));
    }
    return { events, lastSeq, hasMore };
  }
}

function rowToEvent(r: EventRow): Event {
  return {
    seq: r.seq,
    id: r.id,
    ts: r.ts,
    type: r.type,
    projectId: r.project_id,
    sessionId: r.session_id,
    runId: r.run_id,
    taskId: r.task_id,
    actor: JSON.parse(r.actor) as Actor,
    payload: JSON.parse(r.payload) as unknown,
  } as Event;
}

type RefSource = {
  id?: unknown;
  projectId?: unknown;
  sessionId?: unknown;
  runId?: unknown;
  taskId?: unknown;
};

/**
 * Derive envelope refs from well-known payload shapes, so emitters rarely pass refs by hand:
 * `{ project }`, `{ session }`, `{ message }`, `{ run }`, `{ task }`, `{ workspace }`,
 * `{ artifact }`, `{ integration }`, `{ approval }`, plus top-level `sessionId` / `runId`.
 */
export function deriveRefs(payload: unknown): Partial<EventRefs> {
  if (!payload || typeof payload !== 'object') return {};
  const p = payload as Record<string, RefSource | undefined> & RefSource;
  const out: Partial<EventRefs> = {};
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const set = (k: keyof EventRefs, v: unknown) => {
    const s = str(v);
    if (s && !out[k]) out[k] = s;
  };

  if (p.project) set('projectId', p.project.id);
  if (p.session) {
    set('sessionId', p.session.id);
    set('projectId', p.session.projectId);
    set('taskId', p.session.taskId);
  }
  if (p.run) {
    set('runId', p.run.id);
    set('sessionId', p.run.sessionId);
    set('projectId', p.run.projectId);
    set('taskId', p.run.taskId);
  }
  if (p.task) {
    set('taskId', p.task.id);
    set('projectId', p.task.projectId);
  }
  for (const key of ['message', 'workspace', 'artifact', 'integration', 'approval'] as const) {
    const e = p[key];
    if (!e) continue;
    set('projectId', e.projectId);
    set('sessionId', e.sessionId);
    set('runId', e.runId);
    set('taskId', e.taskId);
  }
  set('sessionId', p.sessionId);
  set('runId', p.runId);
  set('taskId', p.taskId);
  set('projectId', p.projectId);
  return out;
}
