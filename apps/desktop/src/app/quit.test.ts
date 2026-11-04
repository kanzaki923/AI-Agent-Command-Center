import { AccClientError } from '@acc/client';
import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRuntime } from '../daemon/runtime';
import { type ConfirmRequest, useConfirm } from '../store/confirm';
import { useToasts } from '../store/toast';
import { createFakeClient } from '../test/fakeClient';
import { type QuitShell, confirmQuit, quitCopy } from './quit';

const info = (activeRuns: number) => ({ methods: [], stats: { activeRuns, lastEventSeq: 0 } });
const schedules = (n: number) => () => ({
  items: Array.from({ length: n }, (_, i) => ({ id: `s${i}` })),
});

function fakeShell() {
  const log: string[] = [];
  const shell: QuitShell = {
    setQuitting: async (on) => void log.push(`quitting:${on}`),
    exit: async () => void log.push('exit'),
  };
  return { shell, log };
}

/** Let the calls a step starts settle. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

async function confirm(req: ConfirmRequest): Promise<void> {
  req.onConfirm();
  await settle();
}

beforeEach(() => {
  useConfirm.setState({ request: null });
  useToasts.setState({ toasts: [] });
});

describe('quitCopy', () => {
  it('asks nothing when nothing would stop', () => {
    expect(quitCopy({ activeRuns: 0, schedules: 0 })).toBeNull();
  });

  it('names the work that is interrupted and the schedules that pause', () => {
    const c = quitCopy({ activeRuns: 3, schedules: 2 })!;
    expect(c.title).toBe('終了しますか？');
    expect(c.body).toBe(
      '動いている 3 件は中断します（あとで再開できます）。定期実行 2 件は、次にアプリを開くまで動きません。',
    );
    expect(c.confirmLabel).toBe('3 件を中断して終了');
    expect(quitCopy({ activeRuns: 0, schedules: 1 })!.confirmLabel).toBe('終了する');
  });
});

describe('confirmQuit', () => {
  it('stops the daemon and exits at once when nothing would stop', async () => {
    const fake = createFakeClient({
      'system.info': () => info(0),
      'schedule.list': schedules(0),
      'system.shutdown': () => ({ ok: true, pid: 1, activeRuns: 0 }),
    });
    const { shell, log } = fakeShell();
    await confirmQuit(createRuntime(fake.client), shell);
    await settle();
    expect(useConfirm.getState().request).toBeNull();
    expect(fake.calls.find((c) => c.method === 'system.shutdown')?.params).toEqual({
      force: false,
    });
    expect(fake.calls.find((c) => c.method === 'schedule.list')?.params).toEqual({ enabled: true });
    expect(log).toEqual(['quitting:true', 'exit']);
  });

  it('asks first, and forces only after the person agreed to interrupt', async () => {
    const fake = createFakeClient({
      'system.info': () => info(2),
      'schedule.list': schedules(1),
      'system.shutdown': () => ({ ok: true, pid: 1, activeRuns: 2 }),
    });
    const { shell, log } = fakeShell();
    await confirmQuit(createRuntime(fake.client), shell);
    const req = useConfirm.getState().request!;
    expect(req.confirmLabel).toBe('2 件を中断して終了');
    expect(req.danger).toBe(true);
    expect(fake.calls.some((c) => c.method === 'system.shutdown')).toBe(false);
    expect(log).toEqual([]);
    await confirm(req);
    expect(fake.calls.find((c) => c.method === 'system.shutdown')?.params).toEqual({ force: true });
    expect(log).toEqual(['quitting:true', 'exit']);
  });

  it('asks again when work started after the counts were taken', async () => {
    let refused = false;
    const fake = createFakeClient({
      'system.info': () => info(0),
      'schedule.list': schedules(0),
      'system.shutdown': (p) => {
        if (!p.force) {
          refused = true;
          throw new AccClientError('conflict', '実行中の Run が 1 件あります。', { activeRuns: 1 });
        }
        return { ok: true, pid: 1, activeRuns: 1 };
      },
    });
    const { shell, log } = fakeShell();
    await confirmQuit(createRuntime(fake.client), shell);
    await settle();
    expect(refused).toBe(true);
    const again = useConfirm.getState().request!;
    expect(again.confirmLabel).toBe('1 件を中断して終了');
    expect(log).toEqual(['quitting:true', 'quitting:false']);
    await confirm(again);
    expect(log).toEqual(['quitting:true', 'quitting:false', 'quitting:true', 'exit']);
  });

  it('stays open and says so when the daemon cannot be stopped', async () => {
    const fake = createFakeClient({
      'system.info': () => info(0),
      'schedule.list': schedules(0),
      'system.shutdown': () => {
        throw new AccClientError('internal', 'boom');
      },
    });
    const { shell, log } = fakeShell();
    await confirmQuit(createRuntime(fake.client), shell);
    await settle();
    expect(log).toEqual(['quitting:true', 'quitting:false']);
    expect(useToasts.getState().toasts[0]?.title).toContain('終了できませんでした');
  });

  it('treats a daemon without schedules as having none', async () => {
    const fake = createFakeClient({
      'system.info': () => info(0),
      'system.shutdown': () => ({ ok: true, pid: 1, activeRuns: 0 }),
    });
    const { shell, log } = fakeShell();
    await confirmQuit(createRuntime(fake.client), shell);
    await settle();
    expect(log).toEqual(['quitting:true', 'exit']);
  });

  it('exits without calling the daemon when it is not connected', async () => {
    const fake = createFakeClient();
    fake.setState('reconnecting');
    const { shell, log } = fakeShell();
    await confirmQuit(createRuntime(fake.client), shell);
    expect(fake.calls).toEqual([]);
    expect(log).toEqual(['exit']);
  });
});
