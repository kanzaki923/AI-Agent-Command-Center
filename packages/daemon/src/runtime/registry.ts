import type { AgentRuntimeChoice, Settings } from '@acc/protocol';
import type { AgentRuntime, RuntimesService } from '../contracts';
import type { DaemonContext } from '../core/context';
import { notFound } from '../core/errors';
import { MOCK_PREFIX } from '../llm/mock';

export const MOCK_RUNTIME_ID = 'mock';

export interface RuntimeRegistryOptions {
  /**
   * Picks the runtime when the settings name none ("自動"): the id of a runtime that can run
   * here (Claude Code when its CLI is found), or null for the mock. Absent (tests, scripts),
   * "自動" is the mock, so nothing reaches a real agent unless it is asked to.
   */
  detect?: () => { id: string } | { id: null; reason: string };
}

/** `ctx.service('runtimes')`: every registered AgentRuntime, by id. */
export class RuntimeRegistry implements RuntimesService {
  private readonly runtimes = new Map<string, AgentRuntime>();

  constructor(
    private readonly settings: () => Settings,
    private readonly opts: RuntimeRegistryOptions = {},
  ) {}

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

  /**
   * The runtime for a session that names none: the one the settings name, else (自動) the
   * detected one. A mock model always gets the mock runtime under 自動 — the demo and other
   * offline tries must not start a real agent on the person's account.
   */
  defaultId(model?: string | null): string {
    const configured = this.settings().defaultRuntime;
    if (configured && this.runtimes.has(configured)) return configured;
    if (model?.startsWith(MOCK_PREFIX)) return MOCK_RUNTIME_ID;
    return this.detected().id ?? MOCK_RUNTIME_ID;
  }

  choice(): AgentRuntimeChoice {
    const configured = this.settings().defaultRuntime;
    const detected = this.detected();
    return {
      configured: configured && this.runtimes.has(configured) ? configured : null,
      effective: this.defaultId(),
      detected: detected.id,
      ...(detected.id ? {} : { reason: detected.reason }),
    };
  }

  private detected(): { id: string; reason?: undefined } | { id: null; reason: string } {
    const found = this.opts.detect?.();
    if (!found) return { id: null, reason: '自動では選ばない設定です' };
    if (found.id && !this.runtimes.has(found.id)) {
      return { id: null, reason: `実行基盤「${found.id}」がありません` };
    }
    return found;
  }
}

/**
 * The runtime an agent session on `model` would get, for checks made before it exists (the
 * roster's "can Claude Code drive this model"). Without the runtime module: the settings'.
 */
export function defaultRuntimeOf(
  ctx: Pick<DaemonContext, 'hasService' | 'service' | 'settings'>,
  model?: string | null,
): string {
  return ctx.hasService('runtimes')
    ? ctx.service('runtimes').defaultId(model)
    : (ctx.settings.get().defaultRuntime ?? MOCK_RUNTIME_ID);
}
