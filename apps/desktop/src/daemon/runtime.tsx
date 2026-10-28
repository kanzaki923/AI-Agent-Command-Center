import type { AccClient, ConnectionState } from '@acc/client';
import type { MethodName, ParamsInput, Result } from '@acc/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, createContext, use, useSyncExternalStore } from 'react';
import { createStore } from 'zustand/vanilla';
import { toast } from '../store/toast';
import { createActivityStore } from './activity';
import { createDeltaStore } from './deltas';
import { isNotImplemented } from './errors';
import { createEventLog } from './eventLog';
import { type Streams, startSync } from './sync';

/** Everything the UI needs to talk to the Core Daemon. Created once at startup. */
export interface AppRuntime {
  client: AccClient;
  queryClient: QueryClient;
  streams: Streams;
  /** Methods that answered not_implemented (shown in settings, never as errors). */
  unimplemented: ReturnType<typeof createUnimplementedStore>;
  markUnimplemented(method: string): void;
  /** Connection lifecycle facts the client does not keep (first open, last failure). */
  status: ReturnType<typeof createStatusStore>;
  /** Typed call that maps not_implemented to `fallback`. */
  callOr<M extends MethodName>(
    method: M,
    params: ParamsInput<M>,
    fallback: Result<M>,
  ): Promise<Result<M>>;
  dispose(): void;
}

function createStatusStore() {
  return createStore<{ everConnected: boolean; lastError: string | null }>(() => ({
    everConnected: false,
    lastError: null,
  }));
}

function createUnimplementedStore() {
  return createStore<{ methods: string[] }>(() => ({ methods: [] }));
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // The event stream keeps caches fresh; refetch only on reconnect/invalidation.
        staleTime: Infinity,
        gcTime: 10 * 60_000,
        refetchOnWindowFocus: false,
        retry: (count, err) => !isNotImplemented(err) && count < 2,
      },
    },
  });
}

export function createRuntime(
  client: AccClient,
  queryClient = createQueryClient(),
  status = createStatusStore(),
): AppRuntime {
  const streams: Streams = {
    deltas: createDeltaStore(),
    activity: createActivityStore(),
    events: createEventLog(),
  };
  const unimplemented = createUnimplementedStore();
  const stopSync = startSync(client, queryClient, streams, (count) =>
    toast({
      key: 'interrupted',
      title: `中断した Run が ${count} 件あります`,
      detail: 'Core Daemon の再起動などで止まりました。再開または再試行できます',
      tone: 'info',
      sticky: false,
    }),
  );
  const markOpen = () => {
    if (client.state === 'open') status.setState({ everConnected: true, lastError: null });
  };
  markOpen();
  const offState = client.onStateChange(markOpen);
  const stop = () => {
    offState();
    stopSync();
  };
  const markUnimplemented = (method: string) => {
    const cur = unimplemented.getState().methods;
    if (!cur.includes(method)) unimplemented.setState({ methods: [...cur, method].sort() });
  };
  const call = client.call.bind(client) as (method: string, params: unknown) => Promise<unknown>;
  return {
    client,
    queryClient,
    streams,
    unimplemented,
    markUnimplemented,
    status,
    async callOr<M extends MethodName>(method: M, params: ParamsInput<M>, fallback: Result<M>) {
      try {
        return (await call(method, params)) as Result<M>;
      } catch (err) {
        if (!isNotImplemented(err)) throw err;
        markUnimplemented(method);
        return fallback;
      }
    },
    dispose() {
      stop();
      client.close();
      queryClient.clear();
    },
  };
}

const RuntimeContext = createContext<AppRuntime | null>(null);

export function RuntimeProvider({ runtime, children }: { runtime: AppRuntime; children: ReactNode }) {
  return (
    <RuntimeContext value={runtime}>
      <QueryClientProvider client={runtime.queryClient}>{children}</QueryClientProvider>
    </RuntimeContext>
  );
}

export { createStatusStore };

export function useRuntime(): AppRuntime {
  const rt = use(RuntimeContext);
  if (!rt) throw new Error('useRuntime must be used inside <RuntimeProvider>');
  return rt;
}

export function useConnectionState(): ConnectionState {
  const { client } = useRuntime();
  return useSyncExternalStore(
    (cb) => client.onStateChange(cb),
    () => client.state,
  );
}
