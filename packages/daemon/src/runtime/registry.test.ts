import type { Settings } from '@acc/protocol';
import { describe, expect, it } from 'vitest';
import type { AgentRuntime } from '../contracts';
import { RuntimeRegistry } from './registry';

const runtime = (id: string): AgentRuntime => ({
  id,
  displayName: id,
  available: () => Promise.resolve({ ok: true }),
  run: () => (async function* () {})(),
});

function registry(
  defaultRuntime: string | null,
  detect?: () => { id: string } | { id: null; reason: string },
) {
  const r = new RuntimeRegistry(
    () => ({ defaultRuntime }) as Settings,
    detect ? { detect } : {},
  );
  r.register(runtime('mock'));
  r.register(runtime('claude-agent-sdk'));
  return r;
}

const found = () => ({ id: 'claude-agent-sdk' });
const missing = () => ({ id: null, reason: 'Claude Code が見つかりません' });

describe('RuntimeRegistry: 自動', () => {
  it('is the mock when nothing detects (tests and scripts never reach a real agent)', () => {
    const r = registry(null);
    expect(r.defaultId()).toBe('mock');
    expect(r.defaultId('claude-sonnet-5')).toBe('mock');
    expect(r.choice()).toMatchObject({ configured: null, effective: 'mock', detected: null });
  });

  it('runs agent conversations on Claude Code when the daemon finds it', () => {
    const r = registry(null, found);
    expect(r.defaultId()).toBe('claude-agent-sdk');
    expect(r.defaultId('openai/gpt-6.1-sol')).toBe('claude-agent-sdk');
    expect(r.choice()).toEqual({
      configured: null,
      effective: 'claude-agent-sdk',
      detected: 'claude-agent-sdk',
    });
  });

  it('keeps a mock model on the mock, so the demo stays offline', () => {
    expect(registry(null, found).defaultId('mock/orchestrator')).toBe('mock');
  });

  it('falls back to the mock with the reason when Claude Code is missing', () => {
    const r = registry(null, missing);
    expect(r.defaultId()).toBe('mock');
    expect(r.choice()).toEqual({
      configured: null,
      effective: 'mock',
      detected: null,
      reason: 'Claude Code が見つかりません',
    });
  });

  it('follows the settings over detection, and ignores an unknown runtime', () => {
    expect(registry('mock', found).defaultId()).toBe('mock');
    expect(registry('claude-agent-sdk', missing).defaultId('mock/echo')).toBe('claude-agent-sdk');
    expect(registry('nope', found).choice()).toMatchObject({
      configured: null,
      effective: 'claude-agent-sdk',
    });
  });
});
