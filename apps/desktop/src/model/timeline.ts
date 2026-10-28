import type { Actor, Event, Run, Session } from '@acc/protocol';
import { RUN_STATUS_LABEL, TASK_STATUS_LABEL } from '../lib/status';
import { describeTool, outputText, shorten } from '../lib/tools';

export type EventGroup =
  | 'run'
  | 'task'
  | 'tool'
  | 'approval'
  | 'error'
  | 'integration'
  | 'budget'
  | 'grant'
  | 'decision'
  | 'other';

export const EVENT_GROUP_LABEL: Record<EventGroup, string> = {
  run: 'Run',
  task: 'Task',
  tool: 'ツール',
  approval: '承認',
  error: 'エラー',
  integration: '統合',
  budget: '予算',
  grant: '権限',
  decision: '判断',
  other: 'その他',
};
export const EVENT_GROUPS = Object.keys(EVENT_GROUP_LABEL) as EventGroup[];

export type ActorKind = Actor['kind'];
export const ACTOR_LABEL: Record<ActorKind, string> = { human: 'あなた', agent: 'AI', system: 'システム' };

export type EventIcon =
  | 'run'
  | 'start'
  | 'done'
  | 'fail'
  | 'tool'
  | 'approval'
  | 'human'
  | 'task'
  | 'decision'
  | 'integration'
  | 'budget'
  | 'grant'
  | 'message'
  | 'workspace'
  | 'artifact'
  | 'settings'
  | 'project'
  | 'session';

export interface EventView {
  group: EventGroup;
  icon: EventIcon;
  /** Short label column (120px): `判断`, `ツール`, `承認を要求` ... */
  label: string;
  /** Target + summary (rest of the row). */
  summary: string;
  /** Second line (decision rationale, error head). */
  detail: string | null;
  isError: boolean;
  isDecision: boolean;
}

