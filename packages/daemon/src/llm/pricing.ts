import type { Logger } from '../core/log';
import { type LiteLlmConnection, authHeaders, joinUrl } from './openai';
import type { ModelPricing, PricingLookup } from './types';

/**
 * Model prices for cost estimates (spec 20261029 §3.8-3): LiteLLM's `/model/info` when it
 * answers (cached for an hour), else the built-in Claude table, else the highest known price
 * (an unknown model is never estimated at zero). Only estimates: LiteLLM's reported cost and
 * the Claude CLI's final figure replace them.
 */

/** USD per million tokens. Cache prices default to 0.1x (read) / 1.25x (5-minute write). */
export interface ModelPrice extends ModelPricing {
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

export interface PriceQuote extends ModelPrice {
  /** Where the price came from; `fallback` = the highest known price (model unknown). */
  basis: 'litellm' | 'builtin' | 'fallback';
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** USD of the given tokens at a price. `inputTokens` excludes the cache reads and writes. */
export function costOf(price: ModelPrice, t: TokenCounts): number {
  return (
    (t.inputTokens * price.inputPerMTok +
      t.outputTokens * price.outputPerMTok +
      (t.cacheReadTokens ?? 0) * price.cacheReadPerMTok +
      (t.cacheWriteTokens ?? 0) * price.cacheWritePerMTok) /
    1_000_000
  );
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const p = (input: number, output: number, cacheRead = round(input * 0.1)): ModelPrice => ({
  inputPerMTok: input,
  outputPerMTok: output,
  cacheReadPerMTok: cacheRead,
  cacheWritePerMTok: round(input * 1.25),
});

/**
 * Anthropic first-party list prices (2026-10). Matched against the normalized model name
 * (provider prefixes and dates dropped, dots as dashes), most specific first, so gateway
 * names such as `anthropic/claude-sonnet-4-5-20250929` or `us.anthropic.claude-opus-4-1` hit.
 */
const BUILTIN: [RegExp, ModelPrice][] = [
  [/fable-5|mythos-5/, p(10, 50)],
  [/opus-5-5/, p(4, 20, 0.2)],
  [/opus-5/, p(5, 25)],
  [/opus-4-[5-9]/, p(5, 25)],
  [/opus-4|opus-3|3-opus/, p(15, 75)],
  [/sonnet-5/, p(2, 10)],
  [/sonnet-4|sonnet-3-7|3-7-sonnet|sonnet-3-5|3-5-sonnet/, p(3, 15)],
  [/haiku-5-5/, p(0.1, 0.5)],
  [/haiku-4/, p(1, 5)],
  [/haiku-3-5|3-5-haiku/, p(0.8, 4)],
  [/haiku-3|3-haiku/, p(0.25, 1.25)],
];

/** `anthropic/claude-Sonnet-4.5-20250929` → `claude-sonnet-4-5`. */
export function normalizeModelName(model: string): string {
  return model
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/^(?:[a-z]{2}\.)?anthropic\./, '')
    .replace(/[.@_:]/g, '-')
    .replace(/-(?:v\d+(?:-\d+)?|\d{8}|latest)$/g, '')
    .replace(/-\d{8}(?=-|$)/g, '');
}

export function builtinPrice(model: string): ModelPrice | null {
  const name = normalizeModelName(model);
  if (!/claude|opus|sonnet|haiku|fable|mythos/.test(name)) return null;
  return BUILTIN.find(([re]) => re.test(name))?.[1] ?? null;
}

/** The most expensive price known (built-in table and LiteLLM's answers). */
function highest(prices: Iterable<ModelPrice>): ModelPrice {
  let best: ModelPrice = BUILTIN[0]![1];
  for (const price of prices) if (price.outputPerMTok > best.outputPerMTok) best = price;
  return best;
}

export interface PriceBookOptions {
  connection: () => LiteLlmConnection;
  log?: Logger;
  fetch?: typeof fetch;
  now?: () => number;
  /** How long LiteLLM's answer is reused (default 1 h). */
  ttlMs?: number;
  /** How long to wait after a failed fetch before asking again (default 5 min). */
  retryMs?: number;
}

interface WireModelInfo {
  model_name?: unknown;
  litellm_params?: { model?: unknown };
  model_info?: {
    input_cost_per_token?: unknown;
    output_cost_per_token?: unknown;
    cache_read_input_token_cost?: unknown;
    cache_creation_input_token_cost?: unknown;
  };
}

const perM = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? round(v * 1_000_000) : null;

/**
 * Prices by model name. `quote()` never blocks: it answers from the cache and refreshes
 * LiteLLM's `/model/info` in the background when the cache is stale.
 */
export class PriceBook {
  private litellm = new Map<string, ModelPrice>();
  private fetchedFor: string | null = null;
  private fetchedAt = -Infinity;
  private failedAt = -Infinity;
  private inflight: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: PriceBookOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * The price of a model (unknown models: the highest known price, basis `fallback`).
   * `refresh: false` answers from what is cached without asking LiteLLM.
   */
  quote(model: string | null | undefined, opts: { refresh?: boolean } = {}): PriceQuote {
    if (opts.refresh !== false) this.maybeRefresh();
    const name = model ?? '';
    const fromLiteLlm = this.litellm.get(name) ?? this.litellm.get(normalizeModelName(name));
    if (fromLiteLlm) return { ...fromLiteLlm, basis: 'litellm' };
    const builtin = name ? builtinPrice(name) : null;
    if (builtin) return { ...builtin, basis: 'builtin' };
    return { ...highest(this.litellm.values()), basis: 'fallback' };
  }

