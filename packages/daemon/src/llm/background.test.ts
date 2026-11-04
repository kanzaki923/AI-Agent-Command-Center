import { describe, expect, it } from 'vitest';
import { cheapestModel } from './background';

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
