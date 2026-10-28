import { AccClientError } from '@acc/client';
import { describe, expect, it } from 'vitest';
import { createFakeClient } from '../test/fakeClient';
import { id, session } from '../test/fixtures';
import { makeOrchestrator, runTask } from './actions';
import { createRuntime } from './runtime';

describe('makeOrchestrator ("Orchestrator にする")', () => {
  it('grants the orchestrator preset for the next run of the chat', async () => {
    const fake = createFakeClient({ 'session.grantOrchestration': () => ({ grant: {}, budget: null }) });
    const s = session({ kind: 'chat', projectId: id('prj') });
    expect(await makeOrchestrator(createRuntime(fake.client), s)).toBe(true);
    expect(fake.calls).toEqual([
      { method: 'session.grantOrchestration', params: { sessionId: s.id, lifetime: 'run' } },
    ]);
  });
});

describe('runTask ("このTaskを実行")', () => {
  it('starts a worker through task.spawnWorker and returns its session', async () => {
    const sessionId = id('ses');
    const fake = createFakeClient({
      'task.spawnWorker': () => ({
        sessionId,
        runId: id('run'),
        workspaceId: id('wsp'),
        budgetId: null,
      }),
    });
    const taskId = id('tsk');
    expect(await runTask(createRuntime(fake.client), taskId)).toBe(sessionId);
    expect(fake.calls).toEqual([{ method: 'task.spawnWorker', params: { taskId } }]);
  });

  it('returns null (and toasts) when the daemon refuses', async () => {
    const fake = createFakeClient({
      'task.spawnWorker': () => {
        throw new AccClientError('conflict', 'すでに実行中です');
      },
    });
    expect(await runTask(createRuntime(fake.client), id('tsk'))).toBeNull();
  });
});
