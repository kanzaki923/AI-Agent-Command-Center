import { type Actor, type RpcError, api, isMethodName } from '@acc/protocol';
import { z } from 'zod';
import type { DaemonContext } from '../core/context';
import { ApiError } from '../core/errors';
import type { Logger } from '../core/log';
import type { Connection } from './connection';
import type { CallContext } from './registry';

export interface DispatchInput {
  actor: Actor;
  method: string;
  params: unknown;
  connection?: Connection | null;
  signal?: AbortSignal | undefined;
}

/**
 * The single entry point for every Control API call (WebSocket clients and in-process
 * agents alike):
 *   1. resolve method (declared in protocol + implemented by a module)
 *   2. validate params with zod            → invalid_params
 *   3. resolve scope + PolicyEngine.check   → forbidden
 *   4. run handler                          → ApiError code or internal
 *   5. validate result with zod             → internal (contract bug)
 */
export class Dispatcher {
  private readonly log: Logger;

  constructor(private readonly ctx: DaemonContext) {
    this.log = ctx.log.child('dispatch');
  }

  async dispatch(input: DispatchInput): Promise<unknown> {
    const { method, actor } = input;
    if (!isMethodName(method)) {
      throw new ApiError('not_found', `Unknown method: ${method}`, { reason: 'unknown_method' });
    }
    const spec = api[method];
    const impl = this.ctx.methods.get(method);
    if (!impl) {
      throw new ApiError('not_found', `Method not implemented yet: ${method}`, {
        reason: 'not_implemented',
      });
    }

    const parsed = spec.params.safeParse(input.params ?? {});
    if (!parsed.success) {
      throw new ApiError('invalid_params', z.prettifyError(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    const params = parsed.data as never;

    const call: CallContext = {
      actor,
      ctx: this.ctx,
      connection: input.connection ?? null,
      signal: input.signal ?? new AbortController().signal,
    };

    const scope = impl.scope ? impl.scope(params, call) : undefined;
    const decision = this.ctx.policy.check(actor, spec.permission, scope);
    if (!decision.allowed) {
      throw new ApiError('forbidden', `Not allowed to call ${method}: ${decision.reason}`, {
        permission: spec.permission,
      });
    }

    const raw = await impl.handler(params, call);
    const result = spec.result.safeParse(raw);
    if (!result.success) {
      this.log.error('result validation failed', {
        method,
        issues: z.prettifyError(result.error),
      });
      throw new ApiError('internal', `Invalid result from ${method}`);
    }
    return result.data;
  }
}

/** Convert anything thrown by dispatch into a wire error. */
export function toRpcError(err: unknown, log?: Logger): RpcError {
  if (err instanceof ApiError) return err.toRpc();
  log?.error('unhandled error', { err });
  return { code: 'internal', message: err instanceof Error ? err.message : 'Internal error' };
}
