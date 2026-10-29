import type { Actor, Event, Run, Session } from '@acc/protocol';
import { RUN_STATUS_LABEL, TASK_STATUS_LABEL } from '../lib/status';
import { type ToolLookup, describeTool, outputText, shorten } from '../lib/tools';
import { INTEGRATION_STATUS_LABEL } from './integration';
import { DECIDER, PROFILE_INFO, describeDecision, firstSentence } from './permissions';

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
  | 'denied'
  | 'allowed'
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
  /** Second line (decision rationale, error head, why a call was refused). */
  detail: string | null;
  isError: boolean;
  isDecision: boolean;
  /**
   * Plumbing (lock changes, usage ticks, successful tool results, a status change that a
   * dedicated event repeats): hidden unless "詳細なイベントも表示" is on, so the default
   * Timeline reads like a story of who did what.
   */
  noise: boolean;
  /**
   * A routine automatic allow (not notable): hidden unless "自動許可も表示" (or every event)
   * is on. Blocks, asks and notable allows always show.
   */
  autoAllowed?: boolean;
  /** Who decided a tool use (`ルール` / `Auto mode` / `記憶` ...), shown as a badge. */
  decider?: { badge: string; tooltip: string };
  /** A tool use the daemon blocked (neutral left bar: noticeable, nothing to do). */
  blocked?: boolean;
}

/** Names the Timeline knows from the caches (session titles, task titles). */
export interface TimelineNames extends ToolLookup {
  sessionTitle?: (sessionId: string) => string | undefined;
}

/** `「設計チャット」が完了` reads naturally; `Run が完了` needs the space. */
function joinSubject(subject: string, verb: string): string {
  return subject.endsWith('」') ? `${subject}${verb}` : `${subject} ${verb}`;
}

/** One line of a message for the Timeline: fenced blocks (code, tool plans) drop out. */
function messageLine(text: string): string {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, ' ').trim();
  return prose ? shorten(prose, 120) : text.includes('```') ? '（コード）' : '';
}

function runSubject(e: Event, names: TimelineNames | undefined): string {
  const title = e.sessionId ? names?.sessionTitle?.(e.sessionId) : undefined;
  return title ? `「${shorten(title, 40)}」` : 'Run';
}

