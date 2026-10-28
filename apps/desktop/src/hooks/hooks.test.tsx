import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOLD_AFTER_KEYBOARD_MS, HOLD_MAX_MS, useDeferredReorder } from './useDeferredReorder';
import { tickerSubscriberCount, useNow } from './useNow';
import { distanceFromBottom } from './useStickToBottom';

interface Item {
  id: string;
  group: string;
}

function List({ items }: { items: Item[] }) {
  const d = useDeferredReorder(
    items,
    (i) => i.id,
    (i) => i.group,
  );
  return (
    <div data-testid="list" {...d.bind}>
      <span data-testid="pending">{d.pending}</span>
      {['a', 'b'].map((g) => (
        <section key={g} data-testid={`group-${g}`}>
          {d.items
            .filter((i) => d.groupOf(i) === g)
            .map((i) => (
              <span key={i.id}>{i.id}</span>
            ))}
        </section>
      ))}
      <button type="button" onClick={d.noteKeyboard}>
        kbd
      </button>
    </div>
  );
}

describe('useDeferredReorder (§3.2)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const v1: Item[] = [
    { id: 'x', group: 'a' },
    { id: 'y', group: 'b' },
  ];
  const v2: Item[] = [
    { id: 'x', group: 'b' },
    { id: 'y', group: 'b' },
  ];

  it('holds group changes while the pointer is over the list and shows the pending count', () => {
    const { rerender } = render(<List items={v1} />);
    fireEvent.pointerEnter(screen.getByTestId('list'));
    rerender(<List items={v2} />);
    expect(screen.getByTestId('group-a')).toHaveTextContent('x');
    expect(screen.getByTestId('pending')).toHaveTextContent('1');
    fireEvent.pointerLeave(screen.getByTestId('list'));
    expect(screen.getByTestId('group-a')).toHaveTextContent('');
    expect(screen.getByTestId('group-b')).toHaveTextContent('xy');
  });

  it('holds for 2s after a keyboard move, and never longer than 4s', () => {
    vi.useFakeTimers();
    const { rerender } = render(<List items={v1} />);
    fireEvent.click(screen.getByText('kbd'));
    rerender(<List items={v2} />);
    expect(screen.getByTestId('group-a')).toHaveTextContent('x');
    act(() => {
      vi.advanceTimersByTime(HOLD_AFTER_KEYBOARD_MS + 10);
    });
    expect(screen.getByTestId('group-a')).toHaveTextContent('');

    rerender(<List items={v1} />);
    fireEvent.pointerEnter(screen.getByTestId('list'));
    rerender(<List items={v2} />);
    act(() => {
      vi.advanceTimersByTime(HOLD_MAX_MS + 10);
    });
    expect(screen.getByTestId('group-b')).toHaveTextContent('xy');
  });
});

describe('useNow', () => {
  it('shares one ticker across subscribers and stops when unused', () => {
    vi.useFakeTimers();
    const a = renderHook(() => useNow());
    const b = renderHook(() => useNow());
    expect(tickerSubscriberCount()).toBe(2);
    const before = a.result.current;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(a.result.current).toBeGreaterThanOrEqual(before);
    a.unmount();
    b.unmount();
    expect(tickerSubscriberCount()).toBe(0);
    vi.useRealTimers();
  });
});

it('measures distance from the bottom', () => {
  expect(distanceFromBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 360 })).toBe(40);
});
