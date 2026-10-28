import {
  Approval,
  Artifact,
  BudgetAllocation,
  CapabilityGrant,
  Integration,
  Message,
  Project,
  Run,
  Session,
  Task,
  Workspace,
} from '@acc/protocol';
import type { Db } from './db';
import { EntityRepo } from './repo';

/**
 * One repository per entity. Modules own the domain logic; repositories only persist.
 * Query with `find`/`page` using the indexed columns declared here; add a column (plus a
 * migration) when a new filter is needed.
 */
export function createRepos(db: Db) {
  return {
    projects: new EntityRepo<Project>(db, {
      table: 'projects',
      kind: 'project',
      schema: Project,
      columns: {
        name: (e) => e.name,
        archived_at: (e) => e.archivedAt,
        created_at: (e) => e.createdAt,
        updated_at: (e) => e.updatedAt,
      },
    }),
    workspaces: new EntityRepo<Workspace>(db, {
      table: 'workspaces',
      kind: 'workspace',
      schema: Workspace,
      columns: {
        project_id: (e) => e.projectId,
        task_id: (e) => e.taskId,
        status: (e) => e.status,
        locked_by_run_id: (e) => e.lockedByRunId,
        created_at: (e) => e.createdAt,
        updated_at: (e) => e.updatedAt,
      },
    }),
    sessions: new EntityRepo<Session>(db, {
      table: 'sessions',
      kind: 'session',
      schema: Session,
      columns: {
        project_id: (e) => e.projectId,
        kind: (e) => e.kind,
        task_id: (e) => e.taskId,
        parent_session_id: (e) => e.parentSessionId,
        archived_at: (e) => e.archivedAt,
        last_activity_at: (e) => e.lastActivityAt,
        created_at: (e) => e.createdAt,
        updated_at: (e) => e.updatedAt,
      },
    }),
    messages: new EntityRepo<Message>(db, {
      table: 'messages',
      kind: 'message',
      schema: Message,
      columns: {
        session_id: (e) => e.sessionId,
        run_id: (e) => e.runId,
        created_at: (e) => e.createdAt,
      },
    }),
    tasks: new EntityRepo<Task>(db, {
      table: 'tasks',
      kind: 'task',
      schema: Task,
      columns: {
        project_id: (e) => e.projectId,
        parent_task_id: (e) => e.parentTaskId,
        status: (e) => e.status,
        assignee_session_id: (e) => e.assigneeSessionId,
        created_at: (e) => e.createdAt,
        updated_at: (e) => e.updatedAt,
      },
    }),
    runs: new EntityRepo<Run>(db, {
      table: 'runs',
      kind: 'run',
      schema: Run,
      columns: {
        session_id: (e) => e.sessionId,
        project_id: (e) => e.projectId,
        task_id: (e) => e.taskId,
        kind: (e) => e.kind,
        status: (e) => e.status,
        parent_run_id: (e) => e.parentRunId,
        created_at: (e) => e.createdAt,
        updated_at: (e) => e.updatedAt,
      },
    }),
    artifacts: new EntityRepo<Artifact>(db, {
      table: 'artifacts',
      kind: 'artifact',
      schema: Artifact,
      columns: {
        kind: (e) => e.kind,
        project_id: (e) => e.projectId,
        session_id: (e) => e.sessionId,
        run_id: (e) => e.runId,
        task_id: (e) => e.taskId,
        created_at: (e) => e.createdAt,
      },
    }),
    integrations: new EntityRepo<Integration>(db, {
      table: 'integrations',
      kind: 'integration',
      schema: Integration,
      columns: {
        project_id: (e) => e.projectId,
        status: (e) => e.status,
        created_at: (e) => e.createdAt,
        updated_at: (e) => e.updatedAt,
      },
    }),
    approvals: new EntityRepo<Approval>(db, {
      table: 'approvals',
      kind: 'approval',
      schema: Approval,
      columns: {
        status: (e) => e.status,
        project_id: (e) => e.projectId,
        session_id: (e) => e.sessionId,
        run_id: (e) => e.runId,
        task_id: (e) => e.taskId,
        created_at: (e) => e.createdAt,
      },
    }),
    grants: new EntityRepo<CapabilityGrant>(db, {
      table: 'grants',
      kind: 'grant',
      schema: CapabilityGrant,
      columns: {
        subject_kind: (e) => e.subject.kind,
        subject_id: (e) => (e.subject.kind === 'run' ? e.subject.runId : e.subject.sessionId),
        parent_grant_id: (e) => e.parentGrantId,
        revoked_at: (e) => e.revokedAt,
        created_at: (e) => e.createdAt,
      },
    }),
    budgets: new EntityRepo<BudgetAllocation>(db, {
      table: 'budgets',
      kind: 'budget',
      schema: BudgetAllocation,
      columns: {
        parent_id: (e) => e.parentId,
        subject_kind: (e) => e.subject.kind,
        subject_id: (e) => e.subject.id,
        status: (e) => e.status,
        created_at: (e) => e.createdAt,
        updated_at: (e) => e.updatedAt,
      },
    }),
  };
}

export type Repos = ReturnType<typeof createRepos>;
