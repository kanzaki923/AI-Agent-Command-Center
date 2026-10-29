import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ATTENTION_DEFAULT_CHOICES,
  Artifact,
  Attention,
  Event,
  EVENT_TYPES,
  ID_PREFIXES,
  type IdKind,
  InboxItem,
  Message,
  Project,
  Schedule,
  Session,
  SessionCard,
  Task,
  Workspace,
  api,
  attentionEvents,
  attentionMethods,
  costEvents,
  costMethods,
  homeEvents,
  homeMethods,
  outputsEvents,
  outputsMethods,
  scheduleEvents,
  scheduleMethods,
  spawnMethods,
  supervisorEvents,
  supervisorMethods,
} from './index';

const id = (kind: IdKind, n = 0) => `${ID_PREFIXES[kind]}_${String(n).padStart(26, '0')}`;
const T = '2026-10-29T09:00:00.000Z';
const HUMAN = { kind: 'human' as const, client: 'test' };

/** parse → JSON → parse gives the same value (what crosses the wire and the DB). */
function roundTrip<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const once = schema.parse(value);
  const twice = schema.parse(JSON.parse(JSON.stringify(once)));
  expect(twice).toEqual(once);
  return once;
}

const sessionRow = {
  id: id('session', 2),
  projectId: null,
  kind: 'agent',
  title: 'FAQ を書く',
  model: null,
  runtime: null,
  systemPrompt: null,
  workspaceId: null,
  taskId: null,
  parentSessionId: id('session', 1),
  activeRunId: null,
  pinned: false,
  createdBy: HUMAN,
  createdAt: T,
  updatedAt: T,
  lastActivityAt: T,
  archivedAt: null,
};

const attention = {
  id: id('attention'),
  kind: 'question',
  status: 'open',
  sessionId: id('session', 2),
  rootSessionId: id('session', 1),
  title: '価格（月額 980 円）を FAQ に載せる？',
  detail: null,
  choices: [{ id: 'c1', label: '載せる', tone: 'primary' }],
  allowText: true,
  priority: 20,
  refs: { askedBySessionId: id('session', 2) },
  resolution: null,
  createdAt: T,
  resolvedAt: null,
};

const schedule = {
  id: id('schedule'),
  sessionId: id('session', 1),
  title: '週次レポート',
  prompt: '今週の進捗をまとめる',
  trigger: { kind: 'cron', expr: '0 9 * * 1', tz: 'Asia/Tokyo' },
  run: {
    mode: 'agent',
    workspace: { kind: 'none' },
    model: null,
    budgetUsd: 1,
    supervise: false,
    includePrevious: true,
  },
  catchUp: 'latest',
  maxLatenessMin: 720,
  enabled: true,
  nextRunAt: T,
  lastRun: {
    scheduledFor: T,
    firedAt: T,
    sessionId: id('session', 3),
    outcome: 'started',
    error: null,
  },
  expiresAt: null,
  createdBy: HUMAN,
  createdAt: T,
  updatedAt: T,
};

const card = {
  id: id('session', 2),
  parentId: id('session', 1),
  depth: 1,
  title: 'FAQ を書く',
  role: 'agent',
  state: 'working',
  stateSince: T,
  now: 'faq.md を編集',
  costUsd: 0.12,
  budget: { limitUsd: 1, usedUsd: 0.12 },
  outputs: [{ id: id('artifact'), kind: 'document', title: 'FAQ' }],
  attentionIds: [id('attention')],
  startedBy: 'ai',
  scheduleId: null,
  lastActivityAt: T,
};

const documentArtifact = {
  id: id('artifact'),
  kind: 'document',
  projectId: null,
  sessionId: id('session', 2),
  runId: id('run'),
  taskId: null,
  workspaceId: null,
  title: 'FAQ',
  createdBy: HUMAN,
  createdAt: T,
  data: { format: 'markdown', content: '# FAQ', path: null },
};

