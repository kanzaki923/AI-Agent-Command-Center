import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Event,
  EVENT_TYPES,
  METHOD_NAMES,
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
      maxConcurrentRuns: 10,
      maxDelegationDepth: 1,
    });
  });
});