  /**
   * For the LLM Gateway (tokens × price when LiteLLM reports no cost, which a real LiteLLM
   * always does): cached prices only, so a chat call never triggers a `/model/info` request.
   */
  readonly lookup: PricingLookup = (model) => this.quote(model, { refresh: false });

  /** Fetch `/model/info` now (tests, and the background refresh). Never throws. */
  async refresh(): Promise<void> {
    const { baseUrl, apiKey } = this.opts.connection();
    if (!baseUrl) return;
    try {
      const res = await this.fetchImpl(joinUrl(baseUrl, 'model/info'), {
        headers: { accept: 'application/json', ...authHeaders(apiKey) },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: WireModelInfo[] };
      const next = new Map<string, ModelPrice>();
      for (const m of body.data ?? []) {
        const input = perM(m.model_info?.input_cost_per_token);
        const output = perM(m.model_info?.output_cost_per_token);
        if (input === null || output === null) continue;
        const price: ModelPrice = {
          inputPerMTok: input,
          outputPerMTok: output,
          cacheReadPerMTok: perM(m.model_info?.cache_read_input_token_cost) ?? round(input * 0.1),
          cacheWritePerMTok:
            perM(m.model_info?.cache_creation_input_token_cost) ?? round(input * 1.25),
        };
        for (const key of [m.model_name, m.litellm_params?.model]) {
          if (typeof key === 'string' && key) {
            next.set(key, price);
            next.set(normalizeModelName(key), price);
          }
        }
      }
      this.litellm = next;
      this.fetchedFor = baseUrl;
      this.fetchedAt = this.now();
    } catch (err) {
      this.failedAt = this.now();
      this.opts.log?.debug('LiteLLM /model/info unavailable; using the built-in prices', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private maybeRefresh(): void {
    const { baseUrl } = this.opts.connection();
    if (!baseUrl || this.inflight) return;
    const now = this.now();
    const fresh =
      this.fetchedFor === baseUrl && now - this.fetchedAt < (this.opts.ttlMs ?? 60 * 60_000);
    if (fresh || now - this.failedAt < (this.opts.retryMs ?? 5 * 60_000)) return;
    if (this.fetchedFor !== baseUrl) this.litellm = new Map();
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
  }
}

declare module '../core/context' {
  interface Services {
    /** Model prices for estimates (llm module). */
    pricing: PriceBook;
  }
}
