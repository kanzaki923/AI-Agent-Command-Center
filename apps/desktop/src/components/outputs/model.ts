import type { Artifact, Integration, OutputKind, SessionState } from '@acc/protocol';
import { outputKind } from '../../daemon/outputs';

/** An output as the panel shows it: its UI kind is known (evidence is left out). */
export type Output = Artifact & { uiKind: OutputKind };

const byNewest = (a: Artifact, b: Artifact) =>
  a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;

/**
 * The outputs beside a conversation (ui-redesign spec §6): user-facing outputs of the
 * conversation and its descendants. Left out: an older code change of a workspace (the newest
 * one carries the whole change), and an output sent back for a redo once its conversation has
 * a newer one. Waiting for a decision comes first, then the newest.
 */
export function panelOutputs(all: readonly Artifact[], subtree: ReadonlySet<string>): Output[] {
  const mine: Output[] = [];
  for (const a of all) {
    const uiKind = outputKind(a);
    if (uiKind && a.sessionId && subtree.has(a.sessionId)) mine.push({ ...a, uiKind });
  }
  mine.sort(byNewest);
  const seenCode = new Set<string>();
  const newestBySession = new Map<string, string>();
  for (const a of mine)
    if (!newestBySession.has(a.sessionId!)) newestBySession.set(a.sessionId!, a.id);
  const shown = mine.filter((a) => {
    if (a.uiKind === 'code' && a.workspaceId) {
      if (seenCode.has(a.workspaceId)) return false;
      seenCode.add(a.workspaceId);
    }
    return !(a.review.state === 'rejected' && newestBySession.get(a.sessionId!) !== a.id);
  });
  return [
    ...shown.filter((a) => a.review.state === 'pending'),
    ...shown.filter((a) => a.review.state !== 'pending'),
  ];
}

/**
 * Where the decision on an output stands:
 * - `none`: nothing to decide;
 * - `waiting`: 採用 or やり直す;
 * - `applying`: code adopted, being applied (tests, then 反映);
 * - `apply_wait`: code adopted and verified, but applying needs the human again (e.g. the
 *   target moved on): 反映;
 * - `apply_failed`: code adopted, but the tests failed or it could not be merged;
 * - `adopted`: 採用済み (code: 反映済み);
 * - `sent_back`: sent back for a redo.
 */
export type ReviewPhase =
  | { kind: 'none' }
  | { kind: 'waiting' }
  | { kind: 'applying'; integration: Integration }
  | { kind: 'apply_wait'; integration: Integration }
  | { kind: 'apply_failed'; integration: Integration }
  | { kind: 'adopted' }
  | { kind: 'sent_back' };

/**
 * The integration an adopted code change started: one the human pre-approved that carries the
 * change's workspace (or task), made after the change. Newest first.
 */
export function adoptionOf(a: Artifact, integrations: readonly Integration[]): Integration | null {
  if (a.kind !== 'diff') return null;
  let best: Integration | null = null;
  for (const i of integrations) {
    if (!i.preApprovedBy || i.createdAt < a.createdAt) continue;
    const carries =
      (!!a.workspaceId && i.workspaceIds.includes(a.workspaceId)) ||
      (!!a.taskId && i.taskIds.includes(a.taskId));
    if (carries && (!best || i.createdAt > best.createdAt)) best = i;
  }
  return best;
}

export function reviewPhase(a: Artifact, integrations: readonly Integration[]): ReviewPhase {
  switch (a.review.state) {
    case 'accepted':
      return { kind: 'adopted' };
    case 'rejected':
      return { kind: 'sent_back' };
    case 'none':
      return { kind: 'none' };
    case 'pending':
      break;
  }
  const integ = adoptionOf(a, integrations);
  if (!integ) return { kind: 'waiting' };
  switch (integ.status) {
    case 'pending':
    case 'running':
    case 'verifying':
      return { kind: 'applying', integration: integ };
    case 'awaiting_approval':
      // An adopted attempt applies itself once verified; it only waits when applying failed.
      return integ.error
        ? { kind: 'apply_wait', integration: integ }
        : { kind: 'applying', integration: integ };
    case 'applied':
      return { kind: 'adopted' };
    case 'failed':
    case 'conflict':
      return { kind: 'apply_failed', integration: integ };
    case 'rejected':
    case 'cancelled':
      return { kind: 'waiting' };
  }
}

/**
 * The request's completion conditions are met (✓) once the work produced its outputs: the
 * conversation is done or waits for the outputs to be reviewed, or one of them was adopted.
 */
export function doneWhenMet(
  state: SessionState | null | undefined,
  outputs: readonly Artifact[],
): boolean {
  return (
    state === 'done' || state === 'review' || outputs.some((o) => o.review.state === 'accepted')
  );
}

/** Join a workspace path with relative parts, in the separator style of the base. */
export function joinPath(base: string, ...parts: string[]): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  const segs = parts.flatMap((p) => p.split(/[\\/]+/)).filter((p) => p && p !== '.');
  return [base.replace(/[\\/]+$/, ''), ...segs].join(sep);
}

/** `12 KB` style size of a file (bytes under 1 KB as `B`). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How a file's text can be shown: Markdown, a table (CSV), plain text, or not at all. */
export function previewKind(
  path: string,
  mimeType: string | null,
): 'markdown' | 'csv' | 'text' | null {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (ext === 'md' || ext === 'markdown' || mimeType === 'text/markdown') return 'markdown';
  if (ext === 'csv' || mimeType === 'text/csv') return 'csv';
  if (!mimeType)
    return /^(txt|json|ya?ml|toml|ini|log|html?|css|xml|[cm]?[jt]sx?|py|rb|go|rs|java|sh|sql)$/.test(
      ext,
    )
      ? 'text'
      : null;
  if (mimeType.startsWith('text/') || /json|xml|yaml|javascript|typescript/.test(mimeType))
    return 'text';
  return null;
}

/** A small CSV parser for previews (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** A table cell as text (objects as JSON). */
export function cellText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Only web links are opened. */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
