import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qk } from '../daemon/keys';
import { notificationPermission, notify } from '../lib/notify';

// The Tauri bridge: outside the desktop app unless a test says otherwise.
const tauri = vi.hoisted(() => ({ inside: false, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => tauri.inside,
  invoke: (...args: unknown[]) => tauri.invoke(...args) as Promise<unknown>,
}));
import { attention, event, iso, session } from '../test/fixtures';
import { type AttentionView, createAttentionNotifier, isVisible } from './attention';

const NOW = Date.parse('2026-10-29T05:10:00.000Z');
const at = (ms = 0) => ({ ts: iso(NOW + ms) });

function setup(view: Partial<AttentionView> = {}, focused = false) {
  const qc = new QueryClient();
  const s = session({ title: '認証のテスト' });
  qc.setQueryData(qk.sessions, [s]);
  const os = vi.fn();
  const toast = vi.fn();
  const timers: { fn: () => void; ms: number }[] = [];
  const v: AttentionView = {
    mode: 'timeline',
    focusSessionId: null,
    reviewIntegrationId: null,
    notifyOs: true,
    notifyInApp: true,
    ...view,
  };
  let isFocused = focused;
  const n = createAttentionNotifier({
    qc,
    view: () => v,
    focused: () => isFocused,
    os,
    toast,
    open: vi.fn(),
    now: () => NOW,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
  });
  const flush = () => {
    const due = timers.splice(0);
    for (const t of due) t.fn();
  };
  return { n, s, os, toast, flush, v, focus: (f: boolean) => (isFocused = f) };
}

const opened = (a: ReturnType<typeof attention>, ms = 0) => event('attention.opened', { attention: a }, at(ms));

describe('attention notifications', () => {
  it('sends an OS notification for a new item while the window is in the background', () => {
    const { n, s, os, toast } = setup();
    n.handle(opened(attention(s, { kind: 'approval', title: 'pnpm add zod を実行' })));
    expect(os).toHaveBeenCalledWith(
      expect.objectContaining({ title: '確認を求めています', body: '認証のテスト — pnpm add zod を実行' }),
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it('coalesces a burst into one summary (never spams)', () => {
    const { n, s, os, flush } = setup();
    for (let i = 0; i < 4; i++) n.handle(opened(attention(s), i));
    expect(os).toHaveBeenCalledTimes(1);
    flush();
    expect(os).toHaveBeenCalledTimes(2);
    expect(os.mock.calls[1]![0]).toMatchObject({ title: '質問が 3 件あります' });
    // A quiet window after the summary: nothing more.
    flush();
    expect(os).toHaveBeenCalledTimes(2);
  });

  it('respects the settings toggles', () => {
    const { n, s, os } = setup({ notifyOs: false });
    n.handle(opened(attention(s, { kind: 'failure', title: 'テストが失敗' })));
    expect(os).not.toHaveBeenCalled();
  });

  it('in front: a toast only for what is not on screen', () => {
    const { n, s, toast, v } = setup({ mode: 'session' }, true);
    v.focusSessionId = s.id;
    n.handle(opened(attention(s, { kind: 'failure', title: 'テストが 3 件失敗' })));
    expect(toast).not.toHaveBeenCalled(); // looking at it
    v.focusSessionId = null;
    n.handle(opened(attention(s, { kind: 'failure', title: 'テストが 3 件失敗' })));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: '失敗しました', detail: '認証のテスト — テストが 3 件失敗', tone: 'error' }),
    );
  });

  it('ignores replayed (old) events and other events', () => {
    const { n, s, os } = setup();
    n.handle(event('attention.opened', { attention: attention(s) }, { ts: iso(NOW - 10 * 60_000) }));
    n.handle(event('attention.resolved', { attention: attention(s) }, at()));
    expect(os).not.toHaveBeenCalled();
  });

  it('knows what is on screen: every item at home, its own conversation', () => {
    const s = session();
    const item = attention(s);
    const v: AttentionView = { mode: 'home', focusSessionId: null, reviewIntegrationId: null, notifyOs: true, notifyInApp: true };
    expect(isVisible(item, v)).toBe(true);
    expect(isVisible(item, { ...v, mode: 'timeline' })).toBe(false);
    expect(isVisible(item, { ...v, mode: 'session', focusSessionId: s.id })).toBe(true);
    expect(isVisible(item, { ...v, mode: 'session', focusSessionId: 'ses_other' })).toBe(false);
  });
});

describe('notify()', () => {
  afterEach(() => {
    tauri.inside = false;
    tauri.invoke.mockReset();
    vi.unstubAllGlobals();
  });

  it('calls the Tauri notification plugin commands inside the desktop app', async () => {
    tauri.inside = true;
    tauri.invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'plugin:notification|is_permission_granted' ? true : null),
    );
    expect(await notify({ title: 'T', body: 'B', tag: 'x' })).toBe(true);
    expect(tauri.invoke.mock.calls).toEqual([
      ['plugin:notification|is_permission_granted'],
      ['plugin:notification|notify', { options: { title: 'T', body: 'B' } }],
    ]);
    expect(await notificationPermission()).toBe('granted');
  });

  it('sends nothing when the plugin says no, and reports a missing plugin as failure', async () => {
    tauri.inside = true;
    tauri.invoke.mockResolvedValueOnce(null);
    expect(await notify({ title: 'T' })).toBe(false);
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
    // e.g. the shell without the plugin: the command is rejected.
    tauri.invoke.mockRejectedValue(new Error('plugin notification not found'));
    expect(await notify({ title: 'T' })).toBe(false);
    expect(await notificationPermission()).toBe('unsupported');
  });

  it('falls back to the Web Notification API, and never prompts on its own', async () => {
    const created: unknown[] = [];
    const requestPermission = vi.fn();
    class FakeNotification {
      static permission = 'default';
      static requestPermission = requestPermission;
      onclick: (() => void) | null = null;
      constructor(title: string, opts: unknown) {
        created.push({ title, opts });
      }
      close() {}
    }
    vi.stubGlobal('Notification', FakeNotification);
    expect(await notify({ title: 'T' })).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
    FakeNotification.permission = 'granted';
    expect(await notify({ title: 'T', body: 'B', tag: 'acc-approval' })).toBe(true);
    expect(created).toEqual([{ title: 'T', opts: { body: 'B', tag: 'acc-approval' } }]);
  });
});