describe('domain: older rows stay readable', () => {
  it('a session without the tree fields reads as its own root with defaults', () => {
    const s = roundTrip(Session, { ...sessionRow, parentSessionId: null });
    expect(s.rootSessionId).toBe(sessionRow.id);
    expect(s).toMatchObject({
      state: 'idle',
      stateSince: null,
      now: null,
      cost: { ownUsd: 0, treeUsd: 0, source: 'unknown' },
      brief: null,
      scheduleId: null,
      supervision: 'active',
    });
    const child = roundTrip(Session, {
      ...sessionRow,
      rootSessionId: id('session', 1),
      brief: { goal: 'FAQ', fromSessionId: id('session', 1), givenAt: T },
    });
    expect(child.rootSessionId).toBe(id('session', 1));
    expect(child.brief).toEqual({
      goal: 'FAQ',
      doneWhen: [],
      fromSessionId: id('session', 1),
      reviewBy: 'none',
      givenAt: T,
    });
  });

  it('messages, tasks, runs-related and projects get defaults', () => {
    const m = roundTrip(Message, {
      id: id('message'),
      sessionId: id('session'),
      runId: null,
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      author: HUMAN,
      model: null,
      createdAt: T,
    });
    expect(m).toMatchObject({ delivery: 'delivered', meta: null, usage: null });
    const wake = roundTrip(Message, {
      ...m,
      meta: {
        kind: 'wake',
        items: [{ sessionId: id('session', 2), title: 'FAQ', change: 'done' }],
      },
    });
    expect(wake.meta).toEqual({
      kind: 'wake',
      items: [{ sessionId: id('session', 2), title: 'FAQ', change: 'done', artifactIds: [] }],
    });

    const t = roundTrip(Task, {
      id: id('task'),
      projectId: null,
      parentTaskId: null,
      title: 'x',
      description: '',
      acceptanceCriteria: [],
      status: 'paused',
      priority: 'normal',
      dependsOn: [],
      assigneeSessionId: null,
      workspaceId: null,
      resultSummary: null,
      createdBy: HUMAN,
      createdAt: T,
      updatedAt: T,
      completedAt: null,
    });
    expect(t.autoStart).toBe(true);

    const p = roundTrip(Project, {
      id: id('project'),
      name: 'p',
      description: null,
      repoPath: null,
      defaultBranch: null,
      defaultModel: null,
      createdAt: T,
      updatedAt: T,
      archivedAt: null,
    });
    expect(p.folderPath).toBeNull();

    const w = roundTrip(Workspace, {
      id: id('workspace'),
      projectId: null,
      kind: 'scratch',
      status: 'ready',
      path: '/x',
      branch: null,
      baseRef: null,
      taskId: null,
      lockedByRunId: null,
      error: null,
      createdAt: T,
      updatedAt: T,
    });
    expect(w.kind).toBe('scratch');
  });

  it('artifacts get role, source and review defaults per kind', () => {
    const doc = roundTrip(Artifact, documentArtifact);
    expect(doc).toMatchObject({
      role: 'output',
      source: 'published',
      summary: null,
      review: { state: 'none', by: null, at: null, note: null },
    });
    const commit = roundTrip(Artifact, {
      ...documentArtifact,
      kind: 'commit',
      data: { sha: 'abc', branch: null, message: 'm', stats: null },
    });
    expect(commit.role).toBe('evidence');
    const diff = roundTrip(Artifact, {
      ...documentArtifact,
      kind: 'diff',
      data: {
        patch: '',
        baseRef: null,
        headRef: null,
        stats: { files: 0, additions: 0, deletions: 0 },
        files: [],
      },
    });
    expect(diff).toMatchObject({ role: 'output', source: 'workspace_diff' });
    // Legacy kinds stay readable.
    expect(
      roundTrip(Artifact, { ...documentArtifact, kind: 'note', data: { text: 'x' } }).kind,
    ).toBe('note');
    for (const data of [{ format: 'csv', columns: ['a'], rows: [[1]], path: null }]) {
      expect(roundTrip(Artifact, { ...documentArtifact, kind: 'data', data }).kind).toBe('data');
    }
    expect(
      roundTrip(Artifact, {
        ...documentArtifact,
        kind: 'link',
        data: { url: 'https://x', label: null },
      }).kind,
    ).toBe('link');
    expect(
      roundTrip(Artifact, {
        ...documentArtifact,
        kind: 'files',
        data: { root: '.', files: [{ path: 'a.md', size: 3, mimeType: null }] },
      }).kind,
    ).toBe('files');
  });

  it('track entities round-trip', () => {
    roundTrip(Attention, attention);
    roundTrip(Schedule, schedule);
    roundTrip(SessionCard, card);
    roundTrip(InboxItem, {
      id: id('inboxItem'),
      sessionId: id('session', 1),
      kind: 'child_update',
      refs: { childSessionId: id('session', 2) },
      status: 'pending',
      consumedByRunId: null,
      createdAt: T,
    });
    expect(ATTENTION_DEFAULT_CHOICES.budget.map((c) => c.id)).toEqual(['add_1', 'add_5', 'stop']);
  });
});

