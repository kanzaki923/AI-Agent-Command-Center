// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isSameOriginRequest } from './same-origin.js';

const req = (headers) => ({ headers: { host: '127.0.0.1:5173', ...headers } });

describe('isSameOriginRequest (/__acc/connection hands out the daemon token)', () => {
  it('allows the dev page itself and non-browser clients', () => {
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'none' }))).toBe(true);
    expect(isSameOriginRequest(req({}))).toBe(true);
    expect(isSameOriginRequest(req({ origin: 'http://127.0.0.1:5173' }))).toBe(true);
  });

  it('refuses pages on other local ports and other sites', () => {
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(isSameOriginRequest(req({ origin: 'http://localhost:3000' }))).toBe(false);
    expect(isSameOriginRequest(req({ origin: 'http://127.0.0.1:5174' }))).toBe(false);
    expect(isSameOriginRequest(req({ origin: 'https://evil.example' }))).toBe(false);
  });
});
