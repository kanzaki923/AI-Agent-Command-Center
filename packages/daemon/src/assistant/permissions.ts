import type { SystemActor } from '@acc/protocol';

/**
 * What the assistant (作業名「右腕」, snapshot 20261030_right-hand-spec §1.1) may call. It looks
 * over every tree, starts new ones as roots, talks to them, stops and resumes them, and keeps
 * schedules. Deliberately not here: `attention.respond` / `dismiss` (the turn of the human is
 * theirs alone), `session.spawn` (children of its own would fold every tree into one lane),
 * `session.archive`, budgets, settings, project changes, `system.*`.
 */
export const ASSISTANT_PERMISSIONS = [
  'home.get',
  'session.list',
  'session.get',
  'session.tree',
  'session.messages',
  'session.search',
  'project.list',
  'project.get',
  'cost.summary',
  'assistant.startWork',
  'session.send',
  'session.stop',
  'session.resume',
  'schedule.preview',
  'schedule.create',
  'schedule.update',
  'schedule.delete',
  'schedule.list',
  'schedule.get',
] as const;

/** `reason` of the grant that makes a session the assistant (also how it is found again). */
export const ASSISTANT_REASON = 'assistant';

/** `component` of the system actor the work of the assistant is recorded under. */
export const ASSISTANT_COMPONENT = 'assistant';

/** Actor of what the daemon does for the assistant (creating roots, carrying the request). */
export const ASSISTANT_SYSTEM: SystemActor = { kind: 'system', component: ASSISTANT_COMPONENT };

/** Title of the conversation of the assistant (the name is still a working one, spec §5). */
export const ASSISTANT_TITLE = '右腕';

/** Roots the assistant may start per message of the human (spec §1.1). */
export const MAX_TREES_PER_MESSAGE = 3;

/** Schedules the assistant may own (GrantLimits.maxSchedules). */
export const ASSISTANT_MAX_SCHEDULES = 20;

/** Offline model of the assistant (demo, audit, tests). */
export const MOCK_RIGHT_HAND_MODEL = 'mock/right-hand';
