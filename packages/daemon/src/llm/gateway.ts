import { EMPTY_USAGE, type ModelInfo } from '@acc/protocol';
import type { Logger } from '../core/log';
import { MOCK_PREFIX, MockProvider } from './mock';
import { type LiteLlmConnection, OpenAiCompatibleProvider, authHeaders, joinUrl } from './openai';
import type { ChatRequest, ChatResult, ChatToolCall, LlmStreamEvent, PricingLookup } from './types';

export interface LlmGatewayOptions {
  connection: () => LiteLlmConnection;
  /** Settings default model; listed even when LiteLLM is unreachable. */
  defaultModel?: () => string | null;
  log: Logger;
  fetch?: typeof fetch;
  pricing?: PricingLookup;
  /** See OpenAiProviderOptions.idleTimeoutMs. */
  idleTimeoutMs?: number;
  /** How long a successful /models answer is reused (default 5 min). */
  modelsTtlMs?: number;
  now?: () => number;
}

export interface CompleteOptions {
  signal: AbortSignal;
  onText?: (text: string) => void;
  onReasoning?: (text: string) => void;
}

export interface ModelList {
  models: ModelInfo[];
  /** litellm: LiteLLM answered; config: LiteLLM configured but unreachable; mock: not configured. */
  source: 'litellm' | 'config' | 'mock';
}

/**
 * The LLM Gateway (`ctx.service('llm')`). Routes `mock/*` models to the built-in mock
 * provider and everything else to LiteLLM's OpenAI-compatible API.
 */
export class LlmGateway {
  readonly mock = new MockProvider();
  private readonly openai: OpenAiCompatibleProvider;
  private readonly fetchImpl: typeof fetch;
  private modelsCache: { baseUrl: string; at: number; models: ModelInfo[] } | null = null;

  constructor(private readonly opts: LlmGatewayOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.openai = new OpenAiCompatibleProvider({
      connection: opts.connection,
      fetch: this.fetchImpl,
      ...(opts.pricing ? { pricing: opts.pricing } : {}),
      ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
    });
  }

  isMockModel(model: string): boolean {
    return model.startsWith(MOCK_PREFIX);
  }

  /** Normalized event stream for one model call. */
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent> {
    return this.isMockModel(req.model)
      ? this.mock.stream(req, signal)
      : this.openai.stream(req, signal);
  }

  /** Run one model call to completion, forwarding text/reasoning fragments as they arrive. */
  async complete(req: ChatRequest, opts: CompleteOptions): Promise<ChatResult> {
    const result: ChatResult = {
      text: '',
      reasoning: '',
      toolCalls: [] as ChatToolCall[],
      thinkingBlocks: [],
      usage: { ...EMPTY_USAGE },
      finishReason: null,
    };
    for await (const ev of this.stream(req, opts.signal)) {
      switch (ev.type) {
        case 'text':
          result.text += ev.text;
          opts.onText?.(ev.text);
          break;
        case 'reasoning':
          result.reasoning += ev.text;
          opts.onReasoning?.(ev.text);
          break;
        case 'tool_call':
          result.toolCalls.push(ev.toolCall);
          break;
        case 'thinking_blocks':
          result.thinkingBlocks.push(...ev.blocks);
          break;
        case 'usage':
          result.usage = ev.usage;
          break;
        case 'finish':
          result.finishReason = ev.reason;
          break;
      }
    }
    return result;
  }

  /**
   * LiteLLM `/models` (cached; failures are tolerated) + the settings default model + mock
   * models. Never throws.
   */
  async listModels(refresh = false): Promise<ModelList> {
    const { baseUrl, apiKey } = this.opts.connection();
    const mock = this.mock.list();
    const configured = this.opts.defaultModel?.() ?? null;
    const withConfigured = (models: ModelInfo[]) =>
      configured && !models.some((m) => m.id === configured) && !this.isMockModel(configured)
        ? [{ id: configured, label: null, provider: 'config' }, ...models]
        : models;

    if (!baseUrl) return { models: withConfigured(mock), source: 'mock' };

    const now = this.opts.now?.() ?? Date.now();
    const ttl = this.opts.modelsTtlMs ?? 5 * 60_000;
    const cache = this.modelsCache;
    if (!refresh && cache && cache.baseUrl === baseUrl && now - cache.at < ttl) {
      return { models: withConfigured([...cache.models, ...mock]), source: 'litellm' };
    }
    try {
      const res = await this.fetchImpl(joinUrl(baseUrl, 'models'), {
        headers: { accept: 'application/json', ...authHeaders(apiKey) },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: { id?: unknown }[] };
      const models: ModelInfo[] = (body.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .map((id) => ({ id, label: null, provider: 'litellm' }));
      this.modelsCache = { baseUrl, at: now, models };
      return { models: withConfigured([...models, ...mock]), source: 'litellm' };
    } catch (err) {
      this.opts.log.warn('failed to list LiteLLM models', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { models: withConfigured(mock), source: 'config' };
    }
  }
}
