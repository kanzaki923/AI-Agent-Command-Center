import { describe, expect, it } from 'vitest';
import { type Settings, Settings as SettingsSchema } from '@acc/protocol';
import { cheapestModel, gatewayCanCall } from './background';

describe('the cheapest model for background work', () => {
  const prices: Record<string, number> = { 'anthropic/claude-haiku-5-5': 0.1, 'anthropic/claude-sonnet-5-5': 2 };
  const price = (m: string) => prices[m] ?? null;

  it('takes a model on a plan before any priced one', () => {
    const roster = ['anthropic/claude-sonnet-5-5', 'openai/gpt-6-luna', 'anthropic/claude-haiku-5-5'];
    expect(cheapestModel(roster, (m) => m.startsWith('openai/'), price)).toBe('openai/gpt-6-luna');
  });

  it('among the plan, the light tier first (the quota lasts)', () => {
    const roster = ['openai/gpt-6.1-sol', 'openai/gpt-6-astra', 'openai/gpt-6-luna'];
    expect(cheapestModel(roster, () => true, price)).toBe('openai/gpt-6-luna');
  });

  it('without a plan, the lowest input price; unknown prices last', () => {
    const roster = ['openai/gpt-6-luna', 'anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5'];
    expect(cheapestModel(roster, () => false, price)).toBe('anthropic/claude-haiku-5-5');
    expect(cheapestModel(['x/unknown', 'anthropic/claude-sonnet-5-5'], () => false, price)).toBe('anthropic/claude-sonnet-5-5');
    expect(cheapestModel([], () => false, price)).toBeNull();
  });
});

describe('background work only picks a model it can call', () => {
  const base = SettingsSchema.parse({});
  const with_ = (over: Partial<Settings>): Settings => ({ ...base, ...over });

  it('needs a connection for the prefix: LiteLLM, an Anthropic key, an OpenAI key or ChatGPT', () => {
    expect(gatewayCanCall(base, 'claude-sonnet-5-5')).toBe(false);
    expect(gatewayCanCall(with_({ litellm: { ...base.litellm, baseUrl: 'http://127.0.0.1:4000' } }), 'claude-sonnet-5-5')).toBe(true);
    expect(gatewayCanCall(base, 'anthropic/claude-haiku-5-5')).toBe(false);
    const keyed = with_({ providers: { ...base.providers, anthropic: { apiKey: 'k', baseUrl: null } } });
    expect(gatewayCanCall(keyed, 'anthropic/claude-haiku-5-5')).toBe(true);
    expect(gatewayCanCall(base, 'openai/gpt-6-luna')).toBe(false);
    expect(gatewayCanCall(base, 'mock/talk')).toBe(false);
  });
});