export function describeEvent(e: Event, names?: TimelineNames): EventView {
  const base = { detail: null, isError: false, isDecision: false, noise: false };
  switch (e.type) {
    case 'project.created':
      return { ...base, group: 'other', icon: 'project', label: 'プロジェクト', summary: `「${e.payload.project.name}」を追加` };
    case 'project.updated':
      return { ...base, group: 'other', icon: 'project', label: 'プロジェクト', summary: `「${e.payload.project.name}」の設定を変更` };
    case 'session.created': {
      const s = e.payload.session;
      return {
        ...base,
        group: 'run',
        icon: 'session',
        label: '作成',
        summary: `${s.kind === 'agent' ? 'エージェント' : 'チャット'}「${s.title || '無題'}」を作成`,
      };
    }
    case 'session.updated':
      return {
        ...base,
        group: 'other',
        icon: 'session',
        label: 'セッション',
        summary: `更新（${e.payload.changes.join(', ')}）`,
        // Title / pin changes are the human's; the rest is bookkeeping.
        noise: !e.payload.changes.some((c) => c === 'title' || c === 'pinned' || c === 'model'),
      };
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
        label: m.role === 'user' ? (m.author.kind === 'agent' ? '指示' : 'メッセージ') : m.role === 'assistant' ? '応答' : 'メッセージ',
        summary: text ? messageLine(text) || '（コード）' : calls > 0 ? `ツール呼び出し ${calls} 件` : '（内容なし）',
        // Tool results are messages too; the tool rows already tell that part.
        noise: m.role === 'tool' || (!text && calls > 0),
      };
    }
    case 'run.created':
      return {
        ...base,
        group: 'run',
        icon: 'run',
        label: 'Run 作成',
        summary: `${runSubject(e, names)} の Run を作成${e.payload.run.model ? ` · ${e.payload.run.model}` : ''}`,
        noise: true,
      };
    case 'run.status_changed': {
      const { from, to, reason } = e.payload;
      const label = to === 'running' ? (from === 'awaiting_approval' ? '再開' : '開始') : RUN_STATUS_LABEL[to];
      const subject = runSubject(e, names);
      const verb =
        to === 'running'
          ? from === 'awaiting_approval'
            ? 'が作業を再開'
            : 'が作業を開始'
          : to === 'awaiting_approval'
            ? 'があなたの承認を待っています'
            : to === 'queued'
              ? 'は同時実行の空きを待っています'
              : `が${RUN_STATUS_LABEL[to]}になりました`;
      return {
        ...base,
        group: to === 'failed' ? 'error' : 'run',
        icon: to === 'running' ? 'start' : to === 'failed' ? 'fail' : to === 'completed' ? 'done' : 'run',
        label,
        summary: `${joinSubject(subject, verb)}${reason && to !== 'failed' ? `（${reason}）` : ''}`,
        isError: to === 'failed',
        // run.completed / run.failed say the same with more detail; approval rows say
        // "waiting"; queued → running is a blink unless the run really waits.
        noise:
          to === 'completed' ||
          to === 'failed' ||
          to === 'awaiting_approval' ||
          to === 'created' ||
          (to === 'queued' && from === 'created'),
      };
    }
    case 'run.updated': {
      const r = e.payload.run;
      if (e.payload.changes.includes('activity')) {
        return { ...base, group: 'run', icon: 'run', label: '状況', summary: r.activity ?? '（なし）', noise: true };
      }
      return {
        ...base,
        group: 'budget',
        icon: 'budget',
        label: '使用量',
        summary: `$${r.usage.costUsd.toFixed(2)} · 入力 ${r.usage.inputTokens} / 出力 ${r.usage.outputTokens} トークン`,
        noise: true,
      };
    }
    case 'run.completed':
      return { ...base, group: 'run', icon: 'done', label: '完了', summary: joinSubject(runSubject(e, names), 'が完了しました') };
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
      const d = describeTool(e.payload.name, e.payload.input, names);
      return { ...base, group: 'tool', icon: d.category === 'control' ? 'task' : 'tool', label: 'ツール', summary: d.label };
    }
    case 'tool.result': {
      const out = outputText(e.payload.output);
      return {
        ...base,
        group: e.payload.isError ? 'error' : 'tool',
        icon: e.payload.isError ? 'fail' : 'tool',
        label: e.payload.isError ? 'ツール失敗' : 'ツール結果',
        summary: `${describeTool(e.payload.name, {}, names).label}${out ? ` · ${shorten(out, 100)}` : ''}`,
        isError: e.payload.isError,
        noise: !e.payload.isError,
      };
    }
    case 'tool.decided': {
      const d = e.payload;
      const v = describeDecision(d);
      const what = d.summary ? shorten(d.summary, 100) : describeTool(d.toolName, {}, names).label;
      return {
        ...base,
        group: d.decision === 'asked' ? 'approval' : 'grant',
        icon: v.tone === 'blocked' ? 'denied' : v.tone === 'asked' ? 'approval' : 'allowed',
        label: v.label,
        summary: what,
        detail: v.tone === 'allowed' ? null : v.reason,
        decider: { badge: DECIDER[d.decidedBy].badge, tooltip: `${v.deciderTooltip}（${PROFILE_INFO[d.profile].label}）` },
        blocked: v.tone === 'blocked',
        autoAllowed: v.tone === 'allowed' && !d.notable,
        // An ask is told by its approval.requested row (which carries the same reason).
        noise: v.tone === 'asked',
      };
    }
    case 'permission.rule_created':
    case 'permission.rule_revoked':
      return {
        ...base,
        group: 'grant',
        icon: 'grant',
        label: e.type === 'permission.rule_created' ? '許可を記憶' : '記憶を取り消し',
        summary: e.payload.rule.description,
      };
    case 'approval.requested': {
      // Approvals are the exception: the second line says why this one was not decided.
      const reason = (e.payload.approval.payload as { reason?: unknown } | null)?.reason;
      return {
        ...base,
        group: 'approval',
        icon: 'approval',
        label: '承認を要求',
        summary: e.payload.approval.title,
        detail: typeof reason === 'string' ? firstSentence(reason) : null,
      };
    }
    case 'approval.resolved': {
      const a = e.payload.approval;
      return {
        ...base,
        group: 'approval',
        icon: 'human',
        label: a.status === 'approved' ? '承認' : a.status === 'rejected' ? '拒否' : '取消',
        summary: a.title,
        detail: a.resolutionNote ? `メモ: ${a.resolutionNote}` : null,
      };
    }
    case 'task.created':
      return { ...base, group: 'task', icon: 'task', label: 'Task 作成', summary: e.payload.task.title };
    case 'task.updated': {
      const t = e.payload.task;
      const statusChanged = e.payload.changes.includes('status');
      return {
        ...base,
        group: 'task',
        icon: 'task',
        label: statusChanged ? TASK_STATUS_LABEL[t.status] : 'Task 更新',
        summary: statusChanged ? `「${t.title}」→ ${TASK_STATUS_LABEL[t.status]}` : `「${t.title}」（${e.payload.changes.join(', ')}）`,
        detail: statusChanged && t.status === 'review' && t.resultSummary ? t.resultSummary : null,
        noise: !statusChanged,
      };
    }
    case 'workspace.created':
      return { ...base, group: 'integration', icon: 'workspace', label: 'worktree', summary: `作成 ${e.payload.workspace.branch ?? e.payload.workspace.path}` };
    case 'workspace.updated':
      return { ...base, group: 'other', icon: 'workspace', label: 'worktree', summary: `更新（${e.payload.changes.join(', ')}）`, noise: true };
    case 'workspace.removed':
      return { ...base, group: 'other', icon: 'workspace', label: 'worktree', summary: '削除' };
    case 'artifact.created':
      return { ...base, group: 'other', icon: 'artifact', label: '成果物', summary: e.payload.artifact.title };
    case 'integration.created':
      return { ...base, group: 'integration', icon: 'integration', label: '統合', summary: `作成 ${e.payload.integration.title}` };
    case 'integration.updated': {
      const i = e.payload.integration;
      return {
        ...base,
        group: i.status === 'failed' || i.status === 'conflict' ? 'error' : 'integration',
        icon: 'integration',
        label: `統合 · ${INTEGRATION_STATUS_LABEL[i.status]}`,
        summary: i.title,
        detail: i.error ? shorten(i.error.message, 160) : null,
        isError: i.status === 'failed' || i.status === 'conflict',
        // Step progress ticks repeat the same status; only the status changes tell the story.
        noise: !e.payload.changes.includes('status'),
      };
    }
    case 'grant.created':
      return {
        ...base,
        group: 'grant',
        icon: 'grant',
        label: '権限付与',
        summary: shorten(e.payload.grant.reason ?? e.payload.grant.permissions.join(', '), 120),
        detail: e.payload.grant.reason ? shorten(e.payload.grant.permissions.join(', '), 160) : null,
      };
    case 'grant.revoked':
      return { ...base, group: 'grant', icon: 'grant', label: '権限の終了', summary: e.payload.reason ?? '権限を取り消しました' };
    case 'policy.denied':
      return {
        ...base,
        group: 'grant',
        icon: 'denied',
        label: '権限で拒否',
        summary: `「${e.payload.permission}」を試みましたが、許可されていないため止めました`,
        detail: e.payload.reason,
        isError: true,
      };
    case 'budget.updated':
      return {
        ...base,
        group: 'budget',
        icon: 'budget',
        label: '予算',
        summary: `$${e.payload.budget.spentUsd.toFixed(2)} / $${e.payload.budget.limitUsd.toFixed(2)}${e.payload.reason ? ` · ${e.payload.reason}` : ''}`,
        noise: !e.payload.reason,
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
        noise: false,
      };
    case 'settings.updated':
      return { ...base, group: 'other', icon: 'settings', label: '設定', summary: `更新（${e.payload.changes.join(', ')}）` };
    // Session-tree redesign events: the UI phase gives them their own views (spec 20261029 §6.1).
    case 'message.updated':
    case 'inbox.added':
    case 'inbox.consumed':
    case 'artifact.updated':
    case 'attention.opened':
    case 'attention.resolved':
    case 'session.cost_updated':
    case 'budget.threshold':
    case 'cost.limit_reached':
    case 'schedule.created':
    case 'schedule.updated':
    case 'schedule.deleted':
    case 'schedule.fired':
    case 'session.state_changed':
    case 'session.now_changed':
      return { ...base, group: 'other', icon: 'settings', label: '更新', summary: e.type, noise: true };
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

