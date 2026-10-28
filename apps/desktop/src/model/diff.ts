export interface DiffLine {
  kind: 'context' | 'add' | 'del' | 'hunk' | 'meta';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  additions: number;
  deletions: number;
  lines: DiffLine[];
  binary: boolean;
}

/** Parse a unified (git) patch into files with numbered lines. */
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      cur = { path: m?.[2] ?? line.slice(11), oldPath: m?.[1] ?? null, additions: 0, deletions: 0, lines: [], binary: false };
      files.push(cur);
      continue;
    }
    if (!cur) {
      // Patches without the git header start directly with ---/+++.
      if (line.startsWith('--- ')) {
        cur = { path: '', oldPath: line.slice(4).replace(/^a\//, ''), additions: 0, deletions: 0, lines: [], binary: false };
        files.push(cur);
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') cur.path = p.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('Binary files')) {
      cur.binary = true;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = Number(m?.[1] ?? 0);
      newNo = Number(m?.[2] ?? 0);
      cur.lines.push({ kind: 'hunk', text: line, oldNo: null, newNo: null });
      continue;
    }
    if (/^(index |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) continue;
    if (line.startsWith('+')) {
      cur.additions++;
      cur.lines.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
    } else if (line.startsWith('-')) {
      cur.deletions++;
      cur.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
    } else if (line.startsWith(' ')) {
      cur.lines.push({ kind: 'context', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (line.startsWith('\\')) {
      cur.lines.push({ kind: 'meta', text: line, oldNo: null, newNo: null });
    }
  }
  for (const f of files) if (!f.path && f.oldPath) f.path = f.oldPath;
  return files;
}
