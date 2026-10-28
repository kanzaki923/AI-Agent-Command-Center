import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeProvider, createRuntime } from '../daemon/runtime';
import { useUi } from '../store/ui';
import { createFakeClient } from '../test/fakeClient';
import { id, run, session } from '../test/fixtures';
import { qk } from '../daemon/keys';
import { GlobalShortcuts } from './GlobalShortcuts';

describe('<GlobalShortcuts> back / forward', () => {
  it('leaves Alt+←/→ to a text field (word moves on macOS)', () => {
    const goBack = vi.fn();
    const goForward = vi.fn();
    useUi.setState({ goBack, goForward, paletteOpen: false });
    const rt = createRuntime(createFakeClient({}).client);
    const { container } = render(
      <RuntimeProvider runtime={rt}>
        <GlobalShortcuts />
        <textarea data-testid="composer" />
      </RuntimeProvider>,
    );
    const field = container.querySelector('textarea')!;
    field.focus();
    fireEvent.keyDown(field, { key: 'ArrowLeft', altKey: true });
    fireEvent.keyDown(field, { key: 'ArrowRight', altKey: true });
    expect(goBack).not.toHaveBeenCalled();
    expect(goForward).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'ArrowLeft', altKey: true });
    expect(goBack).toHaveBeenCalledTimes(1);
  });
});

describe('<GlobalShortcuts> R in Focus Mode', () => {
  it('retries the focused chat’s failed run, as its 再試行 R button says', async () => {
    const s = session({ kind: 'chat' });
    const failed = run(s, { kind: 'chat', status: 'failed' });
    const fake = createFakeClient({ 'run.retry': () => ({ runId: id('run') }) });
    const rt = createRuntime(fake.client);
    rt.queryClient.setQueryData(qk.runs, [failed]);
    useUi.setState({ mode: 'focus', focusSessionId: s.id, paletteOpen: false });
    render(
      <RuntimeProvider runtime={rt}>
        <GlobalShortcuts />
      </RuntimeProvider>,
    );
    fireEvent.keyDown(document.body, { key: 'r' });
    await vi.waitFor(() =>
      expect(fake.calls).toContainEqual({ method: 'run.retry', params: { runId: failed.id } }),
    );
  });
});
