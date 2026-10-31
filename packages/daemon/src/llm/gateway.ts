import { EMPTY_USAGE, type ModelInfo } from '@acc/protocol';
import type { Logger } from '../core/log';
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_PREFIX,
  type AnthropicConnection,
  AnthropicProvider,
} from './anthropic';
import {
  FAST_RULE_WHEN,
  type ModelRole,
  fallbackModel,
  initialRoster,
} from './autoModel';
import { MOCK_PREFIX, MockProvider } from './mock';
import { type LiteLlmConnection, OpenAiCompatibleProvider, authHeaders, joinUrl } from './openai';
import {
  OPENAI_DEFAULT_BASE_URL,
  OPENAI_PREFIX,
  type OpenAiConnection,
  OpenAiResponsesProvider,
} from './openaiResponses';
import type {
  ChatRequest,
  ChatResult,
  ChatToolCall,
  LlmProvider,
  LlmStreamEvent,
  ModelPricing,
  PricingLookup,
} from './types';

export interface LlmGatewayOptions {
  /** LiteLLM (models without a prefix). */
  connection: () => LiteLlmConnection;
  /** Anthropic (`anthropic/…`). */
  anthropic?: () => AnthropicConnection;
  /** OpenAI (`openai/…`), by key or by a ChatGPT plan token. */
  openai?: () => OpenAiConnection;
  chatgptToken?: () => Promise<string | null>;
  /** Settings default model; listed even when LiteLLM is unreachable. */
  defaultModel?: () => string | null;
  log: Logger;
  fetch?: typeof fetch;
  pricing?: PricingLookup;
  /** See OpenAiProviderOptions.deploymentOf. */
  deploymentOf?: (model: string) => string | null;
  /** See OpenAiProviderOptions.idleTimeoutMs. */
  idleTimeoutMs?: number;
  /** How long a successful model list is reused (default 5 min). */
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
  /**
   * litellm: LiteLLM answered; providers: no LiteLLM, but Anthropic / OpenAI models are
   * listed; config: LiteLLM configured but unreachable; mock: nothing configured.
   */
  source: 'litellm' | 'providers' | 'config' | 'mock';
}

/** Which provider a model name belongs to, by its prefix (none = LiteLLM). */
export type ProviderId = 'mock' | 'anthropic' | 'openai' | 'litellm';

export function providerOf(model: string): ProviderId {
  if (model.startsWith(MOCK_PREFIX)) return 'mock';
  if (model.startsWith(ANTHROPIC_PREFIX)) return 'anthropic';
  if (model.startsWith(OPENAI_PREFIX)) return 'openai';
  return 'litellm';
}

const NONE = { apiKey: null, baseUrl: null };

/**
 * The LLM Gateway (`ctx.service('llm')`). Routes a model by its prefix: `mock/*` to the
 * built-in mock, `anthropic/*` to the Messages API, `openai/*` to the Responses API, and
 * everything else to LiteLLM's OpenAI-compatible API. Several providers live side by side,
 * so a supervisor can give each child a different one.
 */
export class LlmGateway {
  readonly mock = new MockProvider();
  readonly anthropic: AnthropicProvider;
  readonly openai: OpenAiResponsesProvider;
  private readonly litellm: OpenAiCompatibleProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly modelsCache = new Map<string, { at: number; models: ModelInfo[] }>();

  constructor(private readonly opts: LlmGatewayOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    const shared = {
      fetch: this.fetchImpl,
      ...(opts.pricing ? { pricing: opts.pricing } : {}),
      ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
    };
    this.litellm = new OpenAiCompatibleProvider({
      connection: opts.connection,
      log: opts.log,
      ...(opts.deploymentOf ? { deploymentOf: opts.deploymentOf } : {}),
      ...shared,
    });
    this.anthropic = new AnthropicProvider({
      connection: opts.anthropic ?? (() => NONE),
      ...shared,
    });
    this.openai = new OpenAiResponsesProvider({
      connection: opts.openai ?? (() => NONE),
      ...(opts.chatgptToken ? { chatgptToken: opts.chatgptToken } : {}),
      ...shared,
    });
  }

  isMockModel(model: string): boolean {
    return model.startsWith(MOCK_PREFIX);
  }

  provider(model: string): LlmProvider {
    switch (providerOf(model)) {
      case 'mock':
        return this.mock;
      case 'anthropic':
        return this.anthropic;
      case 'openai':
        return this.openai;
      default:
        return this.litellm;
    }
  }

