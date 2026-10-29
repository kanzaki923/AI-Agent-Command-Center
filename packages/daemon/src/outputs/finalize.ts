import path from 'node:path';
import type { Actor, Artifact, Run, Workspace } from '@acc/protocol';
import type { FinalizeResult, OutputsService } from '../contracts';
import type { DaemonContext } from '../core/context';
import { textOfParts } from '../llm/messages';
import { truncate } from '../runtime/tools';
import { commonFolder, mimeTypeOf, relTo, workspaceOfRun } from './paths';
import { trackedWrites } from './tracking';

/** Actor of what the daemon records on a run's behalf. */
export const OUTPUTS_SYSTEM: Actor = { kind: 'system', component: 'outputs' };

/** A final answer longer than this is cut (documents hold at most 1 MB). */
const MAX_FINAL_CHARS = 1_000_000;

/**
 * Settles what a finished run leaves behind (spec 20261029 §3.4, the `outputs` service):
 *
 * 1. outputs the run published (`artifact.publish`) always count;
 * 2. in a git worktree, the code change (the diff the agent executor recorded after its
 *    commit; a retry without new commits keeps the workspace's latest one) — a change waits
 *    for a human (`needsReview`), since accepting it applies it;
 * 3. in a folder / scratch workspace, the files the run wrote with the file tools that it did
 *    not publish become one `files` output (`source: tracked_writes`);
 * 4. when nothing above exists, the last assistant text becomes a `document`
 *    (`source: final_message`), so every finished child has a result to show.
 *
 * `brief.reviewBy: human` makes every output wait for a human too. Outputs that wait get
 * `review.state: pending`. Calling it again for the same run records nothing new.
 */
export class Outputs implements OutputsService {
  constructor(private readonly ctx: DaemonContext) {}

  finalize(input: Run): Promise<FinalizeResult> {
    try {
      return Promise.resolve(this.settle(input));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private settle(input: Run): FinalizeResult {
    const { ctx } = this;
    const run = ctx.repos.runs.get(input.id) ?? input;
    const session = ctx.repos.sessions.get(run.sessionId);
    const ws = workspaceOfRun(ctx, run);
    const own = ctx.repos.artifacts
      .find({ where: { run_id: run.id }, direction: 'asc' })
      .filter((a) => a.role === 'output');
    const published = own.filter((a) => a.source === 'published');
    const code = ws?.kind === 'worktree' ? this.codeChange(run, ws, own) : null;
    const otherDiffs = own.filter((a) => a.kind === 'diff' && a.id !== code?.id);
    const outputs: Artifact[] = [...published, ...(code ? [code] : []), ...otherDiffs];

    const completed = run.status === 'completed';
    if (completed && ws && ws.kind !== 'worktree' && otherDiffs.length === 0) {
      const files =
        own.find((a) => a.source === 'tracked_writes') ?? this.recordWrites(run, ws, published);
      if (files) outputs.push(files);
    }
    if (completed && outputs.length === 0) {
      const text = own.find((a) => a.source === 'final_message') ?? this.recordFinalText(run);
      if (text) outputs.push(text);
    }

    const reviewByHuman = session?.brief?.reviewBy === 'human';
    const codeWaits = !!code && code.review.state !== 'accepted';
    const needsReview = completed && outputs.length > 0 && (codeWaits || reviewByHuman);
    if (needsReview) {
      const artifacts = ctx.service('artifacts');
      for (const a of reviewByHuman ? outputs : [code!]) {
        if (a.review.state !== 'none') continue;
        artifacts.setReview(
          a.id,
          { state: 'pending', by: null, at: null, note: null },
          OUTPUTS_SYSTEM,
        );
      }
    }
    return { needsReview, artifactIds: outputs.map((a) => a.id) };
  }

  /** The worktree's code change: this run's diff, else the workspace's latest (a retry). */
  private codeChange(run: Run, ws: Workspace, own: Artifact[]): Artifact | null {
    const mine = own.filter((a) => a.kind === 'diff').at(-1);
    const latest =
      mine ??
      this.ctx.repos.artifacts.findOne({
        where: { kind: 'diff' },
        sql: { clause: "json_extract(data, '$.workspaceId') = ?", params: [ws.id] },
        direction: 'desc',
      });
    if (!latest || latest.kind !== 'diff' || latest.role !== 'output') return null;
    if (latest.data.stats.files === 0) return null;
    if (latest !== mine && latest.review.state === 'accepted') return null;
    return latest;
  }

  private recordWrites(run: Run, ws: Workspace, published: Artifact[]): Artifact | null {
    if (ws.status !== 'ready') return null;
    const covered = publishedPaths(published);
    const files = trackedWrites(this.ctx, run, ws.path).filter((f) => !covered(f.rel));
    if (files.length === 0) return null;
    const rels = files.map((f) => f.rel);
    const folder = commonFolder(rels);
    const first = path.posix.basename(rels[0]!);
    return this.ctx.service('artifacts').record({
      kind: 'files',
      title: files.length === 1 ? first : `${first} ほか ${files.length - 1} 件`,
      summary: `作業場所に書いた ${files.length} 件のファイル`,
      source: 'tracked_writes',
      data: {
        root: folder,
        files: files.map((f) => ({
          path: relTo(folder, f.rel),
          size: f.size,
          mimeType: mimeTypeOf(f.rel),
        })),
      },
      sessionId: run.sessionId,
      runId: run.id,
      taskId: run.taskId,
      workspaceId: ws.id,
      projectId: run.projectId ?? ws.projectId,
      createdBy: OUTPUTS_SYSTEM,
    });
  }

  private recordFinalText(run: Run): Artifact | null {
    const { ctx } = this;
    const text = lastAssistantText(ctx, run);
    if (!text) return null;
    const session = ctx.repos.sessions.get(run.sessionId);
    const task = run.taskId ? ctx.repos.tasks.get(run.taskId) : undefined;
    const title = task?.title ?? session?.title ?? '';
    return ctx.service('artifacts').record({
      kind: 'document',
      title: truncate(title, 200) || '回答',
      summary: truncate(firstLine(text), 120) || null,
      source: 'final_message',
      data: {
        format: 'markdown',
        content: text.length > MAX_FINAL_CHARS ? text.slice(0, MAX_FINAL_CHARS) : text,
        path: null,
      },
      sessionId: run.sessionId,
      runId: run.id,
      taskId: run.taskId,
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      createdBy: OUTPUTS_SYSTEM,
    });
  }
}

/** The run's last assistant message with text. */
export function lastAssistantText(ctx: DaemonContext, run: Run): string | null {
  const msgs = ctx.repos.messages.find({
    where: { run_id: run.id },
    direction: 'desc',
    limit: 50,
  });
  for (const m of msgs) {
    if (m.role !== 'assistant') continue;
    const text = textOfParts(m.content).trim();
    if (text) return text;
  }
  return null;
}

/** Whether a workspace-relative path is already part of a published output. */
function publishedPaths(published: Artifact[]): (rel: string) => boolean {
  const files = new Set<string>();
  for (const a of published) {
    if ((a.kind === 'document' || a.kind === 'data') && a.data.path) files.add(a.data.path);
    if (a.kind === 'files') {
      for (const f of a.data.files) files.add(a.data.root ? `${a.data.root}/${f.path}` : f.path);
    }
  }
  return (rel) => files.has(rel);
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find(Boolean) ?? ''
  );
}