/** Sample params and results for every method declared by a track. */
const samples: Record<string, { params: unknown; result: unknown }> = {
  'session.stop': {
    params: { sessionId: id('session') },
    result: { stoppedSessionIds: [id('session')], cancelledRunIds: [id('run')] },
  },
  'session.resume': {
    params: { sessionId: id('session'), message: '続けて' },
    result: { resumedSessionIds: [id('session')], runIds: [] },
  },
  'session.delegate': {
    params: { sessionId: id('session') },
    result: {
      grant: {
        id: id('grant'),
        subject: { kind: 'session', sessionId: id('session') },
        parentGrantId: null,
        permissions: ['session.spawn'],
        scope: {},
        limits: { maxChildren: 4 },
        depth: 0,
        lifetime: 'session',
        expiresAt: null,
        revokedAt: null,
        reason: null,
        grantedBy: HUMAN,
        createdAt: T,
      },
      budget: null,
    },
  },
  'session.undelegate': {
    params: { sessionId: id('session') },
    result: { revoked: [id('grant')] },
  },
  'session.spawn': {
    params: {
      title: 'FAQ を書く',
      goal: 'FAQ を書く',
      doneWhen: ['10 問ある'],
      workspace: { kind: 'folder', path: '/docs' },
      after: [id('session', 3)],
    },
    result: {
      session: sessionRow,
      runId: null,
      budgetId: null,
      waitingFor: [id('session', 3)],
    },
  },
  'project.inspectFolder': {
    params: { path: '/docs' },
    result: {
      ok: true,
      reason: null,
      path: '/docs',
      isGitRepo: false,
      repoRoot: null,
      defaultBranch: null,
      suggestedName: 'docs',
      suggestedTestCommand: null,
      existingProjectId: null,
    },
  },
  'artifact.publish': {
    params: { kind: 'data', title: '競合の価格', columns: ['社名', '月額'], rows: [['A', 980]] },
    result: documentArtifact,
  },
  'artifact.read': {
    params: { artifactId: id('artifact') },
    result: { content: '# FAQ', mimeType: 'text/markdown', truncated: false },
  },
  'artifact.review': {
    params: { artifactId: id('artifact'), decision: 'redo', note: '短く' },
    result: { artifact: documentArtifact, integrationId: null },
  },
  'human.ask': {
    params: { question: '価格を載せる？', choices: ['載せる', '載せない'] },
    result: { attentionId: id('attention'), status: 'asked' },
  },
  'attention.list': { params: {}, result: { items: [attention], nextCursor: null } },
  'attention.respond': {
    params: { attentionId: id('attention'), choiceId: 'c1' },
    result: attention,
  },
  'attention.dismiss': { params: { attentionId: id('attention') }, result: attention },
  'cost.summary': {
    params: { range: { from: T, to: T }, groupBy: 'model' },
    result: {
      totalUsd: 1.5,
      estimated: true,
      rows: [{ key: 'm', label: 'm', usd: 1.5, estimated: true }],
      daily: { limitUsd: 20, usedTodayUsd: 1.5 },
    },
  },
  'budget.raise': {
    params: { budgetId: id('budget'), addUsd: 1 },
    result: {
      id: id('budget'),
      parentId: null,
      subject: { kind: 'session', id: id('session') },
      status: 'active',
      limitUsd: 4,
      allocatedUsd: 0,
      reservedUsd: 0,
      spentUsd: 0,
      createdBy: HUMAN,
      createdAt: T,
      updatedAt: T,
      releasedAt: null,
    },
  },
  'session.setBudget': {
    params: { sessionId: id('session'), limitUsd: null },
    result: { budget: null },
  },
  'schedule.create': {
    params: {
      sessionId: id('session'),
      prompt: '今週の進捗',
      trigger: { kind: 'cron', expr: '0 9 * * 1' },
      run: { mode: 'chat' },
    },
    result: schedule,
  },
  'schedule.list': { params: { enabled: true }, result: { items: [schedule] } },
  'schedule.get': { params: { scheduleId: id('schedule') }, result: schedule },
  'schedule.update': {
    params: { scheduleId: id('schedule'), enabled: false, expiresAt: null },
    result: schedule,
  },
  'schedule.delete': { params: { scheduleId: id('schedule') }, result: { ok: true } },
  'schedule.runNow': {
    params: { scheduleId: id('schedule') },
    result: { sessionId: id('session') },
  },
  'schedule.preview': {
    params: { trigger: { kind: 'once', at: T } },
    result: { times: [T] },
  },
  'home.get': {
    params: {},
    result: {
      now: T,
      lastSeq: 10,
      totals: {
        working: 1,
        needsYou: 1,
        failed: 0,
        spendTodayUsd: 0.12,
        dailyLimitUsd: 20,
        estimated: true,
      },
      attention: [attention],
      trees: [
        {
          root: { ...card, id: id('session', 1), parentId: null, depth: 0, role: 'supervisor' },
          nodes: [card],
          hiddenNodes: 0,
          counts: { working: 1, queued: 0, needsYou: 1, failed: 0, review: 0, done: 0, stopped: 0 },
          spend: { treeUsd: 0.12, limitUsd: 3, estimated: true },
          nextRunAt: T,
          projectId: null,
        },
      ],
      upcoming: [{ scheduleId: id('schedule'), sessionId: id('session', 1), title: '週次', at: T }],
    },
  },
  'session.tree': {
    params: { sessionId: id('session', 2) },
    result: { rootSessionId: id('session', 1), nodes: [card] },
  },
};

