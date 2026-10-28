import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HUMAN,
  SYSTEM,
  agentActor,
  connectTestClient,
  createTestDaemon,
  startTestDaemon,
} from '../testing';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups.length = 0;
});

describe('system.shutdown', () => {
  it('stops the daemon after replying, over WebSocket, and removes daemon.json', async () => {
    const d = await startTestDaemon();
    cleanups.push(() => d.cleanup());
    const client = await connectTestClient(d, { reconnect: false });
    cleanups.push(() => client.close());

    const res = await client.call('system.shutdown', {});
    expect(res).toEqual({ ok: true, pid: process.pid, activeRuns: 0 });
    await d.closed;
    expect(existsSync(join(d.home, 'daemon.json'))).toBe(false);
    await expect(fetch(`${d.url}/health`)).rejects.toThrow();
  });

  it('is human-only, whatever the caller is allowed by policy', async () => {
    const d = await createTestDaemon();
    cleanups.push(() => d.cleanup());
    await expect(d.call(SYSTEM, 'system.shutdown', {})).rejects.toMatchObject({
      code: 'forbidden',
    });
    // An agent with an all-powerful grant is still refused by the handler.
    const runId = d.ctx.ids.next('run');
    const agent = agentActor(d.ctx.ids.next('session'), runId);
    d.ctx.repos.grants.insert({
      id: d.ctx.ids.next('grant'),
      subject: { kind: 'run', runId },
      parentGrantId: null,
      permissions: ['*'],
      scope: {},
      limits: {},
      depth: 0,
      lifetime: 'run',
      expiresAt: null,
      revokedAt: null,
      reason: null,
      grantedBy: HUMAN,
      createdAt: d.ctx.clock.iso(),
    });
    await expect(d.call(agent, 'system.health', {})).resolves.toMatchObject({ ok: true });
    await expect(d.call(agent, 'system.shutdown', { force: true })).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('人間だけ') as unknown,
    });
  });

  it('refuses while runs are active unless forced', async () => {
    const d = await createTestDaemon();
    cleanups.push(() => d.cleanup());
    d.ctx.service('llm').mock.chunkDelayMs = 50;
    const session = await d.call(HUMAN, 'session.create', { title: 'chat', model: 'mock/echo' });
    await d.call(HUMAN, 'session.send', {
      sessionId: session.id,
      content: 'a long enough message to keep the echo model streaming for a while',
    });

    await expect(d.call(HUMAN, 'system.shutdown', {})).rejects.toMatchObject({
      code: 'conflict',
      data: { activeRuns: 1 },
    });
    await expect(d.call(HUMAN, 'system.shutdown', { force: true })).resolves.toMatchObject({
      activeRuns: 1,
    });
    await d.closed;
  });
});
