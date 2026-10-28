import type { DaemonContext } from './core/context';
import type { Migration } from './core/migrations';

export interface ModuleHooks {
  /** Called after every module registered and startup recovery ran, before listening. */
  start?(): void | Promise<void>;
  /** Called on shutdown, in reverse module order. */
  stop?(): void | Promise<void>;
}

/**
 * A daemon module: one directory under `src/`, one `index.ts` exporting a module object.
 * `register` adds API methods (`ctx.methods.register(defineMethod(...))`), event
 * subscriptions (`ctx.bus.subscribe`) and services (`ctx.provide`). Do the real work in
 * `start` (timers, schedulers), not in `register`.
 */
export interface DaemonModule {
  name: string;
  /** Module-owned migrations; ids must start with `<name>/`. */
  migrations?: Migration[];
  register(ctx: DaemonContext): void | ModuleHooks;
}

export function defineModule(m: DaemonModule): DaemonModule {
  for (const mig of m.migrations ?? []) {
    if (!mig.id.startsWith(`${m.name}/`)) {
      throw new Error(`Migration "${mig.id}" of module "${m.name}" must start with "${m.name}/"`);
    }
  }
  return m;
}