const trackMethods = {
  ...supervisorMethods,
  ...spawnMethods,
  ...outputsMethods,
  ...attentionMethods,
  ...costMethods,
  ...scheduleMethods,
  ...homeMethods,
};

describe('ext methods', () => {
  it('are part of the api with a sample for each', () => {
    for (const name of Object.keys(trackMethods)) {
      expect(api).toHaveProperty(name);
      expect(samples, `sample for ${name}`).toHaveProperty(name);
    }
  });

  it.each(Object.keys(samples))('%s params and result round-trip', (name) => {
    const spec = api[name as keyof typeof api];
    const s = samples[name]!;
    roundTrip(spec.params, s.params);
    roundTrip(spec.result, s.result);
  });

  it('applies defaults and rejects unknown keys', () => {
    const spawn = api['session.spawn'].params.parse({ title: 't', goal: 'g' });
    expect(spawn).toMatchObject({ mode: 'agent', reviewBy: 'none', start: true });
    expect(api['session.stop'].params.parse({ sessionId: id('session') }).tree).toBe(true);
    expect(api['session.delegate'].params.parse({ sessionId: id('session') })).toMatchObject({
      maxChildren: 4,
      budgetUsd: 3,
      allowSchedules: true,
      lifetime: 'session',
    });
    expect(api['human.ask'].params.parse({ question: 'q' }).allowText).toBe(true);
    expect(api['cost.summary'].params.parse({})).toEqual({ range: 'today', groupBy: 'day' });
    expect(api['session.spawn'].params.safeParse({ title: 't', goal: 'g', x: 1 }).success).toBe(
      false,
    );
    expect(
      api['human.ask'].params.safeParse({ question: 'q', choices: ['1', '2', '3', '4', '5'] })
        .success,
    ).toBe(false);
  });

  it('keeps human-only methods out of LLM tools', () => {
    for (const name of [
      'session.delegate',
      'session.undelegate',
      'attention.dismiss',
      'budget.raise',
      'session.setBudget',
      'home.get',
      'project.inspectFolder',
    ] as const) {
      expect(api[name].tool, name).toBe(false);
    }
  });

  it('changed core methods: session.send never refuses, messages carry the stream', () => {
    expect(
      api['session.send'].result.parse({
        messageId: id('message'),
        runId: null,
        delivery: 'queued',
      }),
    ).toEqual({ messageId: id('message'), runId: null, delivery: 'queued' });
    expect(
      api['session.messages'].result.parse({ items: [], hasMore: false }).streaming,
    ).toBeNull();
    expect(
      api['session.list'].params.parse({ rootsOnly: true, parentSessionId: null }),
    ).toMatchObject({ rootsOnly: true, parentSessionId: null });
  });
});

