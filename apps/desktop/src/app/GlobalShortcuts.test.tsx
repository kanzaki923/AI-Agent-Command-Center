import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeProvider, createRuntime } from '../daemon/runtime';
import { useUi } from '../store/ui';
import { createFakeClient } from '../test/fakeClient';
import { id, run, session } from '../test/fixtures';
import { qk } from '../daemon/keys';
import { GlobalShortcuts } from './GlobalShortcuts';

function mount(rt = createRuntime(createFakeClient({}).client)) {
  return render(
    <RuntimeProvider runtime={rt}>
      <GlobalShortcuts />
      <textarea data-testid="composer" />
    </RuntimeProvider>,
  );
}

beforeEach(() => {
  useUi.setState({ mode: 'home', focusSessionId: null, paletteOpen: false, back: [], forward: [], reviewIntegrationId: null });
});

describe('<GlobalShortcuts> back / forward', () => {
  it('leaves Alt+←/→ to a text field (word moves on macOS)', () => {
    const goBack = vi.fn();
    const goForward = vi.fn();
    const real = useUi.getState();
    useUi.setState({ goBack, goForward });
    try {
      const { container } = mount();
      const field = container.querySelector('textarea')!;
      field.focus();
      fireEvent.keyDown(field, { key: 'ArrowLeft', altKey: true });
      fireEvent.keyDown(field, { key: 'ArrowRight', altKey: true });
      expect(goBack).not.toHaveBeenCalled();
      expect(goForward).not.toHaveBeenCalled();
      fireEvent.keyDown(document.body, { key: 'ArrowLeft', altKey: true });
      expect(goBack).toHaveBeenCalledTimes(1);
    } finally {
      useUi.setState({ goBack: real.goBack, goForward: real.goForward });
    }
  });
});

describe('<GlobalShortcuts> screens', () => {
  it('Ctrl+1 home, Ctrl+2 timeline, Ctrl+N a draft that creates nothing yet', () => {
    const fake = createFakeClient({});
    mount(createRuntime(fake.client));
    fireEvent.keyDown(document.body, { key: '2', ctrlKey: true });
    expect(useUi.getState().mode).toBe('timeline');
    fireEvent.keyDown(document.body, { key: '1', ctrlKey: true });
    expect(useUi.getState().mode).toBe('home');
    fireEvent.keyDown(document.body, { key: 'n', ctrlKey: true });
    expect(useUi.getState()).toMatchObject({ mode: 'session', focusSessionId: null });
    expect(fake.calls.filter((c) => c.method === 'session.create')).toEqual([]);
  });

  it('Esc goes from a child conversation to its parent, then home', () => {
    const parent = session({ kind: 'chat' });
    const child = session({ parentSessionId: parent.id });
    const rt = createRuntime(createFakeClient({}).client);
    rt.queryClient.setQueryData(qk.sessions, [parent, child]);
    mount(rt);
    useUi.getState().openSession(child.id);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useUi.getState()).toMatchObject({ mode: 'session', focusSessionId: parent.id });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useUi.getState().mode).toBe('home');
  });
});

describe('<GlobalShortcuts> R in a conversation', () => {
  it('retries the open chat’s failed run, as its 再試行 R button says', async () => {
    const s = session({ kind: 'chat' });
    const failed = run(s, { kind: 'chat', status: 'failed' });
    const fake = createFakeClient({ 'run.retry': () => ({ runId: id('run') }) });
    const rt = createRuntime(fake.client);
    rt.queryClient.setQueryData(qk.runs, [failed]);
    useUi.setState({ mode: 'session', focusSessionId: s.id });
    mount(rt);
    fireEvent.keyDown(document.body, { key: 'r' });
    await vi.waitFor(() =>
      expect(fake.calls).toContainEqual({ method: 'run.retry', params: { runId: failed.id } }),
    );
  });
});
