import { AccClientError } from '@acc/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRuntime } from '../daemon/runtime';
import { useToasts } from '../store/toast';
import { useUi } from '../store/ui';
import { createFakeClient } from '../test/fakeClient';
import { card, session } from '../test/fixtures';
import { DEMO_CHILDREN, DEMO_TITLE, pickDemoModel, startDemo } from './demo';

beforeEach(() => {
  useUi.setState({ onboardingDone: false, mode: 'session', focusSessionId: null });
  useToasts.setState({ toasts: [] });
});

describe('startDemo', () => {
  it('without the daemon setup: creates the conversation on a mock model, delegates it and spawns three', async () => {
    const demo = session({ kind: 'chat', title: DEMO_TITLE });
    const fake = createFakeClient({
      'models.list': () => ({
        models: [
          { id: 'mock/echo', label: null, provider: null },
          { id: 'mock/orchestrator', label: null, provider: null },
        ],
        source: 'mock',
      }),
      'session.create': () => demo,
      'session.delegate': () => ({ grant: {}, budget: null }),
      'session.tree': () => ({ rootSessionId: demo.id, nodes: [card({ id: demo.id, role: 'supervisor' })] }),
      'session.spawn': () => ({ session: session(), runId: null, budgetId: null, waitingFor: [] }),
    });
    const rt = createRuntime(fake.client);
    expect(await startDemo(rt, new Set(['session.create']))).toBe(demo.id);
    const methods = fake.calls.map((c) => c.method);
    expect(methods).not.toContain('system.setupDemo');
    expect(fake.calls.find((c) => c.method === 'session.create')!.params).toMatchObject({
      kind: 'chat',
      title: DEMO_TITLE,
      model: 'mock/orchestrator',
    });
    expect(fake.calls.find((c) => c.method === 'session.delegate')!.params).toEqual({ sessionId: demo.id, projectId: null });
    const spawns = fake.calls.filter((c) => c.method === 'session.spawn').map((c) => c.params);
    expect(spawns.map((p) => p.title)).toEqual(['競合の価格を調べる', 'FAQ を書く', '告知文を書く']);
    expect(useUi.getState()).toMatchObject({ onboardingDone: true, mode: 'home' });
    rt.dispose();
  });

  it('reuses the daemon demo and adds no children when it already has some', async () => {
    const demo = session({ kind: 'chat', title: DEMO_TITLE });
    const fake = createFakeClient({
      'system.setupDemo': () => ({ project: { id: 'prj_d' }, session: demo, grant: {}, repoPath: 'x', created: false }),
      'session.tree': () => ({
        rootSessionId: demo.id,
        nodes: [card({ id: demo.id, role: 'supervisor' }), card({ parentId: demo.id, depth: 1 })],
      }),
    });
    const rt = createRuntime(fake.client);
    await startDemo(rt, null);
    expect(fake.calls.map((c) => c.method)[0]).toBe('system.setupDemo');
    expect(fake.calls.some((c) => c.method === 'session.spawn')).toBe(false);
    expect(fake.calls.some((c) => c.method === 'session.create')).toBe(false);
    rt.dispose();
  });

  it('stops with a toast when the daemon refuses the setup', async () => {
    const fake = createFakeClient({
      'system.setupDemo': () => {
        throw new AccClientError('internal', 'disk full');
      },
    });
    const rt = createRuntime(fake.client);
    expect(await startDemo(rt, null)).toBeNull();
    expect(useToasts.getState().toasts).toHaveLength(1);
    expect(useUi.getState().onboardingDone).toBe(false);
    rt.dispose();
  });
});

describe('demo children', () => {
  it('always run on the mock runtime with a script, so the demo costs nothing', () => {
    expect(DEMO_CHILDREN).toHaveLength(3);
    for (const c of DEMO_CHILDREN) {
      expect(c).toMatchObject({ mode: 'agent', runtime: 'mock', workspace: { kind: 'none' } });
      expect(c.goal).toContain('```acc-mock');
    }
    // One of them asks the human (so the demo shows 出番).
    expect(DEMO_CHILDREN.some((c) => c.goal.includes('"type": "ask"'))).toBe(true);
  });

  it('picks the mock supervisor model first', () => {
    expect(
      pickDemoModel([
        { id: 'mock/echo', label: null, provider: null },
        { id: 'mock/orchestrator', label: null, provider: null },
      ]),
    ).toBe('mock/orchestrator');
    expect(pickDemoModel([{ id: 'mock/x', label: null, provider: null }])).toBe('mock/x');
    expect(pickDemoModel([{ id: 'gpt-x', label: null, provider: null }])).toBeNull();
  });
});
