import type {
  Actor,
  Approval,
  Attention,
  HomeSnapshot,
  HomeTree,
  SessionCard,
  Event,
  EventOf,
  EventPayload,
  EventType,
  Integration,
  Message,
  Run,
  Session,
  Task,
} from '@acc/protocol';

const HUMAN: Actor = { kind: 'human', client: 'test' };
let n = 0;
/** Deterministic valid-looking ids: `<prefix>_` + 26 base32 chars. */
export function id(prefix: string): string {
  n++;
  return `${prefix}_${String(n).padStart(26, '0')}`;
}

export const T0 = Date.UTC(2026, 9, 29, 5, 0, 0);
export const iso = (ms: number) => new Date(ms).toISOString();

export function session(over: Partial<Session> = {}): Session {
  const sid = over.id ?? id('ses');
  return {
    id: sid,
    rootSessionId: over.parentSessionId ? over.parentSessionId : sid,
    state: 'idle',
    stateSince: null,
    now: null,
    cost: { ownUsd: 0, treeUsd: 0, source: 'unknown' },
    brief: null,
    scheduleId: null,
    supervision: 'active',
    projectId: null,
    kind: 'agent',
    title: 'セッション',
    model: 'anthropic/claude-sonnet-4-5',
    runtime: null,
    systemPrompt: null,
    workspaceId: null,
    taskId: null,
    parentSessionId: null,
    activeRunId: null,
    pinned: false,
    createdBy: HUMAN,
    createdAt: iso(T0),
    updatedAt: iso(T0),
    lastActivityAt: iso(T0),
    archivedAt: null,
    ...over,
  };
}

export function run(s: Session, over: Partial<Run> = {}): Run {
  return {
    id: id('run'),
    sessionId: s.id,
    projectId: s.projectId,
    taskId: s.taskId,
    kind: s.kind === 'agent' ? 'agent' : 'chat',
    status: 'running',
    statusReason: null,
    model: s.model,
    runtime: null,
    workspaceId: null,
    parentRunId: null,
    retryOfRunId: null,
    attempt: 1,
    budgetId: null,
    triggerMessageId: null,
    trigger: 'user',
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.1, costSource: 'reported' },
    error: null,
    createdBy: HUMAN,
    createdAt: iso(T0),
    updatedAt: iso(T0),
    startedAt: iso(T0),
    endedAt: null,
    ...over,
  };
}

export function approval(r: Run, over: Partial<Approval> = {}): Approval {
  return {
    id: id('apr'),
    kind: 'tool_use',
    status: 'pending',
    title: 'コマンドの実行',
    detail: 'pnpm test',
    payload: { toolName: 'Bash', input: { command: 'pnpm test' } },
    projectId: r.projectId,
    sessionId: r.sessionId,
    runId: r.id,
    taskId: r.taskId,
    integrationId: null,
    requestedBy: { kind: 'agent', sessionId: r.sessionId, runId: r.id },
    resolvedBy: null,
    resolutionNote: null,
    createdAt: iso(T0 + 1000),
    resolvedAt: null,
    ...over,
  };
}

export function task(over: Partial<Task> = {}): Task {
  return {
    id: id('tsk'),
    projectId: id('prj'),
    parentTaskId: null,
    title: 'Task',
    description: '',
    acceptanceCriteria: [],
    status: 'running',
    statusReason: null,
    priority: 'normal',
    dependsOn: [],
    assigneeSessionId: null,
    workspaceId: null,
    resultSummary: null,
    createdBy: HUMAN,
    createdAt: iso(T0),
    updatedAt: iso(T0),
    completedAt: null,
    autoStart: true,
    ...over,
  };
}

export function integration(over: Partial<Integration> = {}): Integration {
  return {
    id: id('int'),
    projectId: id('prj'),
    title: '統合候補',
    status: 'awaiting_approval',
    taskIds: [],
    workspaceIds: [],
    branch: null,
    targetRef: null,
    workspaceId: null,
    steps: [],
    baseSha: null,
    headSha: null,
    approvalId: null,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    error: null,
    createdBy: HUMAN,
    createdAt: iso(T0),
    updatedAt: iso(T0),
    ...over,
  };
}

export function message(s: Session, over: Partial<Message> = {}): Message {
  return {
    id: id('msg'),
    sessionId: s.id,
    runId: null,
    role: 'user',
    content: [{ type: 'text', text: 'こんにちは' }],
    author: HUMAN,
    model: null,
    createdAt: iso(T0),
    delivery: 'delivered',
    meta: null,
    usage: null,
    ...over,
  };
}

let seq = 0;
export function event<T extends EventType>(
  type: T,
  payload: EventPayload<T>,
  over: Partial<Omit<EventOf<T>, 'type' | 'payload'>> = {},
): Event {
  seq++;
  return {
    seq,
    id: id('evt'),
    ts: iso(T0 + seq * 1000),
    actor: HUMAN,
    projectId: null,
    sessionId: null,
    runId: null,
    taskId: null,
    type,
    payload,
    ...over,
  } as Event;
}

/** An open attention item of a session (kind `question` unless given). */
export function attention(s: Pick<Session, 'id'> & { rootSessionId?: string }, over: Partial<Attention> = {}): Attention {
  return {
    id: id('att'),
    kind: 'question',
    status: 'open',
    sessionId: s.id,
    rootSessionId: s.rootSessionId ?? s.id,
    title: '価格を FAQ に載せてよいですか？',
    detail: null,
    choices: [],
    allowText: true,
    priority: 10,
    refs: {},
    resolution: null,
    createdAt: iso(T0),
    resolvedAt: null,
    ...over,
  };
}

/** A session as a home / tree card. */
export function card(over: Partial<SessionCard> = {}): SessionCard {
  return {
    id: id('ses'),
    parentId: null,
    depth: 0,
    title: 'カード',
    role: 'agent',
    state: 'working',
    stateSince: iso(T0),
    now: null,
    costUsd: 0,
    budget: null,
    outputs: [],
    attentionIds: [],
    startedBy: 'human',
    scheduleId: null,
    lastActivityAt: iso(T0),
    ...over,
  };
}

/** One home lane: a root card and its children. */
export function homeTree(root: SessionCard, nodes: SessionCard[] = [], over: Partial<HomeTree> = {}): HomeTree {
  return {
    root,
    nodes,
    hiddenNodes: 0,
    counts: { working: 0, queued: 0, needsYou: 0, failed: 0, review: 0, done: 0, stopped: 0 },
    spend: { treeUsd: 0, limitUsd: null, estimated: false },
    nextRunAt: null,
    projectId: null,
    ...over,
  };
}

/** A home.get snapshot. */
export function homeSnapshot(over: Partial<HomeSnapshot> = {}): HomeSnapshot {
  return {
    now: iso(T0),
    lastSeq: 0,
    totals: { working: 0, needsYou: over.attention?.length ?? 0, failed: 0, spendTodayUsd: 0, dailyLimitUsd: 20, estimated: false },
    attention: [],
    trees: [],
    upcoming: [],
    ...over,
  };
}
