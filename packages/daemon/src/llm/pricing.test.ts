import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAiStreamAccumulator } from './openai';
import { PriceBook, builtinPrice, costOf, normalizeModelName } from './pricing';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function modelInfoServer(body: unknown, status = 200) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

describe('model prices', () => {
  it('normalizes gateway and provider names to the built-in families', () => {
    expect(normalizeModelName('anthropic/claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(normalizeModelName('us.anthropic.claude-opus-4-1-20250805-v1:0')).toBe(
      'claude-opus-4-1',
    );
    expect(normalizeModelName('claude-3.5-haiku@20241022')).toBe('claude-3-5-haiku');
    expect(builtinPrice('claude-opus-5-5')).toMatchObject({
      inputPerMTok: 4,
      outputPerMTok: 20,
      cacheReadPerMTok: 0.2,
    });
    expect(builtinPrice('claude-opus-4-1')).toMatchObject({ inputPerMTok: 15, outputPerMTok: 75 });
    expect(builtinPrice('anthropic/claude-sonnet-4-5')).toMatchObject({
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    });
    expect(builtinPrice('claude-haiku-4-5')).toMatchObject({ inputPerMTok: 1, outputPerMTok: 5 });
    expect(builtinPrice('gpt-4.1')).toBeNull();
    expect(builtinPrice('team-sonnet')).toBeNull();
  });

  it('prices cache reads and writes apart from plain input', () => {
    const price = builtinPrice('claude-sonnet-4-5')!;
    expect(
      costOf(price, {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 10_000,
        cacheWriteTokens: 2000,
      }),
    ).toBeCloseTo((1000 * 3 + 100 * 15 + 10_000 * 0.3 + 2000 * 3.75) / 1e6, 12);
  });

  it('never prices an unknown model at zero: the highest known price, and LiteLLM is asked once an hour', async () => {
    const api = await modelInfoServer({
      data: [
        {
          model_name: 'team-sonnet',
          litellm_params: { model: 'anthropic/claude-sonnet-4-5' },
          model_info: {
            input_cost_per_token: 3e-6,
            output_cost_per_token: 15e-6,
            cache_read_input_token_cost: 3e-7,
          },
        },
        {
          model_name: 'premium',
          model_info: { input_cost_per_token: 3e-5, output_cost_per_token: 1.5e-4 },
        },
        { model_name: 'no-price', model_info: {} },
      ],
    });
    let now = 0;
    const book = new PriceBook({
      connection: () => ({ baseUrl: api.url, apiKey: 'sk-test' }),
      now: () => now,
    });
    // Before LiteLLM answered: the built-in table, and the highest built-in price for the rest.
    expect(book.quote('team-sonnet')).toMatchObject({ basis: 'fallback', outputPerMTok: 50 });
    await book.refresh();
    expect(book.quote('team-sonnet', { refresh: false })).toMatchObject({
      basis: 'litellm',
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: expect.closeTo(0.3, 9) as number,
      cacheWritePerMTok: 3.75,
    });
    expect(book.quote('claude-opus-4-1', { refresh: false })).toMatchObject({
      basis: 'builtin',
      outputPerMTok: 75,
    });
    // Unknown: the most expensive price anyone told us (LiteLLM's "premium" here).
    expect(book.quote('mystery', { refresh: false })).toMatchObject({
      basis: 'fallback',
      outputPerMTok: 150,
    });
    expect(api.hits).toEqual(['GET /model/info Bearer sk-test', 'GET /model/info Bearer sk-test']);
    // Cached for an hour.
    now += 30 * 60_000;
    book.quote('x');
    expect(api.hits).toHaveLength(2);
    now += 31 * 60_000;
    book.quote('x');
    await new Promise((r) => setTimeout(r, 50));
    expect(api.hits).toHaveLength(3);
  });

  it('falls back to the built-in table when /model/info fails', async () => {
    const api = await modelInfoServer({ error: 'nope' }, 500);
    const book = new PriceBook({ connection: () => ({ baseUrl: api.url, apiKey: null }) });
    await book.refresh();
    expect(book.quote('claude-haiku-4-5', { refresh: false })).toMatchObject({
      basis: 'builtin',
      inputPerMTok: 1,
    });
  });

  it('the gateway estimates a call LiteLLM did not price, even for an unknown model', () => {
    const book = new PriceBook({ connection: () => ({ baseUrl: null, apiKey: null }) });
    const acc = new OpenAiStreamAccumulator('mystery-model', null, book.lookup);
    acc.handle(
      JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100 } }),
    );
    const usage = acc.finish().find((e) => e.type === 'usage');
    expect(usage).toMatchObject({
      usage: { costSource: 'estimated', costUsd: (1000 * 10 + 100 * 50) / 1e6 },
    });
  });
});
