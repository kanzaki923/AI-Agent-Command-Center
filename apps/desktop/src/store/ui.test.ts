import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUi } from './ui';

describe('editing a sent message (編集して送り直す)', () => {
  beforeEach(() => useUi.setState({ editing: null, drafts: {} }));

  it('keeps the draft that was being written and gives it back when the edit ends', () => {
    const ui = useUi.getState();
    ui.setDraft('s1', '書きかけの長い下書き');
    ui.setEditing({ sessionId: 's1', messageId: 'm1', text: '直前のメッセージ' });
    expect(useUi.getState().drafts.s1).toBe('直前のメッセージ');
    // Picking another message keeps the original draft aside, not the first edit's text.
    useUi.getState().setEditing({ sessionId: 's1', messageId: 'm2', text: '別のメッセージ' });
    useUi.getState().setEditing(null);
    expect(useUi.getState().drafts.s1).toBe('書きかけの長い下書き');
    expect(useUi.getState().editing).toBeNull();
  });

  it('leaves the composer empty when there was no draft', () => {
    useUi.getState().setEditing({ sessionId: 's1', messageId: 'm1', text: 'x' });
    useUi.getState().setEditing(null);
    expect(useUi.getState().drafts.s1).toBeUndefined();
  });
});

describe('jumping to a message', () => {
  it('drops the request as soon as the chat lands on it; the flash ends by itself', () => {
    vi.useFakeTimers();
    try {
      useUi.setState({ jumpTo: { sessionId: 's1', messageId: 'm1', nonce: 1 }, flash: null });
      useUi.getState().landJump();
      // Leaving right away and reopening the chat later must not jump (and stop following) again.
      expect(useUi.getState().jumpTo).toBeNull();
      expect(useUi.getState().flash).toMatchObject({ messageId: 'm1' });
      vi.advanceTimersByTime(2000);
      expect(useUi.getState().flash).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
