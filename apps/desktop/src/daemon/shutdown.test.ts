import { AccClientError } from '@acc/client';
import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ConfirmRequest, useConfirm } from '../store/confirm';
import { useToasts } from '../store/toast';
import { createFakeClient } from '../test/fakeClient';
import { createRuntime } from './runtime';
import { confirmShutdown, shutdownCopy } from './shutdown';

const shell = vi.hoisted(() => ({ tauri: false }));
vi.mock('../lib/platform', () => ({ isTauri: () => shell.tauri, isMac: false }));

const info = (activeRuns: number) => ({ methods: [], stats: { activeRuns, lastEventSeq: 0 } });

/** Press the dialog's confirm button and let the call it starts settle. */
async function confirm(req: ConfirmRequest): Promise<void> {
  await act(async () => {
    req.onConfirm();
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  shell.tauri = false;
  useConfirm.setState({ request: null });
  useToasts.setState({ toasts: [] });
});

describe('shutdownCopy', () => {
  it('calls it a restart in the desktop app (the shell starts a new daemon at once)', () => {
    const c = shutdownCopy({ restart: true, activeRuns: 0, autoResume: true });
    expect(c.title).toBe('Core Daemon を再起動しますか？');
    expect(c.body).toContain('このアプリがすぐに新しい Core Daemon を起動します');
    expect(c.confirmLabel).toBe('再起動する');
  });

  it('names the runs that will be interrupted and what happens to orchestrators', () => {
    const on = shutdownCopy({ restart: false, activeRuns: 3, autoResume: true });
    expect(on.title).toBe('Core Daemon を停止しますか？');
    expect(on.body).toContain('実行中の Run 3 件は「中断」になります');
    expect(on.body).toContain('再起動後に自動で再開します');
    expect(on.confirmLabel).toBe('3 件を中断して停止');
    expect(shutdownCopy({ restart: false, activeRuns: 1, autoResume: false }).body).toContain(
      '自動では再開しません',
    );
  });
});

describe('confirmShutdown (system.shutdown)', () => {
  it('stops without force when nothing runs', async () => {
    const fake = createFakeClient({
      'system.info': () => info(0),
      'system.shutdown': () => ({ ok: true, pid: 42, activeRuns: 0 }),
    });
    await confirmShutdown(createRuntime(fake.client));
    const req = useConfirm.getState().request!;
    expect(req.confirmLabel).toBe('停止する');
    await confirm(req);
    expect(fake.calls.filter((c) => c.method === 'system.shutdown').map((c) => c.params)).toEqual([
      { force: false },
    ]);
    expect(useToasts.getState().toasts.map((t) => t.title)).toEqual(['Core Daemon を停止しました']);
  });

  it('forces only after the person confirmed interrupting the active runs', async () => {
    shell.tauri = true;
    const fake = createFakeClient({
      'system.info': () => info(2),
      'system.shutdown': () => ({ ok: true, pid: 42, activeRuns: 2 }),
    });
    await confirmShutdown(createRuntime(fake.client));
    const req = useConfirm.getState().request!;
    expect(req.title).toBe('Core Daemon を再起動しますか？');
    expect(req.confirmLabel).toBe('2 件を中断して再起動');
    expect(fake.calls.some((c) => c.method === 'system.shutdown')).toBe(false);
    await confirm(req);
    expect(fake.calls.find((c) => c.method === 'system.shutdown')?.params).toEqual({ force: true });
    const t = useToasts.getState().toasts[0]!;
    expect(t.title).toBe('Core Daemon を再起動しています');
    expect(t.detail).toContain('Run 2 件は中断しました');
  });

  it('asks again with the daemon count when a run started after the confirmation', async () => {
    const forced: unknown[] = [];
    const fake = createFakeClient({
      'system.info': () => info(0),
      'system.shutdown': (p) => {
        if (!p.force) {
          throw new AccClientError('conflict', '実行中の Run が 1 件あります。', { activeRuns: 1 });
        }
        forced.push(p);
        return { ok: true, pid: 42, activeRuns: 1 };
      },
    });
    await confirmShutdown(createRuntime(fake.client));
    await confirm(useConfirm.getState().request!);
    const again = useConfirm.getState().request!;
    expect(again.confirmLabel).toBe('1 件を中断して停止');
    expect(forced).toEqual([]);
    await confirm(again);
    expect(forced).toEqual([{ force: true }]);
  });
});