/** Where Enter / 「開く」 on an event takes you (jump to its context). */
export type EventContext =
  | { kind: 'message'; sessionId: string; messageId: string; label: string }
  | { kind: 'session'; sessionId: string; label: string }
  | { kind: 'task'; taskId: string; label: string }
  | { kind: 'integration'; integrationId: string; label: string };

export function eventContext(e: Event): EventContext | null {
  switch (e.type) {
    case 'message.created':
      return { kind: 'message', sessionId: e.payload.message.sessionId, messageId: e.payload.message.id, label: '会話を開く' };
    case 'task.created':
    case 'task.updated':
      return { kind: 'task', taskId: e.payload.task.id, label: 'Task を開く' };
    case 'integration.created':
    case 'integration.updated':
      return { kind: 'integration', integrationId: e.payload.integration.id, label: '統合を開く' };
    case 'approval.requested':
    case 'approval.resolved':
      if (e.payload.approval.integrationId)
        return { kind: 'integration', integrationId: e.payload.approval.integrationId, label: '統合を開く' };
      return e.sessionId ? { kind: 'session', sessionId: e.sessionId, label: '承認の場所を開く' } : null;
    default:
      if (e.type === 'orchestrator.decision' && e.payload.refs?.taskIds?.[0] && !e.sessionId)
        return { kind: 'task', taskId: e.payload.refs.taskIds[0], label: 'Task を開く' };
      return e.sessionId ? { kind: 'session', sessionId: e.sessionId, label: 'セッションを開く' } : null;
  }
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
      /** Time since the previous shown event (the pause between two steps), ms. */
      gapMs: number | null;
    }
  | {
      kind: 'run';
      key: string;
      runId: string;
      run: Run | null;
      count: number;
      /** Blocked tool uses in this segment (kept visible on a folded run). */
      blocked: number;
      collapsed: boolean;
      header: number;
    };