export function describeEvent(e: Event): EventView {
  const base = { detail: null, isError: false, isDecision: false };
  switch (e.type) {
    case 'project.created':
      return { ...base, group: 'other', icon: 'project', label: 'プロジェクト', summary: `作成 ${e.payload.project.name}` };
    case 'project.updated':
      return { ...base, group: 'other', icon: 'project', label: 'プロジェクト', summary: `更新 ${e.payload.project.name}` };
    case 'session.created':
      return {
        ...base,
        group: 'run',
        icon: 'session',
        label: '作成',
        summary: `${e.payload.session.kind === 'agent' ? 'エージェント' : 'チャット'} · ${e.payload.session.title || '無題'}`,
      };
    case 'session.updated':
      return { ...base, group: 'other', icon: 'session', label: 'セッション', summary: `更新（${e.payload.changes.join(', ')}）` };
    case 'session.archived':
      return { ...base, group: 'other', icon: 'session', label: 'セッション', summary: e.payload.archived ? 'アーカイブ' : '復元' };
    case 'message.created': {
      const m = e.payload.message;
      const text = m.content.find((p) => p.type === 'text')?.text ?? '';
      const calls = m.content.filter((p) => p.type === 'tool_call').length;
      return {
        ...base,
        group: 'other',
        icon: 'message',
        label: m.role === 'user' ? 'メッセージ' : m.role === 'assistant' ? '応答' : 'メッセージ',
        summary: text ? shorten(text, 120) : calls > 0 ? `ツール呼び出し ${calls} 件` : '（内容なし）',
      };
    }
    case 'run.created':
      return { ...base, group: 'run', icon: 'run', label: 'Run 作成', summary: `${e.payload.run.kind} · ${e.payload.run.model ?? ''}` };
    case 'run.status_changed': {
      const to = e.payload.to;
      const label = to === 'running' ? '開始' : RUN_STATUS_LABEL[to];
      return {
        ...base,
        group: to === 'failed' ? 'error' : 'run',
        icon: to === 'running' ? 'start' : to === 'failed' ? 'fail' : to === 'completed' ? 'done' : 'run',
        label,
        summary: `${RUN_STATUS_LABEL[e.payload.from]} → ${RUN_STATUS_LABEL[to]}${e.payload.reason ? `（${e.payload.reason}）` : ''}`,
        isError: to === 'failed',
      };
    }
    case 'run.completed':
      return { ...base, group: 'run', icon: 'done', label: '完了', summary: `Run が完了しました` };
    case 'run.failed':
      return {
        ...base,
        group: 'error',
        icon: 'fail',
        label: '失敗',
        summary: shorten(e.payload.error.message.split('\n')[0] ?? '', 120),
        detail: e.payload.error.message.split('\n').slice(1, 3).join(' ') || null,
        isError: true,
      };
    case 'tool.called': {
      const d = describeTool(e.payload.name, e.payload.input);
      return { ...base, group: 'tool', icon: 'tool', label: 'ツール', summary: d.label };
    }
    case 'tool.result': {
      const out = outputText(e.payload.output);
      return {
        ...base,
        group: e.payload.isError ? 'error' : 'tool',
        icon: e.payload.isError ? 'fail' : 'tool',
        label: e.payload.isError ? 'ツール失敗' : 'ツール結果',
        summary: `${e.payload.name}${out ? ` · ${shorten(out, 100)}` : ''}`,
        isError: e.payload.isError,
      };
    }
    case 'approval.requested':
      return { ...base, group: 'approval', icon: 'approval', label: '承認を要求', summary: e.payload.approval.title };
    case 'approval.resolved':
      return {
        ...base,
        group: 'approval',
        icon: 'human',
        label: e.payload.approval.status === 'approved' ? '承認' : e.payload.approval.status === 'rejected' ? '拒否' : '取消',
        summary: e.payload.approval.title,
      };
    case 'task.created':
      return { ...base, group: 'task', icon: 'task', label: 'Task 作成', summary: e.payload.task.title };
    case 'task.updated':
      return {
        ...base,
        group: 'task',
        icon: 'task',
        label: TASK_STATUS_LABEL[e.payload.task.status],
        summary: e.payload.task.title,
      };
    case 'workspace.created':
      return { ...base, group: 'integration', icon: 'workspace', label: 'worktree', summary: `作成 ${e.payload.workspace.branch ?? e.payload.workspace.path}` };
    case 'workspace.updated':
      return { ...base, group: 'other', icon: 'workspace', label: 'worktree', summary: `更新（${e.payload.changes.join(', ')}）` };
    case 'workspace.removed':
      return { ...base, group: 'other', icon: 'workspace', label: 'worktree', summary: '削除' };
    case 'artifact.created':
      return { ...base, group: 'other', icon: 'artifact', label: '成果物', summary: e.payload.artifact.title };
    case 'integration.created':
      return { ...base, group: 'integration', icon: 'integration', label: '統合', summary: `作成 ${e.payload.integration.title}` };
    case 'integration.updated':
      return {
        ...base,
        group: e.payload.integration.status === 'failed' ? 'error' : 'integration',
        icon: 'integration',
        label: '統合',
        summary: `${e.payload.integration.title} · ${e.payload.integration.status}`,
        isError: e.payload.integration.status === 'failed',
      };
    case 'grant.created':
      return { ...base, group: 'grant', icon: 'grant', label: '権限付与', summary: e.payload.grant.permissions.join(', ') };
    case 'grant.revoked':
      return { ...base, group: 'grant', icon: 'grant', label: '権限剥奪', summary: e.payload.reason ?? '' };
    case 'budget.updated':
      return {
        ...base,
        group: 'budget',
        icon: 'budget',
        label: '予算',
        summary: `$${e.payload.budget.spentUsd.toFixed(2)} / $${e.payload.budget.limitUsd.toFixed(2)}${e.payload.reason ? ` · ${e.payload.reason}` : ''}`,
      };
    case 'orchestrator.decision':
      return {
        group: 'decision',
        icon: 'decision',
        label: '判断',
        summary: e.payload.decision,
        detail: e.payload.rationale,
        isError: false,
        isDecision: true,
      };
    case 'settings.updated':
      return { ...base, group: 'other', icon: 'settings', label: '設定', summary: `更新（${e.payload.changes.join(', ')}）` };
  }
}

export function actorName(actor: Actor, sessions: Map<string, Session>, runs: Map<string, Run>): string {
  if (actor.kind === 'human') return 'あなた';
  if (actor.kind === 'system') return 'システム';
  const run = runs.get(actor.runId);
  const s = sessions.get(actor.sessionId);
  const role = run?.kind === 'orchestrator' ? 'Orchestrator' : s?.kind === 'chat' ? 'チャット' : 'Worker';
  return role;
}

