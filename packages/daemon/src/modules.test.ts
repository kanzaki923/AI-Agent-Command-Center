import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createManualClock } from './core/clock';
import { HUMAN, type TestDaemonNoServer, agentActor, createTestDaemon } from './testing';

let d: TestDaemonNoServer;
afterEach(async () => {
  await d?.cleanup();
});

describe('system', () => {
  it('health and info', async () => {
    d = await createTestDaemon();
    const health = await d.call(HUMAN, 'system.health', {});
    expect(health).toMatchObject({ ok: true, protocolVersion: 1 });
    const info = await d.call(HUMAN, 'system.info', {});
    expect(info.methods).toContain('session.create');
    expect(info.methods).not.toContain('task.spawnWorker');
    expect(info.dataDir).toBe(d.home);
    expect(info.stats).toEqual({ projects: 0, sessions: 0, activeRuns: 0, lastEventSeq: 0 });
  });
});

describe('settings', () => {
  it('persists to config.json and never returns or emits the api key', async () => {
    d = await createTestDaemon();
    const view = await d.call(HUMAN, 'settings.update', {
      litellm: { baseUrl: 'http://localhost:4000', apiKey: 'sk-test-0123456789abcdef' },
      defaultModel: 'gpt-x',
    });
    expect(view.litellm).toEqual({
      baseUrl: 'http://localhost:4000',
      hasApiKey: true,
      apiKeyMasked: 'sk-…cdef',
    });
    expect(JSON.stringify(view)).not.toContain('0123456789');
    const onDisk = JSON.parse(readFileSync(join(d.home, 'config.json'), 'utf8')) as {
      litellm: { apiKey: string };
    };
    expect(onDisk.litellm.apiKey).toBe('sk-test-0123456789abcdef');

    const events = d.ctx.bus.list({ types: ['settings.updated'] }).events;
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('0123456789');

    const cleared = await d.call(HUMAN, 'settings.update', { litellm: { apiKey: null } });
    expect(cleared.litellm).toMatchObject({ hasApiKey: false, apiKeyMasked: null });
    // No-op updates emit nothing.
    await d.call(HUMAN, 'settings.update', { defaultModel: 'gpt-x' });
    expect(d.ctx.bus.list({ types: ['settings.updated'] }).events).toHaveLength(2);
  });

  it('is forbidden for agents without a grant', async () => {
    d = await createTestDaemon();
    const actor = agentActor(d.ctx.ids.next('session'), d.ctx.ids.next('run'));
    await expect(d.call(actor, 'settings.update', { defaultModel: 'x' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

describe('projects', () => {
  it('create/list/get/update/archive with events', async () => {
    d = await createTestDaemon();
    const repo = mkdtempSync(join(tmpdir(), 'acc-repo-'));
    try {
      const b = await d.call(HUMAN, 'project.create', { name: 'Beta' });
      const a = await d.call(HUMAN, 'project.create', { name: ' Alpha ', repoPath: repo });
      expect(a.name).toBe('Alpha');
      expect((await d.call(HUMAN, 'project.list', {})).items.map((p) => p.name)).toEqual([
        'Alpha',
        'Beta',
      ]);
      const updated = await d.call(HUMAN, 'project.update', {
        projectId: b.id,
        description: 'desc',
        archived: true,
      });
      expect(updated.archivedAt).not.toBeNull();
      expect((await d.call(HUMAN, 'project.list', {})).items).toHaveLength(1);
      expect((await d.call(HUMAN, 'project.list', { includeArchived: true })).items).toHaveLength(
        2,
      );

      const ev = d.ctx.bus.list({ types: ['project.*'] }).events;
      expect(ev.map((e) => e.type)).toEqual([
        'project.created',
        'project.created',
        'project.updated',
      ]);
      const last = ev[2]!;
      if (last.type === 'project.updated') {
        expect(last.payload.changes).toEqual(['description', 'archivedAt']);
        expect(last.projectId).toBe(b.id);
      }
      await expect(
        d.call(HUMAN, 'project.create', { name: 'x', repoPath: 'relative/path' }),
      ).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(
        d.call(HUMAN, 'project.create', { name: 'x', repoPath: join(repo, 'missing') }),
      ).rejects.toMatchObject({ code: 'invalid_params' });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('sessions', () => {
  it('create inherits the model from project, then settings', async () => {
    d = await createTestDaemon();
    await d.call(HUMAN, 'settings.update', { defaultModel: 'global-model' });
    const p = await d.call(HUMAN, 'project.create', { name: 'P', defaultModel: 'project-model' });
    const s1 = await d.call(HUMAN, 'session.create', { projectId: p.id, title: 'hello' });
    const s2 = await d.call(HUMAN, 'session.create', {});
    const s3 = await d.call(HUMAN, 'session.create', { model: 'explicit' });
    expect([s1.model, s2.model, s3.model]).toEqual(['project-model', 'global-model', 'explicit']);
    expect(s1).toMatchObject({ kind: 'chat', title: 'hello', createdBy: HUMAN, activeRunId: null });
    await expect(
      d.call(HUMAN, 'session.create', { projectId: d.ctx.ids.next('project') }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lists by recent activity with pagination and filters', async () => {
    const clock = createManualClock();
    d = await createTestDaemon({ clock });
    const p = await d.call(HUMAN, 'project.create', { name: 'P' });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      ids.push((await d.call(HUMAN, 'session.create', { projectId: i < 2 ? p.id : undefined })).id);
    }
    // Activity on the oldest moves it to the top.
    clock.advance(1000);
    d.ctx.service('sessions').touch(ids[0]!);

    const page1 = await d.call(HUMAN, 'session.list', { limit: 3 });
    expect(page1.items.map((s) => s.id)).toEqual([ids[0], ids[4], ids[3]]);
    const page2 = await d.call(HUMAN, 'session.list', { limit: 3, cursor: page1.nextCursor! });
    expect(page2.items.map((s) => s.id)).toEqual([ids[2], ids[1]]);
    expect(page2.nextCursor).toBeNull();

    expect((await d.call(HUMAN, 'session.list', { projectId: p.id })).items).toHaveLength(2);

    await d.call(HUMAN, 'session.archive', { sessionId: ids[1]! });
    expect((await d.call(HUMAN, 'session.list', {})).items).toHaveLength(4);
    expect((await d.call(HUMAN, 'session.list', { includeArchived: true })).items).toHaveLength(5);
    const restored = await d.call(HUMAN, 'session.archive', {
      sessionId: ids[1]!,
      archived: false,
    });
    expect(restored.archivedAt).toBeNull();
    const archivedEvents = d.ctx.bus.list({ types: ['session.archived'] }).events;
    expect(archivedEvents).toHaveLength(2);
    expect(archivedEvents[0]!.projectId).toBe(p.id);
  });

  it('update records changed fields only', async () => {
    d = await createTestDaemon();
    const s = await d.call(HUMAN, 'session.create', { title: 'a' });
    await d.call(HUMAN, 'session.update', { sessionId: s.id, title: 'a', pinned: true });
    const ev = d.ctx.bus.list({ types: ['session.updated'] }).events;
    expect(ev).toHaveLength(1);
    if (ev[0]!.type === 'session.updated') expect(ev[0].payload.changes).toEqual(['pinned']);
    // No changes → no event.
    await d.call(HUMAN, 'session.update', { sessionId: s.id, pinned: true });
    expect(d.ctx.bus.list({ types: ['session.updated'] }).events).toHaveLength(1);
  });

  it('messages: appendMessage + paged reads (oldest first)', async () => {
    d = await createTestDaemon();
    const s = await d.call(HUMAN, 'session.create', {});
    const svc = d.ctx.service('sessions');
    const written = Array.from({ length: 5 }, (_, i) =>
      svc.appendMessage({
        sessionId: s.id,
        role: i % 2 ? 'assistant' : 'user',
        content: [{ type: 'text', text: `m${i}` }],
        author: HUMAN,
      }),
    );
    const latest = await d.call(HUMAN, 'session.messages', { sessionId: s.id, limit: 2 });
    expect(latest.items.map((m) => m.id)).toEqual([written[3]!.id, written[4]!.id]);
    expect(latest.hasMore).toBe(true);
    const older = await d.call(HUMAN, 'session.messages', {
      sessionId: s.id,
      limit: 10,
      before: latest.items[0]!.id,
    });
    expect(older.items.map((m) => m.id)).toEqual(written.slice(0, 3).map((m) => m.id));
    expect(older.hasMore).toBe(false);
    const created = d.ctx.bus.list({ types: ['message.created'], sessionId: s.id }).events;
    expect(created).toHaveLength(5);
  });
});
