import type { Actor, MethodName, ParamsInput, Result } from '@acc/protocol';
import type { MethodRegistry } from '../api/registry';
import type { PolicyEngine } from '../api/policy';
import type { Clock } from './clock';
import type { DaemonPaths, SettingsStore } from './config';
import type { Db } from './db';
import type { EventBus } from './events';
import type { IdGenerator } from './ids';
import type { Logger } from './log';
import type { Repos } from './repos';

/**
 * Cross-module services. Modules add entries by declaration merging:
 *
 * ```ts
 * declare module '../core/context' {
 *   interface Services { runs: RunManager }
 * }
 * // in register(ctx):
 * ctx.provide('runs', new RunManager(ctx));
 * // elsewhere, at call time (not at register time):
 * ctx.service('runs').start(...)
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Services {}

export interface CallOptions {
  signal?: AbortSignal | undefined;
}

/** Everything a module needs. Created once per daemon in `createDaemon`. */
export interface DaemonContext {
  readonly version: string;
  readonly startedAt: string;
  readonly paths: DaemonPaths;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly db: Db;
  readonly repos: Repos;
  readonly bus: EventBus;
  readonly settings: SettingsStore;
  readonly methods: MethodRegistry;
  readonly log: Logger;
  /** Port the server listens on (0 until listening). */
  port: number;
  /** Capability enforcement used by the dispatcher. The policy module replaces the default. */
  policy: PolicyEngine;

  /**
   * Call a Control API method in-process as `actor`. Goes through the full dispatcher
   * (param validation, policy check, result validation) — use it for LLM tool calls and
   * for composing methods across modules.
   */
  call<M extends MethodName>(
    actor: Actor,
    method: M,
    params: ParamsInput<M>,
    opts?: CallOptions,
  ): Promise<Result<M>>;

  provide<K extends keyof Services>(name: K, service: Services[K]): void;
  /** Get a service provided by another module. Throws if missing. */
  service<K extends keyof Services>(name: K): Services[K];
  hasService(name: keyof Services): boolean;

  /** Register cleanup to run on daemon shutdown (reverse order). */
  onClose(fn: () => void | Promise<void>): void;

  /**
   * Stop this daemon shortly after the current call returns (so its reply still goes out).
   * Closes the server too when there is one; the hosting process exits on `Daemon.closed`.
   */
  requestShutdown(): void;
}