  /** Normalized event stream for one model call. */
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent> {
    return this.provider(req.model).stream(req, signal);
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
   * Every configured provider's models (each list cached; failures are tolerated), the
   * settings default model, and the mock models. Never throws.
   */
  async listModels(refresh = false): Promise<ModelList> {
    const { baseUrl, apiKey } = this.opts.connection();
    const mock = this.mock.list();
    const configured = this.opts.defaultModel?.() ?? null;
    const withConfigured = (models: ModelInfo[]) =>
      configured && !models.some((m) => m.id === configured) && !this.isMockModel(configured)
        ? [{ id: configured, label: null, provider: 'config' }, ...models]
        : models;

    const [litellm, anthropic, openai] = await Promise.all([
      baseUrl
        ? this.cached('litellm', baseUrl, refresh, () => this.fetchLiteLlm(baseUrl, apiKey))
        : Promise.resolve(null),
      this.fetchAnthropicList(refresh),
      this.fetchOpenAiList(refresh),
    ]);
    const models = withConfigured([
      ...(litellm ?? []),
      ...(anthropic ?? []),
      ...(openai ?? []),
      ...mock,
    ]).map((m) => ({ ...m, price: this.priceOf(m) }));
    const anySetUp =
      !!baseUrl || !!this.opts.anthropic?.().apiKey || (await this.openai.auth()) !== null;
    const source: ModelList['source'] = litellm
      ? 'litellm'
      : anthropic || openai
        ? 'providers'
        : anySetUp
          ? 'config'
          : 'mock';
    return { models, source };
  }

  /**
   * A first roster when nobody has made one (autoModel.ts `initialRoster`): picked from the
   * connected providers' lists; when no list could be fetched, a known model of a keyed
   * provider. Null when nothing is usable.
   */
  async suggestRoster(): Promise<{
    defaultModel: string;
    rules: { model: string; when: string }[];
  } | null> {
    const { models } = await this.listModels();
    const pricing = this.opts.pricing ? { pricing: this.opts.pricing } : {};
    const fallback = (role: ModelRole) =>
      fallbackModel(
        { anthropic: !!this.opts.anthropic?.().apiKey, openaiKey: !!this.opts.openai?.().apiKey },
        role,
      );
    const picked = initialRoster(models, pricing);
    if (picked) return picked;
    const base = fallback('chat');
    if (!base) return null;
    const fast = fallback('assistant');
    return {
      defaultModel: base,
      rules: fast && fast !== base ? [{ model: fast, when: FAST_RULE_WHEN }] : [],
    };
  }

  /** List price per 1M tokens of a listed model: 0 for a mock, null on a plan or unknown. */
  private priceOf(m: ModelInfo): ModelInfo['price'] {
    if (this.isMockModel(m.id)) return { inputPerMTok: 0, outputPerMTok: 0 };
    if (m.provider === 'chatgpt') return null;
    const price = this.opts.pricing?.(m.id) as (ModelPricing & { basis?: string }) | null;
    if (!price || price.basis === 'fallback') return null;
    return { inputPerMTok: price.inputPerMTok, outputPerMTok: price.outputPerMTok };
  }

  /** The cached list for a provider at an endpoint, or a fresh one; null when it failed. */
  private async cached(
    provider: string,
    key: string,
    refresh: boolean,
    load: () => Promise<ModelInfo[]>,
  ): Promise<ModelInfo[] | null> {
    const cacheKey = `${provider}:${key}`;
    const now = this.opts.now?.() ?? Date.now();
    const ttl = this.opts.modelsTtlMs ?? 5 * 60_000;
    const hit = this.modelsCache.get(cacheKey);
    if (!refresh && hit && now - hit.at < ttl) return hit.models;
    try {
      const models = await load();
      this.modelsCache.set(cacheKey, { at: now, models });
      return models;
    } catch (err) {
      this.opts.log.warn(`failed to list ${provider} models`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async fetchLiteLlm(baseUrl: string, apiKey: string | null): Promise<ModelInfo[]> {
    const res = await this.fetchImpl(joinUrl(baseUrl, 'models'), {
      headers: { accept: 'application/json', ...authHeaders(apiKey) },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .map((id) => ({ id, label: null, provider: 'litellm' }));
  }

  private fetchAnthropicList(refresh: boolean): Promise<ModelInfo[] | null> {
    const { apiKey, baseUrl } = this.opts.anthropic?.() ?? NONE;
    if (!apiKey) return Promise.resolve(null);
    const base = (baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/, '');
    return this.cached('anthropic', base, refresh, async () => {
      const res = await this.fetchImpl(`${base}/v1/models?limit=100`, {
        headers: {
          accept: 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: { id?: unknown; display_name?: unknown }[] };
      return (body.data ?? [])
        .filter((m): m is { id: string; display_name?: unknown } => typeof m.id === 'string')
        .map((m) => ({
          id: `${ANTHROPIC_PREFIX}${m.id}`,
          label: typeof m.display_name === 'string' ? m.display_name : null,
          provider: 'anthropic',
        }));
    });
  }

  private async fetchOpenAiList(refresh: boolean): Promise<ModelInfo[] | null> {
    const auth = await this.openai.auth();
    if (!auth) return null;
    const base = auth.baseUrl || OPENAI_DEFAULT_BASE_URL;
    const token = auth.kind === 'key' ? auth.apiKey : auth.token;
    return this.cached(`openai-${auth.kind}`, base, refresh, async () => {
      const res = await this.fetchImpl(`${base}/models`, {
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        data?: { id?: unknown }[];
        // The plan token's list: slugs with a display name and a visibility.
        models?: { slug?: unknown; display_name?: unknown; visibility?: unknown }[];
      };
      const provider = auth.kind === 'chatgpt' ? 'chatgpt' : 'openai';
      if (Array.isArray(body.models)) {
        return body.models
          .filter(
            (m): m is { slug: string; display_name?: unknown; visibility?: unknown } =>
              typeof m.slug === 'string' && (m.visibility === undefined || m.visibility === 'list'),
          )
          .map((m) => ({
            id: `${OPENAI_PREFIX}${m.slug}`,
            label: typeof m.display_name === 'string' ? m.display_name : null,
            provider,
          }));
      }
      return (body.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .map((id) => ({ id: `${OPENAI_PREFIX}${id}`, label: null, provider }));
    });
  }
}