/** Run id of a run-header row key (`r<runId>:<firstSeq>`). */
export function runIdOfKey(key: string): string | null {
  return key.startsWith('r') ? (key.slice(1).split(':')[0] ?? null) : null;
}

/** `+0.8s` is not worth a glance; pauses from a second up are. */
export const GAP_SHOWN_MS = 1000;

/** `+3.2s`, `+42s`, `+3分`, `+1時間12分` — the pause before a step. */
export function formatGap(ms: number | null): string | null {
  if (ms == null || ms < GAP_SHOWN_MS) return null;
  if (ms < 10_000) return `+${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `+${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `+${Math.round(ms / 60_000)}分`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return m ? `+${h}時間${m}分` : `+${h}時間`;
}

/**
 * Flatten events into rows, newest last. With `groupByRun`, consecutive events of one run
 * form a segment under a run header, so the stream stays chronological when runs
 * interleave. A lone event of a run that already had a header is shown inline with a run
 * tag instead of repeating the header (parallel runs would otherwise produce a header per
 * line). Ended runs start collapsed unless toggled. Plumbing events (`EventView.noise`) are
 * left out unless `showAll`.
 */
export function buildTimelineRows(input: {
  events: readonly Event[];
  filters: TimelineFilters;
  groupByRun: boolean;
  runs: Map<string, Run>;
  /** Explicit expand/collapse choices by run id (true = collapsed). */
  toggled: Record<string, boolean>;
  showAll?: boolean;
  /** Also routine automatic allows (tool.decided), without the rest of the plumbing. */
  showAutoAllowed?: boolean;
  names?: TimelineNames;
}): TimelineRow[] {
  type Seg = { runId: string | null; items: { e: Event; v: EventView }[] };
  const segs: Seg[] = [];
  for (const e of input.events) {
    const v = describeEvent(e, input.names);
    if (v.noise && !input.showAll) continue;
    if (v.autoAllowed && !input.showAll && !input.showAutoAllowed) continue;
    if (!matchesFilters(e, v, input.filters)) continue;
    const runId = input.groupByRun ? e.runId : null;
    const last = segs[segs.length - 1];
    if (runId && last?.runId === runId) last.items.push({ e, v });
    else segs.push({ runId, items: [{ e, v }] });
  }

  const rows: TimelineRow[] = [];
  const seen = new Set<string>();
  let prevTs: number | null = null;
  const eventRow = (e: Event, v: EventView, header: number, runTag: string | null): TimelineRow => {
    const ts = Date.parse(e.ts);
    const gapMs = prevTs == null || Number.isNaN(ts) ? null : Math.max(0, ts - prevTs);
    prevTs = Number.isNaN(ts) ? prevTs : ts;
    return { kind: 'event', key: `e${e.seq}`, event: e, view: v, inRun: header !== -1, header, runTag, gapMs };
  };
  for (const seg of segs) {
    if (!seg.runId) {
      for (const { e, v } of seg.items) rows.push(eventRow(e, v, -1, null));
      continue;
    }
    const run = input.runs.get(seg.runId) ?? null;
    const ended = run ? ['completed', 'cancelled'].includes(run.status) : false;
    // A run the filters single out is what the reader came for: open even when it ended.
    const collapsed = input.toggled[seg.runId] ?? (ended && input.filters.runId !== seg.runId);
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
      blocked: seg.items.filter((x) => x.v.blocked).length,
      collapsed,
      header,
    });
    if (!collapsed) for (const { e, v } of seg.items) rows.push(eventRow(e, v, header, null));
    else {
      // The pause after a folded run is measured from its last event.
      const lastTs = Date.parse(seg.items[seg.items.length - 1]!.e.ts);
      if (!Number.isNaN(lastTs)) prevTs = lastTs;
    }
  }
  return rows;
}
