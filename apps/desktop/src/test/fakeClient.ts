import { type AccClient, AccClientError, type ConnectionState, type SubscribeOptions } from '@acc/client';
import type { Delta, Event } from '@acc/protocol';

type Handler = (params: Record<string, unknown>) => unknown;

/**
 * In-memory AccClient for component tests. Unknown methods answer like the daemon does
 * for contract methods nobody implemented yet: not_found + reason "not_implemented".
 */
export function createFakeClient(handlers: Record<string, Handler> = {}) {
  let state: ConnectionState = 'open';
  const listeners = new Set<(s: ConnectionState) => void>();
  const subs = new Set<SubscribeOptions>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];

  const client: AccClient = {
    get state() {
      return state;
    },
    onStateChange(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    ready: () => Promise.resolve(),
    call: ((method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      const h = handlers[method];
      if (!h) {
        return Promise.reject(
          new AccClientError('not_found', `Method not implemented: ${method}`, { reason: 'not_implemented' }),
        );
      }
      try {
        return Promise.resolve(h(params));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }) as AccClient['call'],
    subscribe(opts) {
      subs.add(opts);
      return {
        lastSeq: null,
        unsubscribe: () => subs.delete(opts),
      };
    },
    close() {
      state = 'closed';
    },
  };

  return {
    client,
    calls,
    handlers,
    setState(s: ConnectionState) {
      state = s;
      for (const l of listeners) l(s);
    },
    emit(e: Event) {
      for (const s of subs) s.onEvent?.(e);
    },
    delta(d: Delta) {
      for (const s of subs) s.onDelta?.(d);
    },
  };
}
