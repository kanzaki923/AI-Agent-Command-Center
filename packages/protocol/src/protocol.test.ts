import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Event,
  EVENT_TYPES,
  METHOD_NAMES,
  Project,
  RunPermission,
  SessionId,
  Settings,
  api,
  eventMatchesFilter,
  matchPattern,
  type ParamsInput,
} from './index';

const ID = 'ses_' + '0'.repeat(26);

describe('matchPattern', () => {
  it.each([
    ['*', 'task.create', true],
    ['task.*', 'task.create', true],
    ['task.*', 'task', false],
    ['task.*', 'taskx.create', false],
    ['task.create', 'task.create', true],
    ['task.create', 'task.list', false],
    ['*.list', 'task.list', true],
    ['*.list', 'task.list.x', false],
    ['run.*', 'run.status_changed', true],
  ])('%s vs %s -> %s', (pattern, name, expected) => {
    expect(matchPattern(pattern, name)).toBe(expected);
  });
});

describe('eventMatchesFilter', () => {
  const ev = { type: 'run.created', projectId: null, sessionId: ID, runId: null, taskId: null };
  it('matches empty filter', () => expect(eventMatchesFilter(ev, {})).toBe(true));
  it('filters by ref', () => {
    expect(eventMatchesFilter(ev, { sessionId: ID })).toBe(true);
    expect(eventMatchesFilter(ev, { sessionId: 'ses_' + '1'.repeat(26) })).toBe(false);
  });
  it('filters by type pattern', () => {
    expect(eventMatchesFilter(ev, { types: ['run.*'] })).toBe(true);
    expect(eventMatchesFilter(ev, { types: ['session.*', 'task.created'] })).toBe(false);
  });
});

describe('ids', () => {
  it('validates prefix and length', () => {
    expect(SessionId.safeParse(ID).success).toBe(true);
    expect(SessionId.safeParse('run_' + '0'.repeat(26)).success).toBe(false);
    expect(SessionId.safeParse('ses_short').success).toBe(false);
  });
});

describe('api contract', () => {
  it('every method has description, permission and object params', () => {
    for (const name of METHOD_NAMES) {
      const spec = api[name];
      expect(spec.name).toBe(name);
      expect(spec.description.length).toBeGreaterThan(5);
      expect(spec.permission).toBe(name);
      expect(spec.params).toBeInstanceOf(z.ZodObject);
    }
  });

  it('params are strict (unknown keys rejected) and defaults applied', () => {
    const p = api['session.create'].params;
    expect(p.safeParse({ bogus: 1 }).success).toBe(false);
    expect(p.parse({})).toMatchObject({ kind: 'chat' });
  });

  it('param schemas convert to JSON Schema for LLM tools', () => {
    for (const name of METHOD_NAMES) {
      const schema = z.toJSONSchema(api[name].params, { io: 'input', unrepresentable: 'any' });
      expect(schema.type).toBe('object');
    }
  });

  it('types: ParamsInput makes defaults optional', () => {
    const p: ParamsInput<'task.create'> = { projectId: 'prj_' + '0'.repeat(26), title: 'x' };
    expect(api['task.create'].params.parse(p).priority).toBe('normal');
  });
});

describe('events', () => {
  it('has a schema for every type and parses a sample event', () => {
    expect(EVENT_TYPES).toContain('run.status_changed');
    const ev = Event.parse({
      seq: 1,
      id: 'evt_' + '0'.repeat(26),
      ts: new Date(0).toISOString(),
      actor: { kind: 'system' },
      projectId: null,
      sessionId: null,
      runId: 'run_' + '0'.repeat(26),
      taskId: null,
      type: 'run.status_changed',
      payload: { runId: 'run_' + '0'.repeat(26), from: 'running', to: 'interrupted', reason: null },
    });
    expect(ev.type).toBe('run.status_changed');
    if (ev.type === 'run.status_changed') expect(ev.payload.to).toBe('interrupted');
  });

  it('rejects payload of the wrong shape', () => {
    const r = Event.safeParse({
      seq: 1,
      id: 'evt_' + '0'.repeat(26),
      ts: new Date(0).toISOString(),
      actor: { kind: 'human' },
      projectId: null,
      sessionId: null,
      runId: null,
      taskId: null,
      type: 'session.archived',
      payload: { nope: true },
    });
    expect(r.success).toBe(false);
  });
});

describe('settings', () => {
  it('fills defaults from empty config', () => {
    expect(Settings.parse({})).toEqual({
      litellm: { baseUrl: null, apiKey: null },
      defaultModel: null,
      defaultRuntime: null,
      maxConcurrentRuns: 10,
      maxConcurrentAgents: 10,
      maxConcurrentChats: 16,
      limits: { dailyUsd: 20, timezone: expect.any(String) },
      maxDelegationDepth: 1,
      autoResumeOrchestrators: true,
      autoResume: true,
      supervisor: {
        maxModelCallsPerRun: 24,
        maxWakesPerHour: 30,
        wakeDebounceMs: 1500,
        contextMessages: 40,
      },
      llmCallReserveUsd: 0.25,
      defaultPermissionProfile: 'autonomous',
      autoMode: { enabled: true, judge: 'server', classifierModel: null, classifierCostUsd: 0.011 },
    });
  });

  it('fills partial nested settings', () => {
    const s = Settings.parse({ limits: { dailyUsd: null }, supervisor: { maxWakesPerHour: 5 } });
    expect(s.limits.dailyUsd).toBeNull();
    expect(s.limits.timezone.length).toBeGreaterThan(0);
    expect(s.supervisor).toEqual({
      maxModelCallsPerRun: 24,
      maxWakesPerHour: 5,
      wakeDebounceMs: 1500,
      contextMessages: 40,
    });
  });

  it('gives an older auto mode setting the server judge', () => {
    // Written before `judge` existed (the CLI's own classifier was then the only way).
    const s = Settings.parse({ autoMode: { enabled: true, classifierModel: 'team-sonnet' } });
    expect(s.autoMode).toEqual({
      enabled: true,
      judge: 'server',
      classifierModel: 'team-sonnet',
      classifierCostUsd: 0.011,
    });
    expect(() => Settings.parse({ autoMode: { judge: 'elsewhere' } })).toThrow();
  });

  it('keeps older run permissions and tool decisions valid without a judge', () => {
    expect(RunPermission.parse({ profile: 'standard', gate: 'classifier', note: null })).toEqual({
      profile: 'standard',
      gate: 'classifier',
      note: null,
    });
    expect(
      RunPermission.parse({ profile: 'standard', gate: 'classifier', note: null, judge: 'server' })
        .judge,
    ).toBe('server');
  });

  it('keeps old projects valid: no permission profile follows the global default', () => {
    const p = Project.parse({
      id: 'prj_00000000000000000000000001',
      name: 'p',
      description: null,
      repoPath: null,
      defaultBranch: null,
      defaultModel: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
    });
    expect(p.permissionProfile).toBeNull();
  });
});
