import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import {
  type Actor,
  type AgentActor,
  type DaemonInfo,
  type MethodName,
  type ParamsInput,
  type Result,
  DaemonInfo as DaemonInfoSchema,
} from '@acc/protocol';
import { Dispatcher } from './api/dispatcher';
import { GrantPolicyEngine, type PolicyEngine } from './api/policy';
import { MethodRegistry } from './api/registry';
import { type RunningServer, startServer } from './api/server';
import { type Clock, systemClock } from './core/clock';
import {
  type DaemonPaths,
  SettingsStore,
  resolvePaths,
  resolvePort,
  writeJsonAtomic,
} from './core/config';
import type { CallOptions, DaemonContext, Services } from './core/context';
import { type Db, openDb } from './core/db';
import { EventBus } from './core/events';
import { type IdGenerator, createIdGenerator } from './core/ids';
import { type Logger, createLogger, parseLogLevel } from './core/log';
import { coreMigrations, runMigrations } from './core/migrations';
import { type RecoveryReport, recoverOnStartup } from './core/recovery';
import { type Repos, createRepos } from './core/repos';
import type { DaemonModule, ModuleHooks } from './module';
import { modules as defaultModules } from './modules';
import { DAEMON_VERSION } from './version';

export interface CreateDaemonOptions {
  /** Data directory. Default: $ACC_HOME or ~/.acc */
  home?: string;
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  log?: Logger;
  modules?: DaemonModule[];
  /** SQLite path; default `<home>/acc.sqlite`. ':memory:' is fine for unit tests. */
  dbPath?: string;
  /** Override the policy engine (otherwise GrantPolicyEngine over the grants table). */
  policy?: PolicyEngine;
}

export interface StartDaemonOptions extends CreateDaemonOptions {
  /** Default: ACC_PORT, config.json `port`, then 47821. 0 picks a free port. */
  port?: number;
  host?: string;
  /** Write `<home>/daemon.json` (default true). */
  writeDaemonInfo?: boolean;
  token?: string;
}

export interface Daemon {
  ctx: DaemonContext;
  dispatcher: Dispatcher;
  recovery: RecoveryReport;
  /** Shorthand for ctx.call. */
  call: DaemonContext['call'];
  close(): Promise<void>;
  /**
   * Settles once the daemon has fully stopped, whoever stopped it (`close()`, or
   * `system.shutdown` via `ctx.requestShutdown()`). The process entry point exits on it.
   */
  closed: Promise<void>;
}

export interface RunningDaemon extends Daemon {
  port: number;
  token: string;
  /** http://127.0.0.1:<port> */
  url: string;
  /** ws://127.0.0.1:<port>/ws (without token) */
  wsUrl: string;
  info: DaemonInfo;
}

class Context implements DaemonContext {
  readonly version = DAEMON_VERSION;
  readonly startedAt: string;
  readonly repos: Repos;
  readonly bus: EventBus;
  readonly methods = new MethodRegistry();
  port = 0;
  policy: PolicyEngine;
  dispatcher!: Dispatcher;
  readonly shutdown = new AbortController();
  private readonly services = new Map<string, unknown>();
  readonly closers: (() => void | Promise<void>)[] = [];
  /** What requestShutdown() runs: createDaemon's close, replaced by startDaemon's. */
  shutdownHandler: (() => Promise<void>) | null = null;

  constructor(
    readonly paths: DaemonPaths,
    readonly clock: Clock,
    readonly ids: IdGenerator,
    readonly db: Db,
    readonly settings: SettingsStore,
    readonly log: Logger,
    policy: PolicyEngine | undefined,
  ) {
    this.startedAt = clock.iso();
    this.repos = createRepos(db);
    this.bus = new EventBus(db, ids, clock, log.child('events'));
    this.policy =
      policy ?? new GrantPolicyEngine((actor: AgentActor) => this.activeGrantsFor(actor), clock);
  }

  private activeGrantsFor(actor: AgentActor) {
    return this.repos.grants.find({
      where: { revoked_at: null },
      sql: {
        clause:
          "(subject_kind = 'run' AND subject_id = ?) OR (subject_kind = 'session' AND subject_id = ?)",
        params: [actor.runId, actor.sessionId],
      },
    });
  }

  call<M extends MethodName>(
    actor: Actor,
    method: M,
    params: ParamsInput<M>,
    opts?: CallOptions,
  ): Promise<Result<M>> {
    const signal = opts?.signal
      ? AbortSignal.any([opts.signal, this.shutdown.signal])
      : this.shutdown.signal;
    return this.dispatcher.dispatch({ actor, method, params, signal }) as Promise<Result<M>>;
  }

  provide<K extends keyof Services>(name: K, service: Services[K]): void {
    if (this.services.has(name)) throw new Error(`Service "${name}" is already provided`);
    this.services.set(name, service);
  }