const eventSamples: Record<string, unknown> = {
  'inbox.added': {
    item: {
      id: id('inboxItem'),
      sessionId: id('session'),
      kind: 'answer',
      refs: { attentionId: id('attention') },
      status: 'pending',
      consumedByRunId: null,
      createdAt: T,
    },
  },
  'inbox.consumed': { itemIds: [id('inboxItem')], runId: id('run') },
  'artifact.updated': { artifact: documentArtifact, changes: ['review'] },
  'attention.opened': { attention },
  'attention.resolved': {
    attention: {
      ...attention,
      status: 'resolved',
      resolution: { choiceId: 'c1', text: null, by: HUMAN },
    },
  },
  'session.cost_updated': {
    sessionId: id('session', 2),
    rootSessionId: id('session', 1),
    ownUsd: 0.1,
    treeUsd: 0.2,
    source: 'estimated',
  },
  'budget.threshold': { budgetId: id('budget'), rootSessionId: id('session'), pct: 80 },
  'cost.limit_reached': { scope: 'daily', usedUsd: 20.1, limitUsd: 20 },
  'schedule.created': { schedule },
  'schedule.updated': { schedule, changes: ['enabled'] },
  'schedule.deleted': { scheduleId: id('schedule') },
  'schedule.fired': {
    scheduleId: id('schedule'),
    sessionId: null,
    scheduledFor: T,
    outcome: 'skipped_overlap',
  },
  'session.state_changed': {
    sessionId: id('session', 2),
    rootSessionId: id('session', 1),
    parentSessionId: id('session', 1),
    from: 'working',
    to: 'done',
    stateSince: T,
    now: null,
  },
  'session.now_changed': {
    sessionId: id('session', 2),
    rootSessionId: id('session', 1),
    now: '回答を作成中',
  },
};

describe('ext events', () => {
  const trackEvents = {
    ...supervisorEvents,
    ...outputsEvents,
    ...attentionEvents,
    ...costEvents,
    ...scheduleEvents,
    ...homeEvents,
  };

  it('every track event is a known event type with a sample', () => {
    for (const type of Object.keys(trackEvents)) {
      expect(EVENT_TYPES).toContain(type);
      expect(eventSamples, `sample for ${type}`).toHaveProperty(type);
    }
    expect(EVENT_TYPES).toContain('message.updated');
  });

  it.each(Object.keys(eventSamples))('%s round-trips as an event', (type) => {
    roundTrip(Event as unknown as z.ZodType, {
      seq: 1,
      id: id('event'),
      ts: T,
      actor: { kind: 'system' },
      projectId: null,
      sessionId: null,
      runId: null,
      taskId: null,
      type,
      payload: eventSamples[type],
    });
  });
});
