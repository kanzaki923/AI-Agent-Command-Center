import type { Actor, Artifact, ArtifactKind } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import type { Page } from '../core/repo';
import { invalidParams } from '../core/errors';
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
}

export interface ArtifactQuery {
  projectId?: string | undefined;
  sessionId?: string | undefined;
  runId?: string | undefined;
  taskId?: string | undefined;
  workspaceId?: string | undefined;
  kind?: ArtifactKind | undefined;
  limit: number;
  cursor?: string | undefined;
}

/** Keep test output tails bounded in the DB. */
export const MAX_TEST_OUTPUT_CHARS = 64 * 1024;

/**
 * Artifacts record what work produced (diffs, commits, test results …) so it can be
 * traced to its task / run / workspace (concept §6.3). Other modules record through this
 * service: `ctx.service('artifacts').recordDiff({ workspaceId, runId, createdBy })`.
 */
export class ArtifactService {
  constructor(private readonly ctx: DaemonContext) {}

  get(artifactId: string): Artifact {
    return this.ctx.repos.artifacts.require(artifactId);
  }

  list(q: ArtifactQuery): Page<Artifact> {
    return this.ctx.repos.artifacts.page({
      where: {
        project_id: q.projectId,
        session_id: q.sessionId,
        run_id: q.runId,
        task_id: q.taskId,
        kind: q.kind,
      },
      ...(q.workspaceId
        ? { sql: { clause: "json_extract(data, '$.workspaceId') = ?", params: [q.workspaceId] } }
        : {}),
      limit: q.limit,
      cursor: q.cursor,
    });
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
      } as Artifact);
      this.ctx.bus.emit({
        type: 'artifact.created',
        actor: input.createdBy,
        payload: { artifact },
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
