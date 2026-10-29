import type {
  Actor,
  Artifact,
  ArtifactKind,
  ArtifactReview,
  ArtifactRole,
  ArtifactSource,
} from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import type { SqlValue } from '../core/db';
import type { Page } from '../core/repo';
import { invalidParams } from '../core/errors';
import { asCurrentKind, storedKindsFor } from '../outputs/legacy';
import { git } from '../workspace/git';
import { parseNumstatZ } from '../workspace/diff';

type DataOf<K extends ArtifactKind> = Extract<Artifact, { kind: K }>['data'];

/** Refs an artifact can point at. projectId/taskId default from the workspace when given. */
export interface ArtifactRefs {
  projectId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  workspaceId?: string | null;
}

export interface RecordArtifactInput<K extends ArtifactKind> extends ArtifactRefs {
  kind: K;
  title: string;
  data: DataOf<K>;
  createdBy: Actor;
  /** Default by kind: output (commit / test_result: evidence). */
  role?: ArtifactRole;
  /** Default: published (diff: workspace_diff). */
  source?: ArtifactSource;
  /** One line. */
  summary?: string | null;
  review?: ArtifactReview;
}

export interface ArtifactQuery {
  projectId?: string | undefined;
  sessionId?: string | undefined;
  runId?: string | undefined;
  taskId?: string | undefined;
  workspaceId?: string | undefined;
  /** `document` also finds legacy notes, `files` legacy files (shown as such). */
  kind?: ArtifactKind | undefined;
  role?: ArtifactRole | undefined;
  /** Artifacts of every session of this tree. */
  rootSessionId?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}

/** Keep test output tails bounded in the DB. */
export const MAX_TEST_OUTPUT_CHARS = 64 * 1024;

/**
 * Role of rows written before `role` existed (the schema default), for SQL filters: commits
 * and test results are evidence, everything else output.
 */
const ROLE_SQL =
  "COALESCE(json_extract(data, '$.role'), CASE WHEN kind IN ('commit', 'test_result') THEN 'evidence' ELSE 'output' END)";

/**
 * Artifacts record what work produced (documents, data, links, files, code changes) and how
 * it was checked (commits, test results), traced to its session / run / task / workspace
 * (concept §6.3, spec 20261029 §1.5). Other modules record through this service:
 * `ctx.service('artifacts').recordDiff({ workspaceId, runId, createdBy })`.
 *
 * Reads (`get` / `list`) show legacy `note` / `file` rows as `document` / `files`; the rows
 * themselves are never rewritten (`getStored` returns them as they are).
 */
export class ArtifactService {
  constructor(private readonly ctx: DaemonContext) {}

  get(artifactId: string): Artifact {
    return asCurrentKind(this.getStored(artifactId));
  }

  /** The row as stored (legacy kinds included). */
  getStored(artifactId: string): Artifact {
    return this.ctx.repos.artifacts.require(artifactId);
  }

  list(q: ArtifactQuery): Page<Artifact> {
    const sql: { clause: string; params: SqlValue[] }[] = [];
    if (q.workspaceId) {
      sql.push({ clause: "json_extract(data, '$.workspaceId') = ?", params: [q.workspaceId] });
    }
    if (q.role) sql.push({ clause: `${ROLE_SQL} = ?`, params: [q.role] });
    if (q.rootSessionId) {
      sql.push({
        clause: 'session_id IN (SELECT id FROM sessions WHERE root_session_id = ?)',
        params: [q.rootSessionId],
      });
    }
    const page = this.ctx.repos.artifacts.page({
      where: {
        project_id: q.projectId,
        session_id: q.sessionId,
        run_id: q.runId,
        task_id: q.taskId,
        kind: q.kind ? storedKindsFor(q.kind) : undefined,
      },
      ...(sql.length > 0
        ? {
            sql: {
              clause: sql.map((c) => `(${c.clause})`).join(' AND '),
              params: sql.flatMap((c) => c.params),
            },
          }
        : {}),
      limit: q.limit,
      cursor: q.cursor,
    });
    return { ...page, items: page.items.map(asCurrentKind) };
  }

