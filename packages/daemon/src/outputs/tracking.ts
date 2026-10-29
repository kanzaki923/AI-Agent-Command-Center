import { statSync } from 'node:fs';
import path from 'node:path';
import type { Event, Run } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { EDIT_TOOLS, toolPaths } from '../runtime/tools';
import { insideWorkspace, toRel } from './paths';

export interface TrackedFile {
  /** Workspace-relative posix path. */
  rel: string;
  size: number;
}

/**
 * Files a run wrote with the file tools (Write / Edit / MultiEdit / NotebookEdit, mock and
 * Claude alike), read back from its `tool.called` / `tool.result` events: calls whose result
 * was an error (denied, failed) are left out, as are paths outside the workspace or in `.git`
 * and files that no longer exist. Commands that write files (shell) cannot be seen this way.
 */
export function trackedWrites(ctx: DaemonContext, run: Run, root: string): TrackedFile[] {
  const calls = new Map<string, string[]>();
  const failed = new Set<string>();
  let since = 0;
  for (;;) {
    const page = ctx.bus.list({
      runId: run.id,
      types: ['tool.called', 'tool.result'],
      since,
      limit: 5000,
    });
    for (const e of page.events) collect(e, calls, failed);
    if (!page.hasMore) break;
    since = page.lastSeq;
  }
  const out = new Map<string, TrackedFile>();
  for (const [id, paths] of calls) {
    if (failed.has(id)) continue;
    for (const p of paths) {
      if (!insideWorkspace(root, p)) continue;
      const abs = path.resolve(root, p);
      let size: number;
      try {
        const st = statSync(abs);
        if (!st.isFile()) continue;
        size = st.size;
      } catch {
        continue;
      }
      const rel = toRel(root, abs);
      out.set(rel, { rel, size });
    }
  }
  return [...out.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function collect(e: Event, calls: Map<string, string[]>, failed: Set<string>): void {
  if (e.type === 'tool.called') {
    if (!EDIT_TOOLS.has(e.payload.name)) return;
    const paths = toolPaths(e.payload.name, e.payload.input);
    if (paths.length > 0) calls.set(e.payload.toolCallId, paths);
  } else if (e.type === 'tool.result' && e.payload.isError) {
    failed.add(e.payload.toolCallId);
  }
}
