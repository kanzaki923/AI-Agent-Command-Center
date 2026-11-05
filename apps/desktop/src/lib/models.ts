import type { ModelInfo } from '@acc/protocol';

/** `anthropic/claude-sonnet-4-5` -> `sonnet`, `openai/gpt-6-luna` -> `gpt-6-luna` (compact label). */
export function shortModel(model: string | null | undefined): string {
  if (!model) return '';
  const last = model.split('/').pop() ?? model;
  const m = /(opus|sonnet|haiku|gpt-[\w.-]+|gemini[\w.-]*|o\d[\w-]*|mock[\w-]*)/i.exec(last);
  return (m?.[1] ?? last).toLowerCase();
}

/** Rough relative price from the model family (shown as $ / $$ / $$$ in the picker). */
export function relativeCost(id: string): string {
  const s = id.toLowerCase();
  if (/opus|gpt-5(?!-mini)|o1|o3(?!-mini)|ultra/.test(s)) return '$$$';
  if (/haiku|mini|flash|nano|mock|lite|small/.test(s)) return '$';
  return '$$';
}

/** What a list price is per (the tooltip of the price columns). */
export const PRICE_UNIT = '100 万トークンあたりの値段';

/**
 * `$0.10` / `$2.00` / `$10.00`: always two decimals, so right-aligned figures line up on
 * the point (three only below a cent, which list prices hardly are).
 */
export function priceUsd(n: number): string {
  return `$${n > 0 && n < 0.01 ? n.toFixed(3) : n.toFixed(2)}`;
}

/** Input and output price per 1M tokens, or null on a ChatGPT plan or when unknown. */
export function priceParts(
  info: Pick<ModelInfo, 'provider' | 'price'> | undefined,
): [string, string] | null {
  if (info?.provider === 'chatgpt' || !info?.price) return null;
  return [priceUsd(info.price.inputPerMTok), priceUsd(info.price.outputPerMTok)];
}

/** `$2.00 / $10.00` (per 1M tokens, input / output), `契約枠` on a ChatGPT plan, `—` unknown. */
export function priceText(info: Pick<ModelInfo, 'provider' | 'price'> | undefined): string {
  if (info?.provider === 'chatgpt') return '契約枠';
  const parts = priceParts(info);
  return parts ? `${parts[0]} / ${parts[1]}` : '—';
}

/**
 * Whether the agent runtime (Claude Code) can run `model`, as the daemon decides it
 * (`agentCanUse`): through LiteLLM any of its models, else a Claude model. The mocks run
 * anything. Other models it would quietly replace with its own default.
 */
export function agentCanRun(model: string, litellmBaseUrl: string | null | undefined): boolean {
  if (model.startsWith('mock/')) return true;
  if (litellmBaseUrl) return !/^(anthropic|openai)\//.test(model);
  return /claude|opus|sonnet|haiku/i.test(model);
}