export interface TimelineFilters {
  groups: EventGroup[];
  actors: ActorKind[];
  sessionId: string | null;
  runId: string | null;
  text: string;
}

export const EMPTY_FILTERS: TimelineFilters = { groups: [], actors: [], sessionId: null, runId: null, text: '' };

export function filtersActive(f: TimelineFilters): boolean {
  return f.groups.length > 0 || f.actors.length > 0 || !!f.sessionId || !!f.runId || !!f.text.trim();
}

export function matchesFilters(e: Event, v: EventView, f: TimelineFilters): boolean {
  if (f.groups.length > 0 && !f.groups.includes(v.group)) return false;
  if (f.actors.length > 0 && !f.actors.includes(e.actor.kind)) return false;
  if (f.sessionId && e.sessionId !== f.sessionId) return false;
  if (f.runId && e.runId !== f.runId) return false;
  const q = f.text.trim().toLowerCase();
  if (q && !`${v.label} ${v.summary} ${v.detail ?? ''} ${e.type}`.toLowerCase().includes(q)) return false;
  return true;
}

export type TimelineRow =
  | {
      kind: 'event';
      key: string;
      event: Event;
      view: EventView;
      inRun: boolean;
      /** Index of the run header row this event sits under, or -1. */
      header: number;
      /** Short run id shown inline when a lone event of a known run is not grouped. */
      runTag: string | null;
    }
  | {
      kind: 'run';
      key: string;
      runId: string;
      run: Run | null;
      count: number;
      collapsed: boolean;
      header: number;
    };

/** Run id of a run-header row key (`r<runId>:<firstSeq>`). */
export function runIdOfKey(key: string): string | null {
  return key.startsWith('r') ? (key.slice(1).split(':')[0] ?? null) : null;
}

/**
 * Flatten events into rows, newest last. With `groupByRun`, consecutive events of one run
 * form a segment under a run header, so the stream stays chronological when runs
 * interleave. A lone event of a run that already had a header is shown inline with a run
 * tag instead of repeating the header (parallel runs would otherwise produce a header per
 * line). Ended runs start collapsed unless toggled.
 */
export function buildTimelineRows(input: {
  events: readonly Event[];
  filters: TimelineFilters;
  groupByRun: boolean;
  runs: Map<string, Run>;
  /** Explicit expand/collapse choices by run id (true = collapsed). */
  toggled: Record<string, boolean>;
}): TimelineRow[] {
  type Seg = { runId: string | null; items: { e: Event; v: EventView }[] };
  const segs: Seg[] = [];
  for (const e of input.events) {
    const v = describeEvent(e);
    if (!matchesFilters(e, v, input.filters)) continue;
    const runId = input.groupByRun ? e.runId : null;
    const last = segs[segs.length - 1];
    if (runId && last?.runId === runId) last.items.push({ e, v });
    else segs.push({ runId, items: [{ e, v }] });
  }

  const rows: TimelineRow[] = [];
  const seen = new Set<string>();
  const eventRow = (e: Event, v: EventView, header: number, runTag: string | null): TimelineRow => ({
    kind: 'event',
    key: `e${e.seq}`,
    event: e,
    view: v,
    inRun: header !== -1,
    header,
    runTag,
  });
  for (const seg of segs) {
    if (!seg.runId) {
      for (const { e, v } of seg.items) rows.push(eventRow(e, v, -1, null));
      continue;
    }
    const run = input.runs.get(seg.runId) ?? null;
    const ended = run ? ['completed', 'cancelled'].includes(run.status) : false;
    const collapsed = input.toggled[seg.runId] ?? ended;
    if (seg.items.length === 1 && seen.has(seg.runId) && !collapsed) {
      const { e, v } = seg.items[0]!;
      rows.push(eventRow(e, v, -1, seg.runId));
      continue;
    }
    seen.add(seg.runId);
    const header = rows.length;
    rows.push({
      kind: 'run',
      key: `r${seg.runId}:${seg.items[0]!.e.seq}`,
      runId: seg.runId,
      run,
      count: seg.items.length,
      collapsed,
      header,
    });
    if (!collapsed) for (const { e, v } of seg.items) rows.push(eventRow(e, v, header, null));
  }
  return rows;
}
