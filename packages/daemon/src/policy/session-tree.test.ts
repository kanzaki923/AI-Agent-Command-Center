/**
 * T0 acceptance (spec 20261029 §5.2): `CallScope.sessionIds` keeps agents inside their own
 * session tree, and grants with lifetime `work` end when the tree settles — not on restart.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapabilityGrant } from '@acc/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../core/errors';
import { HUMAN, type TestDaemonNoServer, createTestDaemon, insertTestTask } from '../testing';
import { WORK_SETTLED } from './grants';
import { actorOf, insertRun, setRunStatus } from './testutil';

const daemons: TestDaemonNoServer[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.cleanup();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 5 });
});

async function daemon(home?: string) {
  const d = await createTestDaemon(home ? { home } : {});
  daemons.push(d);
  d.ctx.service('llm').mock.chunkDelayMs = 0;
  return d;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'ok',
    (e: unknown) => (e instanceof ApiError ? e.code : String(e)),
  );
}

/** root → child → grandchild, plus an unrelated tree and a sibling of the child. */
async function trees(d: TestDaemonNoServer) {
  const root = await d.call(HUMAN, 'session.create', { title: 'root' });
  const child = await d.call(HUMAN, 'session.create', { parentSessionId: root.id, kind: 'agent' });
  const sibling = await d.call(HUMAN, 'session.create', { parentSessionId: root.id });
  const grandchild = await d.call(HUMAN, 'session.create', { parentSessionId: child.id });
  const other = await d.call(HUMAN, 'session.create', { title: 'other' });
  return { root, child, sibling, grandchild, other };
}

function grant(
  d: TestDaemonNoServer,
  subject: CapabilityGrant['subject'],
  lifetime: CapabilityGrant['lifetime'],
  permissions = ['session.get', 'session.messages'],
) {
  return d.ctx.service('policy').createGrant({ subject, permissions, lifetime }, HUMAN);
}

describe('CallScope.sessionIds', () => {
  it('a session grant reaches the subject session and its descendants, not another tree', async () => {
    const d = await daemon();
    const t = await trees(d);
    grant(d, { kind: 'session', sessionId: t.root.id }, 'session');
    const actor = actorOf(insertRun(d.ctx, { sessionId: t.root.id }));
    for (const s of [t.root, t.child, t.sibling, t.grandchild]) {
      expect(await codeOf(d.call(actor, 'session.get', { sessionId: s.id })), s.title).toBe('ok');
    }
    expect(await codeOf(d.call(actor, 'session.get', { sessionId: t.other.id }))).toBe('forbidden');
    expect(await codeOf(d.call(actor, 'session.messages', { sessionId: t.other.id }))).toBe(
      'forbidden',
    );
    const denied = d.ctx.bus.list({ types: ['policy.denied'] }).events;
    expect(denied.at(-1)).toMatchObject({
      payload: { permission: 'session.messages', reason: expect.stringContaining('session tree') },
    });
  });

  it("a run grant reaches its own session's subtree, not the parent or siblings", async () => {
    const d = await daemon();
    const t = await trees(d);
    const run = insertRun(d.ctx, { sessionId: t.child.id });
    grant(d, { kind: 'run', runId: run.id }, 'run');
    const actor = actorOf(run);
    expect(await codeOf(d.call(actor, 'session.get', { sessionId: t.child.id }))).toBe('ok');
    expect(await codeOf(d.call(actor, 'session.get', { sessionId: t.grandchild.id }))).toBe('ok');
    expect(await codeOf(d.call(actor, 'session.get', { sessionId: t.root.id }))).toBe('forbidden');
    expect(await codeOf(d.call(actor, 'session.get', { sessionId: t.sibling.id }))).toBe(
      'forbidden',
    );
  });

  it('humans are not limited, and calls without sessions are unaffected', async () => {
    const d = await daemon();
    const t = await trees(d);
    expect(await codeOf(d.call(HUMAN, 'session.get', { sessionId: t.other.id }))).toBe('ok');
    grant(d, { kind: 'session', sessionId: t.root.id }, 'session', ['project.list']);
    const actor = actorOf(insertRun(d.ctx, { sessionId: t.root.id }));
    expect(await codeOf(d.call(actor, 'project.list', {}))).toBe('ok');
  });
});

