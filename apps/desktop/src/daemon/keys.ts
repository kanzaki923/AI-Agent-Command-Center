/**
 * Query keys. Collections are cached as plain arrays under fixed keys so the single event
 * subscription can patch them in place (see sync.ts); per-entity keys hold details.
 */
export const qk = {
  info: ['system.info'] as const,
  settings: ['settings.get'] as const,
  models: ['models.list'] as const,
  projects: ['project.list'] as const,
  sessions: ['session.list'] as const,
  runs: ['run.list'] as const,
  approvals: ['approval.list', 'pending'] as const,
  /** Approvals resolved during this UI session (for "承認しました · 14:03" lines). */
  resolvedApprovals: ['approval.list', 'resolved'] as const,
  tasks: ['task.list'] as const,
  integrations: ['integration.list'] as const,
  workspaces: ['workspace.list'] as const,
  messages: (sessionId: string) => ['session.messages', sessionId] as const,
  run: (runId: string) => ['run.get', runId] as const,
  workspace: (workspaceId: string) => ['workspace.get', workspaceId] as const,
  diff: (workspaceId: string) => ['workspace.diff', workspaceId] as const,
  artifacts: (sessionId: string, kind: string) => ['artifact.list', sessionId, kind] as const,
  /** Latest artifacts of one kind for a project (diff stats per task, test results). */
  projectArtifacts: (projectId: string, kind: string) =>
    ['artifact.list', 'project', projectId, kind] as const,
  artifact: (artifactId: string) => ['artifact.get', artifactId] as const,
  /** Grants of a session, including revoked ones (the chat shows when they ended). */
  grants: (sessionId: string) => ['grant.list', sessionId] as const,
  /** Budget nodes whose subject is a session (found via budget.updated events). */
  sessionBudgets: (sessionId: string) => ['budget.session', sessionId] as const,
  budget: (budgetId: string) => ['budget.get', budgetId] as const,
  eventHistory: ['events.history'] as const,
  /** Remembered tool approvals of a project (active ones). */
  permissionRules: (projectId: string) => ['permissionRule.list', projectId] as const,
  /** tool.decided history of a session, loaded into the event log (value: last seq). */
  toolDecisions: (sessionId: string) => ['events.toolDecisions', sessionId] as const,
};
