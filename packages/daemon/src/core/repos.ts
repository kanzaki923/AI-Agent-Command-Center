import {
  Approval,
  Artifact,
  Attention,
  BudgetAllocation,
  CapabilityGrant,
  InboxItem,
  Integration,
  Message,
  Project,
  Run,
  Schedule,
  Session,
  Task,
  Workspace,
} from '@acc/protocol';
import type { z } from 'zod';
import type { Db } from './db';
import { EntityRepo } from './repo';

/**
 * One repository per entity. Modules own the domain logic; repositories only persist.
 * Query with `find`/`page` using the indexed columns declared here; add a column (plus a
 * migration) when a new filter is needed.
 */
export function createRepos(db: Db) {
  return {
    projects: new EntityRepo<Project, z.input<typeof Project>>(db, {
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
    workspaces: new EntityRepo<Workspace, z.input<typeof Workspace>>(db, {
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
    sessions: new EntityRepo<Session, z.input<typeof Session>>(db, {
      table: 'sessions',
      kind: 'session',
      schema: Session,
      columns: {
        project_id: (e) => e.projectId,
        kind: (e) => e.kind,
        task_id: (e) => e.taskId,
        parent_session_id: (e) => e.parentSessionId,
        root_session_id: (e) => e.rootSessionId,
        state: (e) => e.state,
        archived_at: (e) => e.archivedAt,
        last_activity_at: (e) => e.lastActivityAt,
        created_at: (e) => e.createdAt,
        updated_at: (e) => e.updatedAt,
      },
    }),
    messages: new EntityRepo<Message, z.input<typeof Message>>(db, {
      table: 'messages',
      kind: 'message',
      schema: Message,
      columns: {
        session_id: (e) => e.sessionId,
        run_id: (e) => e.runId,
        created_at: (e) => e.createdAt,
      },
    }),
    tasks: new EntityRepo<Task, z.input<typeof Task>>(db, {
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
    runs: new EntityRepo<Run, z.input<typeof Run>>(db, {
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
    artifacts: new EntityRepo<Artifact, z.input<typeof Artifact>>(db, {
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
    integrations: new EntityRepo<Integration, z.input<typeof Integration>>(db, {
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
    approvals: new EntityRepo<Approval, z.input<typeof Approval>>(db, {
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
    grants: new EntityRepo<CapabilityGrant, z.input<typeof CapabilityGrant>>(db, {
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
    budgets: new EntityRepo<BudgetAllocation, z.input<typeof BudgetAllocation>>(db, {
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
    // Tables of the redesign modules (their migrations live in those modules).
    inboxItems: new EntityRepo<InboxItem, z.input<typeof InboxItem>>(db, {
      table: 'inbox_items',
      kind: 'inbox item',
      schema: InboxItem,
      columns: {
        session_id: (e) => e.sessionId,
        kind: (e) => e.kind,
        status: (e) => e.status,
        consumed_by_run_id: (e) => e.consumedByRunId,
        created_at: (e) => e.createdAt,
      },
    }),
    attention: new EntityRepo<Attention, z.input<typeof Attention>>(db, {
      table: 'attention',
      kind: 'attention',
      schema: Attention,
      columns: {
        kind: (e) => e.kind,
        status: (e) => e.status,
        session_id: (e) => e.sessionId,
        root_session_id: (e) => e.rootSessionId,
        priority: (e) => e.priority,
        created_at: (e) => e.createdAt,
      },
    }),
    schedules: new EntityRepo<Schedule, z.input<typeof Schedule>>(db, {
      table: 'schedules',
      kind: 'schedule',
      schema: Schedule,
      columns: {
        session_id: (e) => e.sessionId,
        enabled: (e) => e.enabled,
        next_run_at: (e) => e.nextRunAt,
        created_at: (e) => e.createdAt,
      },
    }),
  };
}

export type Repos = ReturnType<typeof createRepos>;
