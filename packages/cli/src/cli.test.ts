import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HUMAN, startTestDaemon } from '@acc/daemon/testing';
import type { Event } from '@acc/protocol';
import { describe, expect, it } from 'vitest';
import { parseArgs } from './args';
import { formatEvent } from './format';
import { type Io, run } from './main';

describe('parseArgs', () => {
  it('defaults to help', () => {
    expect(parseArgs([])).toEqual({ ok: true, command: { kind: 'help' } });
    expect(parseArgs(['help', 'events'])).toEqual({
      ok: true,
      command: { kind: 'help', topic: 'events' },
    });
    expect(parseArgs(['--version'])).toEqual({ ok: true, command: { kind: 'version' } });
  });

  it('parses status and sessions', () => {
    expect(parseArgs(['status', '--json'])).toEqual({
      ok: true,
      command: { kind: 'status', json: true },
    });
    expect(parseArgs(['sessions', '-p', 'prj_x', '-a', '-n', '5'])).toEqual({
      ok: true,
      command: { kind: 'sessions', json: false, all: true, limit: 5, projectId: 'prj_x' },
    });
  });

  it('parses events filters, repeated and comma-separated types', () => {
    const r = parseArgs([
      'events',
      '-f',
      '--since',
      '10',
      '-t',
      'run.*,task.created',
      '-t',
      'session.*',
      '--session',
      'ses_1',
    ]);
    expect(r).toEqual({
      ok: true,
      command: {
        kind: 'events',
        json: false,
        follow: true,
        since: 10,
        limit: 50,
        filter: { sessionId: 'ses_1', types: ['run.*', 'task.created', 'session.*'] },
      },
    });
  });

  it('parses daemon stop', () => {
    expect(parseArgs(['daemon', 'stop'])).toEqual({
      ok: true,
      command: { kind: 'daemon-stop', force: false },
    });
    expect(parseArgs(['daemon', 'stop', '--force'])).toEqual({
      ok: true,
      command: { kind: 'daemon-stop', force: true },
    });
    expect(parseArgs(['daemon'])).toEqual({ ok: true, command: { kind: 'help', topic: 'daemon' } });
    expect(parseArgs(['daemon', 'restart'])).toEqual({
      ok: false,
      error: expect.stringContaining('不明なサブコマンド'),
    });
  });

  it('reports errors in Japanese', () => {
    expect(parseArgs(['nope'])).toEqual({
      ok: false,
      error: expect.stringContaining('不明なコマンド'),
    });
    expect(parseArgs(['status', '--bogus'])).toEqual({
      ok: false,
      error: expect.stringContaining('不明なオプション'),
    });
    expect(parseArgs(['sessions', '-n', '0'])).toEqual({
      ok: false,
      error: expect.stringContaining('1〜200'),
    });
    expect(parseArgs(['events', '--since', '-1'])).toMatchObject({ ok: false });
    expect(parseArgs(['status', 'extra'])).toEqual({
      ok: false,
      error: expect.stringContaining('余分な引数'),
    });
  });
});

describe('formatEvent', () => {
  it('prints seq, type, summary and refs on one line', () => {
    const e = {
      seq: 7,
      id: 'evt_x',
      ts: '2026-01-01T00:00:00.000Z',
      actor: { kind: 'system', component: 'recovery' },
      projectId: null,
      sessionId: 'ses_a',
      runId: 'run_a',
      taskId: null,
      type: 'run.status_changed',
      payload: { runId: 'run_a', from: 'running', to: 'interrupted', reason: 'daemon_restart' },
    } as Event;
    const line = formatEvent(e);
    expect(line).toMatch(/^#7 \d\d:\d\d:\d\d run\.status_changed/);
    expect(line).toContain('running → interrupted (daemon_restart)');
    expect(line).toContain('run_a');
    expect(line).toContain('[system(recovery)]');
  });
});

function captureIo(env: NodeJS.ProcessEnv, interrupted: Promise<void> = new Promise(() => {})) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), env, interrupted };
  return { io, out, err };
}

describe('acc against a real daemon', () => {
  it('status / sessions / events', async () => {
    const d = await startTestDaemon();
    try {
      const env = { ACC_HOME: d.home };
      await d.call(HUMAN, 'session.create', { title: 'はじめてのチャット' });

      const s = captureIo(env);
      expect(await run(['status'], s.io)).toBe(0);
      expect(s.out.join('\n')).toContain('稼働中');

      const l = captureIo(env);
      expect(await run(['sessions'], l.io)).toBe(0);
      expect(l.out.join('\n')).toContain('はじめてのチャット');

      const e = captureIo(env);
      expect(await run(['events', '--json'], e.io)).toBe(0);
      expect(e.out.map((x) => (JSON.parse(x) as Event).type)).toEqual(['session.created']);

      // --follow prints new events until interrupted.
      let stop!: () => void;
      const f = captureIo(env, new Promise<void>((r) => (stop = r)));
      const following = run(['events', '-f', '-t', 'session.*'], f.io);
      await new Promise((r) => setTimeout(r, 100));
      await d.call(HUMAN, 'session.create', { title: 'live' });
      for (let i = 0; i < 100 && f.out.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
      stop();
      expect(await following).toBe(0);
      expect(f.out).toHaveLength(2);
      expect(f.out[1]).toContain('"live"');
    } finally {
      await d.cleanup();
    }
  });

  it('explains when the daemon is not running', async () => {
    const c = captureIo({ ACC_HOME: 'Z:/definitely/not/here' });
    expect(await run(['status'], c.io)).toBe(1);
    expect(c.err[0]).toContain('起動していません');
  });

  it('daemon stop: waits for the process to exit, and refuses active runs without --force', async () => {
    const d = await startTestDaemon();
    try {
      const env = { ACC_HOME: d.home };
      d.ctx.service('llm').mock.chunkDelayMs = 50;
      const session = await d.call(HUMAN, 'session.create', { title: 'busy', model: 'mock/echo' });
      await d.call(HUMAN, 'session.send', {
        sessionId: session.id,
        content: 'keep the echo model streaming for a little while please',
      });

      const refused = captureIo(env);
      expect(await run(['daemon', 'stop'], refused.io)).toBe(1);
      expect(refused.err.join(' ')).toContain('--force');

      // The daemon runs in this test process, so fake the "process exited" check.
      let polls = 0;
      const stopped = captureIo(env);
      stopped.io.isProcessAlive = () => ++polls < 3;
      expect(await run(['daemon', 'stop', '--force'], stopped.io)).toBe(0);
      expect(polls).toBe(3);
      expect(stopped.out[0]).toMatch(
        /停止しました（pid \d+）。実行中だった Run 1 件は中断しました/,
      );
      await d.closed;
      expect(existsSync(join(d.home, 'daemon.json'))).toBe(false);

      const again = captureIo(env);
      expect(await run(['daemon', 'stop'], again.io)).toBe(0);
      expect(again.out[0]).toContain('起動していません');
    } finally {
      await d.cleanup();
    }
  });
});
