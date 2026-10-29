/**
 * T2 Spawn: children, workplaces, completion (spec 20261029 §2.2, §3.3, §3.4).
 * Schemas are fixed by the Core track; T2 implements them.
 */
import { z } from 'zod';
import { BudgetId, ProjectId, RunId, SessionId } from '../common';
import { PermissionPattern, ReviewBy, Session, WorkspaceSpec } from '../domain';
import { type MethodDef, params } from '../method';

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** `chat`: an ordinary conversation. `agent`: works on its own (Agent Runtime). */
export const SpawnMode = z.enum(['chat', 'agent']);
export type SpawnMode = z.infer<typeof SpawnMode>;

/** Result of `project.inspectFolder`: whether a folder can back a project, git or not. */
export const FolderInspection = z.object({
  ok: z.boolean().describe('True when the path is an existing folder'),
  /** User-facing (Japanese) reason when not ok. */
  reason: z.string().nullable(),
  /** Normalized absolute path. */
  path: z.string().nullable(),
  /** Whether the folder is inside a git repository. */
  isGitRepo: z.boolean(),
  /** Root of that repository (also set when the path is a subfolder of it). */
  repoRoot: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  suggestedName: z.string().nullable(),
  suggestedTestCommand: z.string().nullable(),
  /** Project already registered for this folder or repository, if any. */
  existingProjectId: ProjectId.nullable(),
});
export type FolderInspection = z.infer<typeof FolderInspection>;

export const spawnDomain = { SpawnMode, FolderInspection } as const;

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

export const spawnMethods = {
  'session.spawn': {
    params: params({
      parentSessionId: SessionId.optional().describe(
        'Session the child belongs to; agents default to their own session',
      ),
      title: z.string().min(1).max(80).describe('Short name of the child, e.g. "FAQ を書く"'),
      goal: z.string().min(1).max(50_000).describe('What the child should do'),
      doneWhen: z
        .array(z.string().min(1).max(500))
        .max(20)
        .optional()
        .describe('Completion criteria'),
      mode: SpawnMode.default('agent').describe(
        'agent: works on its own and finishes with outputs; chat: an ordinary conversation',
      ),
      workspace: WorkspaceSpec.optional().describe(
        'Where an agent works: none (a private scratch folder, default), folder, or worktree (code)',
      ),
      projectId: ProjectId.optional(),
      after: z
        .array(SessionId)
        .max(16)
        .optional()
        .describe('Sibling children that must finish first; this one starts automatically after'),
      model: z.string().min(1).optional(),
      runtime: z.string().min(1).optional(),
      budgetUsd: z.number().positive().optional().describe('Budget carved from the caller'),
      reviewBy: ReviewBy.default('none').describe(
        'human: a person must accept the outputs before the work counts as done',
      ),
      permissions: z
        .array(PermissionPattern)
        .optional()
        .describe('Capabilities given to the child (subset of the caller)'),
      start: z.boolean().default(true).describe('Start right away (default true)'),
    }),
    result: z.object({
      session: Session,
      runId: RunId.nullable(),
      budgetId: BudgetId.nullable(),
      waitingFor: z.array(SessionId).describe('Children this one waits for before it starts'),
    }),
    description:
      'Start a child session for a piece of work and return immediately. The child gets the goal as its first message and finishes by leaving outputs (artifact.publish, or its final answer). You are woken when it finishes, fails or needs a human; do not poll. The child cannot spawn children of its own.',
    mutates: true,
  },
  'project.inspectFolder': {
    params: params({
      path: z.string().min(1).max(4000).describe('Absolute path of a local folder'),
    }),
    result: FolderInspection,
    description:
      'Check whether a local folder can back a project (git is optional) and suggest settings. Read-only: creates nothing.',
    tool: false,
  },
} as const satisfies Record<string, MethodDef>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const spawnEvents = {} as const;
