import type { Actor, ContentPart, Event, Session, SystemInfo } from '@acc/protocol';

function time(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function dateTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

export function formatActor(a: Actor): string {
  switch (a.kind) {
    case 'human':
      return a.client ? `human(${a.client})` : 'human';
    case 'agent':
      return `agent(${a.runId})`;
    case 'system':
      return a.component ? `system(${a.component})` : 'system';
  }
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}時間${m}分`;
  if (m > 0) return `${m}分${s % 60}秒`;
  return `${s}秒`;
}

function textOf(content: ContentPart[]): string {
  return content
    .map((p) => (p.type === 'text' ? p.text : p.type === 'tool_call' ? `[tool:${p.name}]` : ''))
    .filter(Boolean)
    .join(' ');
}

/** One-line human summary of an event payload. */
export function summarizeEvent(e: Event): string {
  switch (e.type) {
    case 'project.created':
      return e.payload.project.name;
    case 'project.updated':
    case 'session.updated':
    case 'task.updated':
    case 'workspace.updated':
    case 'integration.updated':
    case 'settings.updated':
      return `changed: ${e.payload.changes.join(', ') || '-'}`;
    case 'session.created':
      return `${e.payload.session.kind} "${e.payload.session.title || '(無題)'}"`;
    case 'session.archived':
      return e.payload.archived ? 'archived' : 'restored';
    case 'message.created':
      return `${e.payload.message.role}: ${truncate(textOf(e.payload.message.content), 80)}`;
    case 'run.created':
      return `${e.payload.run.kind} run`;
    case 'run.status_changed':
      return `${e.payload.from} → ${e.payload.to}${e.payload.reason ? ` (${e.payload.reason})` : ''}`;
    case 'run.updated':
      return e.payload.changes.includes('activity') && e.payload.run.activity
        ? truncate(e.payload.run.activity, 80)
        : `changed: ${e.payload.changes.join(', ') || '-'}`;
    case 'run.completed':
      return `usage in=${e.payload.run.usage.inputTokens} out=${e.payload.run.usage.outputTokens}`;
    case 'run.failed':
      return `${e.payload.error.code}: ${truncate(e.payload.error.message, 80)}`;
    case 'tool.called':
      return e.payload.name;
    case 'tool.result':
      return `${e.payload.name}${e.payload.isError ? ' (error)' : ''}`;
    case 'approval.requested':
    case 'approval.resolved':
      return `${e.payload.approval.status}: ${truncate(e.payload.approval.title, 60)}`;
    case 'task.created':
      return truncate(e.payload.task.title, 80);
    case 'workspace.created':
      return e.payload.workspace.branch ?? e.payload.workspace.path;
    case 'workspace.removed':
      return e.payload.workspaceId;
    case 'artifact.created':
      return `${e.payload.artifact.kind}: ${truncate(e.payload.artifact.title, 60)}`;
    case 'integration.created':
      return truncate(e.payload.integration.title, 80);
    case 'grant.created':
      return e.payload.grant.permissions.join(',');
    case 'grant.revoked':
      return e.payload.grantId;
    case 'policy.denied':
      return `${e.payload.permission}: ${truncate(e.payload.reason, 80)}`;
    case 'budget.updated':
      return `$${e.payload.budget.spentUsd.toFixed(2)} / $${e.payload.budget.limitUsd.toFixed(2)}`;
    case 'orchestrator.decision':
      return truncate(e.payload.decision, 80);
  }
}

export function formatEvent(e: Event): string {
  const ref = e.runId ?? e.sessionId ?? e.taskId ?? e.projectId ?? '';
  return `#${e.seq} ${time(e.ts)} ${e.type.padEnd(20)} ${summarizeEvent(e)}${ref ? `  ${ref}` : ''}  [${formatActor(e.actor)}]`;
}

export function formatSession(s: Session): string {
  const flags = [s.pinned ? '★' : ' ', s.activeRunId ? '●' : ' ', s.archivedAt ? 'A' : ' '].join(
    '',
  );
  const title = s.title || '(無題)';
  return `${flags} ${s.id}  ${dateTime(s.lastActivityAt)}  ${s.kind.padEnd(5)}  ${truncate(title, 50)}${s.model ? `  (${s.model})` : ''}`;
}

export function formatStatus(info: SystemInfo, uptimeMs: number): string {
  return [
    `Core Daemon ${info.version}  稼働中`,
    `  ポート      ${info.port}`,
    `  PID         ${info.pid}`,
    `  稼働時間    ${formatDuration(uptimeMs)}`,
    `  データ      ${info.dataDir}`,
    `  プロジェクト ${info.stats.projects}  セッション ${info.stats.sessions}  実行中 ${info.stats.activeRuns}`,
    `  イベント    #${info.stats.lastEventSeq}`,
    `  API         ${info.methods.length} メソッド実装済み`,
  ].join('\n');
}
