import type { Settings } from '@acc/protocol';
import type { AgentRuntime, RuntimesService } from '../contracts';
import { notFound } from '../core/errors';

export const MOCK_RUNTIME_ID = 'mock';

/** `ctx.service('runtimes')`: every registered AgentRuntime, by id. */
export class RuntimeRegistry implements RuntimesService {
  private readonly runtimes = new Map<string, AgentRuntime>();

  constructor(private readonly settings: () => Settings) {}

  register(runtime: AgentRuntime): void {
    if (this.runtimes.has(runtime.id)) {
      throw new Error(`Runtime "${runtime.id}" is already registered`);
    }
    this.runtimes.set(runtime.id, runtime);
  }

  get(id: string): AgentRuntime {
    const rt = this.runtimes.get(id);
    if (!rt) throw notFound('runtime', id);
    return rt;
  }

  has(id: string): boolean {
    return this.runtimes.has(id);
  }

  list(): AgentRuntime[] {
    return [...this.runtimes.values()];
  }

  /** settings.defaultRuntime when it names a registered runtime, else "mock". */
  defaultId(): string {
    const configured = this.settings().defaultRuntime;
    return configured && this.runtimes.has(configured) ? configured : MOCK_RUNTIME_ID;
  }
}
