import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUiStore, isUnread, migrateUi, normalizeMode, useUi } from './ui';

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

describe('screens and navigation', () => {
  beforeEach(() =>
    useUi.setState({ mode: 'home', focusSessionId: null, back: [], forward: [], selectedId: null, reviewIntegrationId: null }),
  );

  it('opens a conversation, goes home, back and forward', () => {
    const ui = useUi.getState();
    ui.openSession('s1');
    expect(useUi.getState()).toMatchObject({ mode: 'session', focusSessionId: 's1' });
    useUi.getState().goHome();
    // Coming back home selects the conversation that was open.
    expect(useUi.getState()).toMatchObject({ mode: 'home', selectedId: 's1' });
    useUi.getState().goBack();
    expect(useUi.getState()).toMatchObject({ mode: 'session', focusSessionId: 's1' });
    useUi.getState().goForward();
    expect(useUi.getState().mode).toBe('home');
  });

  it('opens a draft (no session yet) and comes back to it', () => {
    useUi.getState().openSession('s1');
    useUi.getState().openDraft();
    expect(useUi.getState()).toMatchObject({ mode: 'session', focusSessionId: null });
    useUi.getState().goBack();
    expect(useUi.getState()).toMatchObject({ mode: 'session', focusSessionId: 's1' });
    useUi.getState().goForward();
    expect(useUi.getState()).toMatchObject({ mode: 'session', focusSessionId: null });
  });

  it('records the same conversation only once', () => {
    useUi.getState().openSession('s1');
    useUi.getState().openSession('s1');
    expect(useUi.getState().back).toHaveLength(1);
  });
});

describe('persisted state of the old layout', () => {
  it('reads 司令室 / フォーカス as home / session and the Focus panel flag as the outputs panel', () => {
    expect(normalizeMode('command')).toBe('home');
    expect(normalizeMode('focus')).toBe('session');
    expect(normalizeMode('timeline')).toBe('timeline');
    expect(normalizeMode(undefined)).toBe('home');
    const v1 = {
      theme: 'light',
      mode: 'command',
      panelOpen: { command: true, focus: false, timeline: true },
      panelTab: 'changes',
      commandView: 'tasks',
      taskGoal: 'human',
      back: [{ mode: 'focus', sessionId: 's1' }],
    };
    expect(migrateUi(v1, 1)).toEqual({
      theme: 'light',
      mode: 'home',
      panelOpen: false,
      back: [{ mode: 'session', sessionId: 's1' }],
    });
    expect(migrateUi({ panelOpen: { focus: true } }, 1)).toEqual({ panelOpen: true });
    expect(migrateUi(null, 0)).toEqual({ panelOpen: true });
  });
});

describe('unread conversations', () => {
  const base = { viewedAt: {}, readBaseline: '2026-10-30T09:00:00.000Z', mode: 'home' as const, focusSessionId: null };
  const conv = (state: string, stateSince: string) => ({ id: 'ses_a', state, stateSince });

  it('is unread once its answer settles after you last looked, never while open', () => {
    expect(isUnread(base, conv('idle', '2026-10-30T09:05:00.000Z'))).toBe(true);
    expect(isUnread(base, conv('done', '2026-10-30T09:05:00.000Z'))).toBe(true);
    expect(isUnread(base, conv('working', '2026-10-30T09:05:00.000Z'))).toBe(false);
    expect(isUnread({ ...base, viewedAt: { ses_a: '2026-10-30T09:06:00.000Z' } }, conv('idle', '2026-10-30T09:05:00.000Z'))).toBe(false);
    expect(isUnread({ ...base, mode: 'session', focusSessionId: 'ses_a' }, conv('idle', '2026-10-30T09:05:00.000Z'))).toBe(false);
  });

  it('leaves answers from before this store existed alone, and reading clears it', () => {
    expect(isUnread(base, conv('idle', '2026-10-30T08:00:00.000Z'))).toBe(false);
    const store = createUiStore();
    const settled = new Date(Date.now() - 1000).toISOString();
    store.setState({ readBaseline: new Date(Date.now() - 60_000).toISOString() });
    const c = conv('idle', settled);
    expect(isUnread(store.getState(), c)).toBe(true);
    store.getState().openSession('ses_a');
    store.getState().goHome();
    expect(isUnread(store.getState(), c)).toBe(false);
  });
});