describe('grant lifetime work', () => {
  it('survives a restart, and ends when the session state says the tree settled', async () => {
    const home = mkdtempSync(join(tmpdir(), 'acc-work-'));
    homes.push(home);
    const d1 = await daemon(home);
    const t = await trees(d1);
    const work = grant(d1, { kind: 'session', sessionId: t.root.id }, 'work');
    const legacy = grant(d1, { kind: 'session', sessionId: t.root.id }, 'run');
    // A child's run ends while the stubbed state says the tree is still busy: kept.
    const settled = vi
      .spyOn(d1.ctx.service('sessionState'), 'isWorkSettled')
      .mockReturnValue(false);
    const run = insertRun(d1.ctx, { sessionId: t.child.id });
    setRunStatus(d1.ctx, run.id, 'completed');
    expect(settled).toHaveBeenCalledWith(t.root.id);
    expect(d1.ctx.repos.grants.require(work.id).revokedAt).toBeNull();
    // Crash mid-run: the restart interrupts the run but ends no work grant.
    insertRun(d1.ctx, { sessionId: t.grandchild.id });
    await d1.close();
    daemons.splice(daemons.indexOf(d1), 1);

    const d2 = await daemon(home);
    expect(d2.ctx.repos.runs.count({ where: { status: 'interrupted' } })).toBe(1);
    for (const g of [work, legacy]) expect(d2.ctx.repos.grants.require(g.id).revokedAt).toBeNull();

    // The tree settles: the state service says so on the next state change.
    vi.spyOn(d2.ctx.service('sessionState'), 'isWorkSettled').mockReturnValue(true);
    d2.ctx.bus.emit({
      type: 'session.state_changed',
      actor: { kind: 'system', component: 'test' },
      payload: {
        sessionId: t.grandchild.id,
        rootSessionId: t.root.id,
        parentSessionId: t.child.id,
        from: 'working',
        to: 'done',
        stateSince: d2.ctx.clock.iso(),
        now: null,
      },
    });
    for (const g of [work, legacy]) {
      expect(d2.ctx.repos.grants.require(g.id).revokedAt).not.toBeNull();
    }
    const revoked = d2.ctx.bus.list({ types: ['grant.revoked'] }).events;
    expect(revoked.map((e) => e.type === 'grant.revoked' && e.payload.reason)).toEqual([
      WORK_SETTLED,
      WORK_SETTLED,
    ]);
  });

  it('session-lifetime grants are not ended by settled work', async () => {
    const d = await daemon();
    const t = await trees(d);
    const keep = grant(d, { kind: 'session', sessionId: t.root.id }, 'session');
    vi.spyOn(d.ctx.service('sessionState'), 'isWorkSettled').mockReturnValue(true);
    setRunStatus(d.ctx, insertRun(d.ctx, { sessionId: t.root.id }).id, 'completed');
    expect(d.ctx.repos.grants.require(keep.id).revokedAt).toBeNull();
  });

  it('the core settled check counts runs, open tasks and attention of the whole subtree', async () => {
    const d = await daemon();
    const t = await trees(d);
    const state = d.ctx.service('sessionState');
    expect(state.isWorkSettled(t.root.id)).toBe(true);

    const run = insertRun(d.ctx, { sessionId: t.grandchild.id });
    expect(state.isWorkSettled(t.root.id)).toBe(false);
    expect(state.isWorkSettled(t.sibling.id)).toBe(true);
    setRunStatus(d.ctx, run.id, 'completed');
    expect(state.isWorkSettled(t.root.id)).toBe(true);

    const task = insertTestTask(d.ctx, {
      projectId: null,
      status: 'review',
      assigneeSessionId: t.child.id,
    });
    expect(state.isWorkSettled(t.root.id)).toBe(false);
    d.ctx.repos.tasks.update(task.id, (x) => ({ ...x, status: 'done' }));
    expect(state.isWorkSettled(t.root.id)).toBe(true);

    const now = d.ctx.clock.iso();
    d.ctx.repos.attention.insert({
      id: d.ctx.ids.next('attention'),
      kind: 'question',
      status: 'open',
      sessionId: t.grandchild.id,
      rootSessionId: t.root.id,
      title: 'q',
      detail: null,
      choices: [],
      allowText: true,
      priority: 20,
      refs: {},
      resolution: null,
      createdAt: now,
      resolvedAt: null,
    });
    expect(state.isWorkSettled(t.root.id)).toBe(false);
    expect(state.isWorkSettled(t.other.id)).toBe(true);
  });

  it('with the core check, a chat grant of lifetime work ends when its run ends', async () => {
    const d = await daemon();
    const s = await d.call(HUMAN, 'session.create', { model: 'mock/fast' });
    const g = grant(d, { kind: 'session', sessionId: s.id }, 'work');
    const sent = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: 'こんにちは' });
    expect(sent.delivery).toBe('started');
    await d.ctx.service('runs').waitForEnd(sent.runId!);
    await vi.waitFor(() => expect(d.ctx.repos.grants.require(g.id).revokedAt).not.toBeNull());
  });
});