  service<K extends keyof Services>(name: K): Services[K] {
    if (!this.services.has(name))
      throw new Error(`Service "${name}" is not provided by any module`);
    return this.services.get(name) as Services[K];
  }

  hasService(name: keyof Services): boolean {
    return this.services.has(name);
  }

  onClose(fn: () => void | Promise<void>): void {
    this.closers.push(fn);
  }

  requestShutdown(): void {
    const handler = this.shutdownHandler;
    if (!handler) return;
    // Give the in-flight reply time to leave the socket before the server closes.
    setTimeout(() => {
      handler().catch((err: unknown) => this.log.error('shutdown failed', { err }));
    }, SHUTDOWN_REPLY_GRACE_MS);
  }
}

const SHUTDOWN_REPLY_GRACE_MS = 50;

/** Build a daemon without network: DB + migrations + recovery + modules. */
export async function createDaemon(opts: CreateDaemonOptions = {}): Promise<Daemon> {
  const env = opts.env ?? process.env;
  const paths = resolvePaths(opts.home, env);
  mkdirSync(paths.home, { recursive: true });
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? createLogger(parseLogLevel(env.ACC_LOG_LEVEL));
  const mods = opts.modules ?? defaultModules;
  const db = openDb(opts.dbPath ?? paths.db);

  try {
    const applied = runMigrations(
      db,
      [...coreMigrations, ...mods.flatMap((m) => m.migrations ?? [])],
      () => clock.iso(),
    );
    if (applied.length > 0) log.info('migrations applied', { ids: applied });

    const ctx = new Context(
      paths,
      clock,
      createIdGenerator(clock),
      db,
      new SettingsStore(paths.config, env),
      log,
      opts.policy,
    );
    const dispatcher = new Dispatcher(ctx);
    ctx.dispatcher = dispatcher;

    const recovery = recoverOnStartup(ctx);
    if (recovery.interruptedRuns.length > 0) {
      log.warn('interrupted runs left over from a previous process', {
        runs: recovery.interruptedRuns.length,
      });
    }

    const hooks: ModuleHooks[] = [];
    for (const m of mods) {
      const h = m.register(ctx);
      if (h) hooks.push(h);
    }
    for (const h of hooks) await h.start?.();

    let markClosed!: () => void;
    const closedPromise = new Promise<void>((resolve) => (markClosed = resolve));
    let closing: Promise<void> | null = null;
    const close = () => (closing ??= doClose().finally(markClosed));
    const doClose = async () => {
      ctx.shutdown.abort();
      for (const h of [...hooks].reverse()) {
        try {
          await h.stop?.();
        } catch (err) {
          log.error('module stop failed', { err });
        }
      }
      for (const fn of [...ctx.closers].reverse()) {
        try {
          await fn();
        } catch (err) {
          log.error('close hook failed', { err });
        }
      }
      db.close();
    };
    ctx.shutdownHandler = close;

    return {
      ctx,
      dispatcher,
      recovery,
      call: ctx.call.bind(ctx),
      close,
      closed: closedPromise,
    };
  } catch (err) {
    db.close();
    throw err;
  }
}

/** createDaemon + HTTP/WS server + daemon.json. */
export async function startDaemon(opts: StartDaemonOptions = {}): Promise<RunningDaemon> {
  const env = opts.env ?? process.env;
  const daemon = await createDaemon(opts);
  const { ctx } = daemon;
  const token = opts.token ?? randomBytes(32).toString('base64url');
  const host = opts.host ?? '127.0.0.1';
  let server: RunningServer;
  try {
    const port = resolvePort(opts.port, ctx.settings.config(), env);
    server = await startServer(ctx, daemon.dispatcher, { host, port, token });
  } catch (err) {
    await daemon.close();
    throw err;
  }
  ctx.port = server.port;

  const info: DaemonInfo = {
    port: server.port,
    token,
    pid: process.pid,
    startedAt: ctx.startedAt,
    version: ctx.version,
  };
  const writeInfo = opts.writeDaemonInfo ?? true;
  if (writeInfo) writeJsonAtomic(ctx.paths.daemonInfo, info);

  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      await server.close();
      if (writeInfo) removeDaemonInfoIfOurs(ctx.paths.daemonInfo, token);
      await daemon.close();
    })());
  (ctx as Context).shutdownHandler = close;

  return {
    ...daemon,
    close,
    port: server.port,
    token,
    url: `http://${host}:${server.port}`,
    wsUrl: `ws://${host}:${server.port}/ws`,
    info,
  };
}

export function readDaemonInfoFile(path: string): DaemonInfo | null {
  try {
    return DaemonInfoSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

function removeDaemonInfoIfOurs(path: string, token: string): void {
  const current = readDaemonInfoFile(path);
  if (current && current.token === token) rmSync(path, { force: true });
}
