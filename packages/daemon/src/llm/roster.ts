import type { Actor, ModelRule, Settings } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { invalidParams } from '../core/errors';
import { providerOf } from './gateway';
import type { ModelPricing } from './types';

/**
 * The model roster (snapshot 20261030_model-roster-spec.md): `settings.modelRules` read top
 * to bottom, the first row whose `when` fits a piece of work gives its model, and
 * `settings.defaultModel` is the last row ("それ以外"). The assistant and supervisors choose
 * from it; the daemon refuses any other model an agent names.
 */

/** Every model of the roster, the last row included (no duplicates). */
export function rosterModels(s: Settings): string[] {
  const all = [...s.modelRules.map((r) => r.model), ...(s.defaultModel ? [s.defaultModel] : [])];
  return [...new Set(all)];
}

/**
 * Whether an agent (the Claude Code runtime) can run on a model: behind LiteLLM any LiteLLM
 * name, otherwise only Claude models (runtime/env.ts drops the rest for the CLI's own).
 */
export function agentCanUse(s: Settings, model: string): boolean {
  if (s.litellm.baseUrl) return providerOf(model) === 'litellm';
  return /claude|opus|sonnet|haiku/i.test(model);
}

/**
 * Refuse a model an agent names outside the roster (humans may use any model). The mocks are
 * always allowed (offline, free); an empty roster restricts nothing. `agentRuntime`: the model
 * is for a Claude Code agent, which some models cannot drive.
 */
export function assertRosterModel(
  ctx: DaemonContext,
  actor: Actor,
  model: string,
  opts: { agentRuntime?: boolean } = {},
): void {
  if (actor.kind !== 'agent' || providerOf(model) === 'mock') return;
  const s = ctx.settings.get();
  const allowed = rosterModels(s);
  if (allowed.length === 0) return;
  if (!allowed.includes(model)) {
    throw invalidParams(
      `モデル「${model}」は使うモデルの名簿にありません。名簿: ${allowed.join(', ')}（指定しなければ「それ以外」の ${s.defaultModel ?? '既定'}）`,
    );
  }
  if (opts.agentRuntime) assertAgentModel(ctx, model, 'agent');
}

/**
 * Refuse a model the agent runtime cannot drive, for anyone (people too): Claude Code would
 * quietly run another model, and the conversation would name one that never answered.
 * `runtime`: the agent session's runtime id (the mock runs anything).
 */
export function assertAgentModel(ctx: DaemonContext, model: string, runtime: string): void {
  if (runtime === 'mock' || providerOf(model) === 'mock') return;
  const s = ctx.settings.get();
  if (agentCanUse(s, model)) return;
  throw invalidParams(
    `モデル「${model}」ではエージェント（Claude Code）を動かせません。${
      s.litellm.baseUrl ? 'LiteLLM のモデル' : 'Claude のモデル'
    }を選ぶか、指定しないでください（Claude Code の既定で動きます）`,
  );
}

/**
 * The model a new agent session inherits (a member's, the project's, the settings'), or null
 * when its runtime cannot drive it: then Claude Code runs its own default, and the session
 * names the model only once one answers.
 */
export function agentDefaultModel(
  ctx: DaemonContext,
  model: string | null,
  runtime: string,
): string | null {
  if (!model || runtime === 'mock' || providerOf(model) === 'mock') return model;
  return agentCanUse(ctx.settings.get(), model) ? model : null;
}

/** List price per 1M tokens, `plan` on a ChatGPT plan (or offline), null when unknown. */
export function priceOf(
  s: Settings,
  model: string,
  pricing: ((model: string) => (ModelPricing & { basis?: string }) | null) | null,
): ModelPricing | 'plan' | null {
  const provider = providerOf(model);
  if (provider === 'mock') return 'plan';
  if (provider === 'openai' && s.providers.openai.chatgpt) return 'plan';
  const price = pricing?.(model) ?? null;
  if (!price || price.basis === 'fallback') return null;
  return { inputPerMTok: price.inputPerMTok, outputPerMTok: price.outputPerMTok };
}

const usd = (n: number) => `$${Number(n.toFixed(3))}`;

function costLabel(price: ModelPricing | 'plan' | null): string {
  if (price === null) return 'price unknown';
  if (price === 'plan') return 'no cost per call (plan or offline)';
  return `${usd(price.inputPerMTok)} in / ${usd(price.outputPerMTok)} out per 1M tokens`;
}

/**
 * The roster for a system prompt (the assistant's and a supervisor's): numbered rows with
 * their "when", the list price per 1M tokens and whether an agent can use the model. Changes
 * only when the settings do, so it stays inside the cacheable prefix.
 */
export function rosterPromptBlock(
  s: Settings,
  pricing: ((model: string) => (ModelPricing & { basis?: string }) | null) | null,
): string | null {
  const rules: ModelRule[] = s.modelRules;
  if (rules.length === 0 && !s.defaultModel) return null;
  const row = (model: string) =>
    `${costLabel(priceOf(s, model, pricing))}; agent: ${agentCanUse(s, model) ? 'yes' : 'no'}`;
  const lines = [
    'Models (the person set this list; only these may be used)',
    '- For each piece of work you start, go down the list and take the model of the first row whose "when" fits; pass it as `model`. When no row fits, pass no model: the last row is used.',
    '- A piece reads far more tokens than it writes. When its budget is small, skip a row whose price would not fit and take the next one that does.',
    '- A piece done by an agent (mode agent, or a workspace) needs a model with "agent: yes".',
  ];
  rules.forEach((r, i) => {
    lines.push(
      `${i + 1}. ${r.model} — when: ${r.when || '(no condition written)'} — ${row(r.model)}`,
    );
  });
  if (s.defaultModel) lines.push(`- Otherwise: ${s.defaultModel} — ${row(s.defaultModel)}`);
  return lines.join('\n');
}
