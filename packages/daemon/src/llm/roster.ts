import type { Actor, ModelRule, Settings } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { invalidParams } from '../core/errors';
import { typicalRunUsd } from './autoModel';
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
  if (opts.agentRuntime && !agentCanUse(s, model)) {
    throw invalidParams(
      `モデル「${model}」ではエージェント（Claude Code）を動かせません。${
        s.litellm.baseUrl ? 'LiteLLM のモデル' : 'Claude のモデル'
      }を名簿から選ぶか、指定しないでください`,
    );
  }
}

/** USD of a typical run, 0 on a ChatGPT plan, null when the price is unknown. */
export function runUsdOf(
  s: Settings,
  model: string,
  pricing: ((model: string) => (ModelPricing & { basis?: string }) | null) | null,
): number | null {
  const provider = providerOf(model);
  if (provider === 'mock') return 0;
  if (provider === 'openai' && s.providers.openai.chatgpt) return 0;
  const price = pricing?.(model) ?? null;
  if (!price || price.basis === 'fallback') return null;
  return typicalRunUsd(price);
}

function costLabel(usd: number | null): string {
  if (usd === null) return 'cost unknown';
  if (usd === 0) return 'no cost per call (plan or offline)';
  return `about $${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)} per typical run`;
}

/**
 * The roster for a system prompt (the assistant's and a supervisor's): numbered rows with
 * their "when", the cost of a typical run and whether an agent can use the model. Changes
 * only when the settings do, so it stays inside the cacheable prefix.
 */
export function rosterPromptBlock(
  s: Settings,
  pricing: ((model: string) => (ModelPricing & { basis?: string }) | null) | null,
): string | null {
  const rules: ModelRule[] = s.modelRules;
  if (rules.length === 0 && !s.defaultModel) return null;
  const row = (model: string) =>
    `${costLabel(runUsdOf(s, model, pricing))}; agent: ${agentCanUse(s, model) ? 'yes' : 'no'}`;
  const lines = [
    'Models (the person set this list; only these may be used)',
    '- For each piece of work you start, go down the list and take the model of the first row whose "when" fits; pass it as `model`. When no row fits, pass no model: the last row is used.',
    '- Skip a row whose typical run would not fit in the budget the piece gets; take the next one that fits.',
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
