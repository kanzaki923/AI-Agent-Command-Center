import { type Actor, type MethodName, type Params, type Result, api } from '@acc/protocol';
import type { z } from 'zod';
import type { DaemonContext } from '../core/context';
import type { Connection } from './connection';

/** Per-call information handed to handlers. */
export interface CallContext {
  actor: Actor;
  ctx: DaemonContext;
  /** WebSocket connection the call came in on; null for in-process calls. */
  connection: Connection | null;
  /** Aborted when the connection closes or the daemon shuts down (use for long polls). */
  signal: AbortSignal;
}

/** Projects a call touches, for capability scope checks. */
export interface CallScope {
  projectIds: string[];
}

export type ResultInput<M extends MethodName> = z.input<(typeof api)[M]['result']>;

export interface MethodImpl<M extends MethodName = MethodName> {
  name: M;
  /**
   * Resolve which projects the call touches. Define it for every project-scoped method:
   * agents restricted to some projects are denied when the scope can't be resolved.
   * Omit for global methods (system.*, models.list).
   */
  scope?: (params: Params<M>, call: CallContext) => CallScope;
  handler: (params: Params<M>, call: CallContext) => ResultInput<M> | Promise<ResultInput<M>>;
}

/**
 * Define the implementation of a method declared in `@acc/protocol` `api`. Params and result
 * types come from the contract; the dispatcher validates both.
 */
export function defineMethod<M extends MethodName>(
  name: M,
  impl: Omit<MethodImpl<M>, 'name'>,
): MethodImpl<M> {
  return { name, ...impl };
}

/** Union of every concrete MethodImpl (what `register` accepts). */
export type AnyMethodImpl = { [M in MethodName]: MethodImpl<M> }[MethodName];

export class MethodRegistry {
  private readonly impls = new Map<string, MethodImpl>();

  register(...impls: AnyMethodImpl[]): void {
    for (const impl of impls) {
      if (!Object.hasOwn(api, impl.name)) {
        throw new Error(`Method "${impl.name}" is not declared in @acc/protocol api`);
      }
      if (this.impls.has(impl.name)) {
        throw new Error(`Method "${impl.name}" is already registered`);
      }
      this.impls.set(impl.name, impl);
    }
  }

  get(name: string): MethodImpl | undefined {
    return this.impls.get(name);
  }

  has(name: string): boolean {
    return this.impls.has(name);
  }

  names(): MethodName[] {
    return [...this.impls.keys()].sort() as MethodName[];
  }
}

export type { Result };
