import type { ModelInfo } from '@acc/protocol';
import { describe, expect, it } from 'vitest';
import { FAST_RULE_WHEN, fallbackModel, initialRoster, pickModel } from './autoModel';
import { builtinPrice } from './pricing';

const list = (ids: string[], provider = 'litellm'): ModelInfo[] =>
  ids.map((id) => ({ id, label: null, provider }));

describe('pickModel (おまかせ)', () => {
  const anthropic = list(
    [
      'anthropic/claude-3-5-haiku-20241022',
      'anthropic/claude-opus-5-5',
      'anthropic/claude-sonnet-4-5',
      'anthropic/claude-sonnet-5-5',
      'anthropic/claude-haiku-5-5',
    ],
    'anthropic',
  );

  it('gives the assistant the newest fast model and a conversation the newest standard one', () => {
    expect(pickModel(anthropic, { role: 'assistant' })).toBe('anthropic/claude-haiku-5-5');
    expect(pickModel(anthropic, { role: 'chat' })).toBe('anthropic/claude-sonnet-5-5');
    expect(pickModel(anthropic, { role: 'supervisor' })).toBe('anthropic/claude-sonnet-5-5');
  });

  it('skips models that are not for chat, the mocks, and pro models', () => {
    const models = list([
      'mock/echo',
      'text-embedding-3-large',
      'gpt-4o-mini-tts',
      'whisper-1',
      'gpt-5-pro',
      'gpt-image-1',
      'gpt-5.1',
    ]);
    expect(pickModel(models, { role: 'chat' })).toBe('gpt-5.1');
    expect(pickModel(list(['mock/echo', 'text-embedding-3-large']), { role: 'chat' })).toBeNull();
  });

  it('prefers a plan (already paid for) over keyed providers', () => {
    const models = [...anthropic, ...list(['openai/gpt-5.1', 'openai/gpt-5.1-mini'], 'chatgpt')];
    expect(pickModel(models, { role: 'chat' })).toBe('openai/gpt-5.1');
    expect(pickModel(models, { role: 'assistant' })).toBe('openai/gpt-5.1-mini');
  });

  it('uses coding-tuned variants only when nothing else fits', () => {
    const plan = list(
      ['openai/gpt-5.1-codex', 'openai/gpt-5-codex-mini', 'openai/gpt-5'],
      'chatgpt',
    );
    expect(pickModel(plan, { role: 'chat' })).toBe('openai/gpt-5');
    expect(pickModel(plan, { role: 'assistant' })).toBe('openai/gpt-5-codex-mini');
    expect(pickModel(list(['openai/gpt-5.1-codex'], 'chatgpt'), { role: 'chat' })).toBe(
      'openai/gpt-5.1-codex',
    );
  });

  it('gives way to a fast model when a typical run of the standard one would not fit the budget', () => {
    const opts = { role: 'chat' as const, pricing: builtinPrice };
    // Sonnet 5.5: 20 calls × (8k in, 800 out) ≈ $0.48.
    expect(pickModel(anthropic, { ...opts, freeUsd: 5 })).toBe('anthropic/claude-sonnet-5-5');
    expect(pickModel(anthropic, { ...opts, freeUsd: 0.2 })).toBe('anthropic/claude-haiku-5-5');
    // A plan costs nothing per call, so the budget does not push it down.
    const plan = list(['openai/gpt-5.1', 'openai/gpt-5.1-mini'], 'chatgpt');
    expect(pickModel(plan, { ...opts, freeUsd: 0.01 })).toBe('openai/gpt-5.1');
  });

  it('reads the tier from the OpenAI Luna / Terra / Sol / Astra names (a real plan list)', () => {
    const plan = list(
      [
        'openai/gpt-6.1-sol',
        'openai/gpt-6-astra',
        'openai/gpt-6.1-terra',
        'openai/gpt-6-sol',
        'openai/gpt-6-luna',
        'openai/gpt-5.6-sol',
        'openai/gpt-5.6-terra',
        'openai/gpt-5.6-luna',
      ],
      'chatgpt',
    );
    expect(pickModel(plan, { role: 'assistant' })).toBe('openai/gpt-6-luna');
    expect(pickModel(plan, { role: 'chat' })).toBe('openai/gpt-6.1-sol');
    expect(pickModel(plan, { role: 'supervisor' })).toBe('openai/gpt-6.1-sol');
    // Keyed (billed per call): a tight budget gives way to the balanced tier, then the fast one.
    const keyed = plan.map((m) => ({ ...m, provider: 'openai' }));
    const pricing = (id: string) =>
      id.includes('sol')
        ? { inputPerMTok: 2, outputPerMTok: 10 }
        : id.includes('terra')
          ? { inputPerMTok: 1, outputPerMTok: 5 }
          : { inputPerMTok: 0.1, outputPerMTok: 0.5 };
    expect(pickModel(keyed, { role: 'chat', pricing, freeUsd: 0.3 })).toBe('openai/gpt-6.1-terra');
    expect(pickModel(keyed, { role: 'chat', pricing, freeUsd: 0.05 })).toBe('openai/gpt-6-luna');
  });

  it('falls back to any chat model when none looks fast or standard', () => {
    expect(pickModel(list(['llama-3-70b', 'qwen-2-72b']), { role: 'assistant' })).toBe(
      'llama-3-70b',
    );
  });
});

describe('fallbackModel', () => {
  it('names a known model of a keyed provider, and nothing for LiteLLM or a plan', () => {
    expect(fallbackModel({ anthropic: true, openaiKey: true }, 'assistant')).toBe(
      'anthropic/claude-haiku-5-5',
    );
    expect(fallbackModel({ anthropic: false, openaiKey: true }, 'chat')).toBe('openai/gpt-5');
    expect(fallbackModel({ anthropic: false, openaiKey: false }, 'chat')).toBeNull();
  });
});

describe('initialRoster', () => {
  it('makes the standard model the last row and adds a row for the fast one', () => {
    const plan = list(['openai/gpt-6.1-sol', 'openai/gpt-6-luna', 'openai/gpt-6-astra'], 'chatgpt');
    expect(initialRoster(plan)).toEqual({
      defaultModel: 'openai/gpt-6.1-sol',
      rules: [{ model: 'openai/gpt-6-luna', when: FAST_RULE_WHEN }],
    });
    expect(initialRoster(list(['llama-3-70b']))).toEqual({
      defaultModel: 'llama-3-70b',
      rules: [],
    });
    expect(initialRoster(list(['mock/echo']))).toBeNull();
  });
});
