import type { ModelInfo } from '@acc/protocol';
import { ANTHROPIC_PREFIX } from './anthropic';
import { MOCK_PREFIX } from './mock';
import { OPENAI_PREFIX } from './openaiResponses';
import { normalizeModelName } from './pricing';
import type { ModelPricing } from './types';

/**
 * "おまかせ": the model a chat run uses when nobody named one. Nobody should have to learn
 * what a default model is, so the daemon picks from what the connected providers offer:
 *
 * - by the role: the assistant answers often and briefly (a fast model); a conversation and
 *   a supervisor think (a standard model);
 * - by the budget: a plan (ChatGPT) is already paid for and comes first; a standard model
 *   whose typical run would not fit in what is left of the budget gives way to a balanced
 *   one, then a fast one;
 * - newest version first, and coding-tuned variants (`codex`) only when nothing else fits.
 */
export type ModelRole = 'assistant' | 'chat' | 'supervisor';

export interface PickModelOptions {
  role: ModelRole;
  /** What is left of the run's budget (null = no budget). */
  freeUsd?: number | null;
  pricing?: (model: string) => ModelPricing | null;
}

/** Not chat models, or far too expensive to pick unasked. */
const NOT_FOR_CHAT =
  /embed|tts|whisper|transcri|audio|realtime|image|dall-e|moderation|search|computer-use|davinci|babbage|instruct|deep-research|^(?:gpt|o\d).*-pro(?:-|$)/;
/**
 * Tiers by name. OpenAI's GPT-5.6 / 6 names carry the tier (2026-10): Luna is the fast one
 * (Haiku's price), Terra the balanced one, Sol the standard (Sonnet's price), Astra the
 * flagship (not picked unasked, like Opus).
 */
const FAST = /haiku|mini|flash|luna/;

/** Whether a model is of the fast, light tier (Haiku, mini, Flash, Luna). */
export function isFastModel(model: string): boolean {
  return FAST.test(normalizeModelName(model));
}
const MIDDLE = /terra/;
const STANDARD = /sonnet|-sol(?:-|$)|^gpt-\d+(?:-\d+)*(?:-chat)?(?:-codex)?$|gemini-\d.*pro/;

/** Model calls of a typical run, for "does a standard model fit in the budget". */
const TYPICAL_RUN = { calls: 20, inputTokens: 8000, outputTokens: 800 };

/** USD of a typical run (TYPICAL_RUN) at a price. */
export function typicalRunUsd(price: ModelPricing): number {
  const { calls, inputTokens, outputTokens } = TYPICAL_RUN;
  return (calls * (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok)) / 1e6;
}

/** `gpt-5-1-codex-mini` → [5, 1]; `claude-3-5-sonnet` → [3, 5]. */
function version(name: string): number[] {
  return (name.match(/\d+/g) ?? []).map(Number).filter((n) => n < 1000);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? -1) - (a[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/** Plan models first, then non-codex, then the newest version. */
function rank(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((a, b) => {
    const plan = Number(b.provider === 'chatgpt') - Number(a.provider === 'chatgpt');
    if (plan) return plan;
    const na = normalizeModelName(a.id);
    const nb = normalizeModelName(b.id);
    const codex = Number(na.includes('codex')) - Number(nb.includes('codex'));
    if (codex) return codex;
    return compareVersions(version(na), version(nb));
  });
}

/** The model for a role from a provider's list (null when none of them is a chat model). */
export function pickModel(models: readonly ModelInfo[], opts: PickModelOptions): string | null {
  const usable = models.filter(
    (m) => !m.id.startsWith(MOCK_PREFIX) && !NOT_FOR_CHAT.test(normalizeModelName(m.id)),
  );
  if (usable.length === 0) return null;
  const tier = (re: RegExp) => rank(usable.filter((m) => re.test(normalizeModelName(m.id))));
  const fast = tier(FAST);
  const middle = tier(MIDDLE);
  const standard = tier(STANDARD).filter((m) => !FAST.test(normalizeModelName(m.id)));
  const fits = (m: ModelInfo) => {
    if (opts.freeUsd == null || m.provider === 'chatgpt') return true;
    const price = opts.pricing?.(m.id);
    return !price || typicalRunUsd(price) <= opts.freeUsd;
  };
  const order =
    opts.role === 'assistant'
      ? [...fast, ...middle, ...standard]
      : [...standard.filter(fits), ...middle.filter(fits), ...fast, ...middle, ...standard];
  return (order[0] ?? rank(usable)[0])!.id;
}

/** "When" of the row added for the fast model in a first roster. */
export const FAST_RULE_WHEN = '調べもの・要約・定型の作業';

/**
 * A first roster when nobody has made one: the standard model as the last row (conversations
 * start on it) and, when the provider has a separate fast model, a row for light work. It is
 * saved once and then only changed by the person.
 */
export function initialRoster(
  models: readonly ModelInfo[],
  opts: Omit<PickModelOptions, 'role'> = {},
): { defaultModel: string; rules: { model: string; when: string }[] } | null {
  const base = pickModel(models, { ...opts, role: 'chat' });
  if (!base) return null;
  const fast = pickModel(models, { ...opts, role: 'assistant' });
  return {
    defaultModel: base,
    rules: fast && fast !== base ? [{ model: fast, when: FAST_RULE_WHEN }] : [],
  };
}

/**
 * When a provider's list could not be fetched: a known model per keyed provider (LiteLLM's
 * names and a plan's are not known without the list).
 */
export function fallbackModel(
  providers: { anthropic: boolean; openaiKey: boolean },
  role: ModelRole,
): string | null {
  const fast = role === 'assistant';
  if (providers.anthropic) {
    return `${ANTHROPIC_PREFIX}${fast ? 'claude-haiku-5-5' : 'claude-sonnet-5-5'}`;
  }
  if (providers.openaiKey) return `${OPENAI_PREFIX}${fast ? 'gpt-5-mini' : 'gpt-5'}`;
  return null;
}