  /** Persist an artifact and emit `artifact.created` (in the caller's transaction, if any). */
  record<K extends ArtifactKind>(input: RecordArtifactInput<K>): Artifact {
    const ws = input.workspaceId ? this.ctx.repos.workspaces.require(input.workspaceId) : null;
    const run = input.runId ? this.ctx.repos.runs.get(input.runId) : undefined;
    return this.ctx.db.transaction(() => {
      const artifact = this.ctx.repos.artifacts.insert({
        id: this.ctx.ids.next('artifact'),
        kind: input.kind,
        projectId: input.projectId ?? ws?.projectId ?? run?.projectId ?? null,
        sessionId: input.sessionId ?? run?.sessionId ?? null,
        runId: input.runId ?? null,
        taskId: input.taskId ?? ws?.taskId ?? run?.taskId ?? null,
        workspaceId: input.workspaceId ?? null,
        title: input.title,
        data: input.data,
        createdBy: input.createdBy,
        createdAt: this.ctx.clock.iso(),
        ...(input.role ? { role: input.role } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.review ? { review: input.review } : {}),
      } as Artifact);
      this.ctx.bus.emit({
        type: 'artifact.created',
        actor: input.createdBy,
        payload: { artifact: asCurrentKind(artifact) },
      });
      return artifact;
    });
  }

  /** Change an artifact's review state (emits `artifact.updated` `["review"]` when it changed). */
  setReview(artifactId: string, review: ArtifactReview, actor: Actor): Artifact {
    return this.ctx.db.transaction(() => {
      const cur = this.getStored(artifactId);
      if (sameReview(cur.review, review)) return asCurrentKind(cur);
      const next = this.ctx.repos.artifacts.update(artifactId, (a) => ({ ...a, review }));
      const artifact = asCurrentKind(next);
      this.ctx.bus.emit({
        type: 'artifact.updated',
        actor,
        payload: { artifact, changes: ['review'] },
      });
      return artifact;
    });
  }

  /** Diff of a workspace against its base (see WorkspacesService.diff) as a `diff` artifact. */
  async recordDiff(
    input: ArtifactRefs & {
      workspaceId: string;
      baseRef?: string;
      title?: string;
      createdBy: Actor;
      /** Default output (a code change to look at); an integration's own result is evidence. */
      role?: ArtifactRole;
    },
  ): Promise<Artifact> {
    const d = await this.ctx.service('workspaceManager').diff(input.workspaceId, input.baseRef);
    const ws = this.ctx.repos.workspaces.require(input.workspaceId);
    const { baseRef: _baseRef, title, ...refs } = input;
    return this.record({
      ...refs,
      kind: 'diff',
      title: title ?? `差分: ${ws.branch ?? ws.path}（${d.stats.files} ファイル）`,
      data: {
        patch: d.patch,
        baseRef: d.baseRef,
        headRef: ws.branch,
        stats: d.stats,
        files: d.files,
      },
    });
  }

  /** A commit (by sha) in a workspace as a `commit` artifact, with its numstat totals. */
  async recordCommit(
    input: ArtifactRefs & { workspaceId: string; sha: string; title?: string; createdBy: Actor },
  ): Promise<Artifact> {
    const ws = this.ctx.repos.workspaces.require(input.workspaceId);
    const show = await git(ws.path, ['show', '-s', '--format=%B', input.sha]);
    const numstat = await git(ws.path, ['show', '--format=', '--numstat', '-z', '-M', input.sha]);
    const files = parseNumstatZ(numstat.stdout);
    const message = show.stdout.trim();
    const { sha, title, ...refs } = input;
    return this.record({
      ...refs,
      kind: 'commit',
      title: title ?? `コミット: ${message.split(/\r?\n/)[0] ?? sha.slice(0, 8)}`,
      data: {
        sha,
        branch: ws.branch,
        message,
        stats: {
          files: files.length,
          additions: files.reduce((n, f) => n + f.additions, 0),
          deletions: files.reduce((n, f) => n + f.deletions, 0),
        },
      },
    });
  }

  /** A test / verification run as a `test_result` artifact (output is cut to its tail). */
  recordTestResult(
    input: ArtifactRefs & {
      command: string;
      passed: boolean;
      exitCode: number | null;
      durationMs: number | null;
      summary: string;
      output: string | null;
      title?: string;
      createdBy: Actor;
    },
  ): Artifact {
    if (!input.command) throw invalidParams('command is required');
    const { command, passed, exitCode, durationMs, summary, output, title, ...refs } = input;
    const tail =
      output !== null && output.length > MAX_TEST_OUTPUT_CHARS
        ? output.slice(output.length - MAX_TEST_OUTPUT_CHARS)
        : output;
    return this.record({
      ...refs,
      kind: 'test_result',
      title: title ?? `テスト${passed ? '成功' : '失敗'}: ${command}`,
      data: {
        command,
        passed,
        exitCode,
        durationMs: durationMs === null ? null : Math.max(0, Math.round(durationMs)),
        summary,
        output: tail,
      },
    });
  }
}

function sameReview(a: ArtifactReview, b: ArtifactReview): boolean {
  return (
    a.state === b.state &&
    a.note === b.note &&
    a.at === b.at &&
    JSON.stringify(a.by) === JSON.stringify(b.by)
  );
}
