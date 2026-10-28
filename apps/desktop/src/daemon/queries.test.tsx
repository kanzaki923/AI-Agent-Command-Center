import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createFakeClient } from '../test/fakeClient';
import { event, id, run, session } from '../test/fixtures';
import { useSessionEventVersion, useSessionRuns, useStreaming } from './queries';
import { qk } from './keys';
import { RuntimeProvider, createRuntime } from './runtime';

function setup() {
  const fake = createFakeClient({});
  const rt = createRuntime(fake.client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RuntimeProvider runtime={rt}>{children}</RuntimeProvider>
  );
  return { rt, wrapper };
}

describe('per-session subscriptions (a quiet chat stays still while others stream)', () => {
  it('useStreaming re-renders only for its own session’s deltas', () => {
    const { rt, wrapper } = setup();
    const mine = id('ses');
    const other = id('ses');
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders++;
        return useStreaming(mine);
      },
      { wrapper },
    );
    const before = renders;
    const delta = (sessionId: string, index: number) => ({
      runId: id('run'),
      sessionId,
      messageId: `m-${sessionId}`,
      kind: 'text' as const,
      text: 'x',
      index,
    });
    act(() => {
      for (let i = 0; i < 5; i++) {
        rt.streams.deltas.push(delta(other, i));
        rt.streams.deltas.flush();
      }
    });
    expect(renders).toBe(before);
    expect(result.current).toEqual([]);
    act(() => {
      rt.streams.deltas.push(delta(mine, 0));
      rt.streams.deltas.flush();
    });
    expect(renders).toBe(before + 1);
    expect(result.current.map((m) => m.text)).toEqual(['x']);
  });

  it('useSessionRuns keeps its identity when another session’s run changes', () => {
    const { rt, wrapper } = setup();
    const a = session();
    const b = session();
    const ra = run(a, { status: 'running' });
    const rb = run(b, { status: 'running' });
    rt.queryClient.setQueryData(qk.runs, [ra, rb]);
    const { result } = renderHook(() => useSessionRuns(a.id), { wrapper });
    const first = result.current;
    expect(first.map((r) => r.id)).toEqual([ra.id]);
    act(() => {
      rt.queryClient.setQueryData(qk.runs, [ra, { ...rb, activity: 'テストを実行中' }]);
    });
    expect(result.current).toBe(first);
  });

  it('useSessionEventVersion ignores events of other sessions (the ログ tab)', () => {
    const { rt, wrapper } = setup();
    const mine = session();
    const other = session();
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders++;
        return useSessionEventVersion(mine.id);
      },
      { wrapper },
    );
    const before = renders;
    const progress = (sessionId: string) =>
      event(
        'session.updated',
        { session: { ...other, id: sessionId }, changes: ['title'] },
        { sessionId },
      );
    act(() => {
      for (let i = 0; i < 10; i++) rt.streams.events.add(progress(other.id));
    });
    expect(renders).toBe(before);
    act(() => rt.streams.events.add(progress(mine.id)));
    expect(renders).toBe(before + 1);
    expect(result.current).toBe(1);
  });
});
