import type { Artifact, ArtifactKind } from '@acc/protocol';

/**
 * Legacy artifacts (spec 20261029 §1.12-5): `note` rows read as `document`, `file` rows as
 * `files`. Rows are never rewritten; this is applied on every read (`artifact.get` / `list`,
 * events). `artifact.read` reads the stored row, so a legacy file's inline content still works.
 */
export function asCurrentKind(a: Artifact): Artifact {
  if (a.kind === 'note') {
    return {
      ...a,
      kind: 'document',
      data: { format: 'markdown', content: a.data.text, path: null },
    };
  }
  if (a.kind === 'file') {
    return {
      ...a,
      kind: 'files',
      data: {
        root: '',
        files: [
          {
            path: a.data.path,
            size: a.data.content === null ? 0 : Buffer.byteLength(a.data.content, 'utf8'),
            mimeType: a.data.mimeType,
          },
        ],
      },
    };
  }
  return a;
}

/** Stored kinds a kind filter matches (a `document` filter also finds legacy notes). */
export function storedKindsFor(kind: ArtifactKind): ArtifactKind[] {
  if (kind === 'document') return ['document', 'note'];
  if (kind === 'files') return ['files', 'file'];
  return [kind];
}
