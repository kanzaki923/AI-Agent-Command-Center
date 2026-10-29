import type { Artifact } from '@acc/protocol';
import { T0, iso } from '../../test/fixtures';

type Kind = Artifact['kind'];
type Of<K extends Kind> = Extract<Artifact, { kind: K }>;

let n = 0;

/** An output for tests (defaults: a markdown document of no review, made now). */
export function output<K extends Kind = 'document'>(
  kind: K = 'document' as K,
  over: Partial<Omit<Of<K>, 'kind'>> = {},
): Of<K> {
  n++;
  const data: Record<Kind, unknown> = {
    document: { format: 'markdown', content: '# 見出し\n\n本文です。', path: null },
    data: { format: 'csv', columns: ['社名', '月額'], rows: [['A 社', 980]], path: null },
    link: { url: 'https://example.com/report', label: null },
    files: { root: '', files: [{ path: 'notes/faq.md', size: 2048, mimeType: 'text/markdown' }] },
    diff: {
      patch: PATCH,
      baseRef: null,
      headRef: null,
      stats: { files: 2, additions: 3, deletions: 1 },
      files: [],
    },
    commit: { sha: 'abc', branch: null, message: 'x', stats: null },
    test_result: {
      command: 'pnpm test',
      passed: true,
      exitCode: 0,
      durationMs: 1,
      summary: '成功',
      output: null,
    },
    file: { path: 'a.txt', mimeType: null, content: 'a' },
    note: { text: 'n' },
  };
  return {
    id: `art_${String(n).padStart(26, '0')}`,
    projectId: null,
    sessionId: 'ses_00000000000000000000000001',
    runId: null,
    taskId: null,
    workspaceId: null,
    title: `成果物 ${n}`,
    createdBy: { kind: 'agent', sessionId: 'ses_00000000000000000000000001', runId: null },
    createdAt: iso(T0 + n * 1000),
    summary: null,
    review: { state: 'none', by: null, at: null, note: null },
    role: kind === 'commit' || kind === 'test_result' ? 'evidence' : 'output',
    source: 'published',
    kind,
    data: data[kind],
    ...over,
  } as unknown as Of<K>;
}

export const PATCH = `diff --git a/docs/auth.md b/docs/auth.md
new file mode 100644
--- /dev/null
+++ b/docs/auth.md
@@ -0,0 +1,2 @@
+# 認証 API
+POST /api/login
diff --git a/src/auth/session.ts b/src/auth/session.ts
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -1,3 +1,3 @@
 export function isExpired() {
-  return false;
+  return true;
 }
`;
