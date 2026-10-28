import { z } from 'zod';

/**
 * Machine-readable plan for the mock agent, embedded anywhere in the prompt (task description
 * or user message) as a fenced block:
 *
 * ````md
 * ```acc-mock
 * {
 *   "steps": [
 *     { "type": "say", "text": "テストを追加します" },
 *     { "type": "write", "path": "src/sum.ts", "content": "export const sum = ..." },
 *     { "type": "append", "path": "README.md", "content": "\n- sum を追加\n" },
 *     { "type": "run", "command": "node", "args": ["-e", "process.exit(0)"], "title": "テストを実行" },
 *     { "type": "ask", "title": "本番設定に触れてよいですか", "onReject": "stop" },
 *     { "type": "check", "path": "src/sum.ts", "contains": "export const sum" },
 *     { "type": "sleep", "ms": 500 },
 *     { "type": "fail", "message": "ビルドが通りませんでした" }
 *   ],
 *   "summary": "sum を追加しました",
 *   "delayScale": 0
 * }
 * ```
 * ````
 *
 * A bare JSON array is accepted as shorthand for `{ "steps": [...] }`. Paths are relative to
 * the workspace; like any agent, touching a path outside it needs approval. `run` always
 * needs approval and never uses a shell: `command` + `args` (`"node"` runs the daemon's own
 * Node binary, so plans are cross-platform).
 */
const RejectAction = z.enum(['stop', 'continue', 'fail']).default('stop');

const RelPath = z.string().min(1).max(500);

export const MockStep = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('say'), text: z.string().min(1) }),
  z.strictObject({ type: z.literal('write'), path: RelPath, content: z.string() }),
  z.strictObject({ type: z.literal('append'), path: RelPath, content: z.string() }),
  z.strictObject({
    type: z.literal('run'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /** Shown in the transcript/activity, e.g. "テストを実行". */
    title: z.string().optional(),
    /** Non-zero exit fails the run unless allowed. */
    allowFailure: z.boolean().default(false),
    timeoutMs: z.int().min(1).max(600_000).default(60_000),
    onReject: RejectAction,
  }),
  z.strictObject({
    type: z.literal('ask'),
    title: z.string().min(1),
    detail: z.string().optional(),
    /** Tool name shown in the approval payload. */
    toolName: z.string().min(1).default('MockApproval'),
    onReject: RejectAction,
  }),
  z.strictObject({
    type: z.literal('fail'),
    message: z.string().default('モックの失敗ステップです'),
  }),
  z.strictObject({ type: z.literal('sleep'), ms: z.int().min(0).max(600_000) }),
  /** Read-only verification: the file exists (and contains `contains`). Fails the run otherwise. */
  z.strictObject({ type: z.literal('check'), path: RelPath, contains: z.string().optional() }),
]);
export type MockStep = z.infer<typeof MockStep>;

export const MockPlan = z.strictObject({
  steps: z.array(MockStep).max(500),
  /** Final message. Default: a generated summary of what changed. */
  summary: z.string().optional(),
  /** Multiplies every built-in delay (0 = instant). Explicit `sleep` steps are not scaled. */
  delayScale: z.number().min(0).max(100).optional(),
});
export type MockPlan = z.infer<typeof MockPlan>;

const FENCE = /```acc-mock[^\S\r\n]*\r?\n([\s\S]*?)```/;

export class MockPlanError extends Error {
  override name = 'MockPlanError';
}

/** The plan in `prompt`, or null when there is no acc-mock block. Throws MockPlanError if invalid. */
export function parseMockPlan(prompt: string): MockPlan | null {
  const m = FENCE.exec(prompt);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]!);
  } catch (err) {
    throw new MockPlanError(`acc-mock ブロックの JSON を読み取れません: ${(err as Error).message}`);
  }
  const r = MockPlan.safeParse(Array.isArray(raw) ? { steps: raw } : raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new MockPlanError(
      `acc-mock ブロックの形式が正しくありません（${where}${issue?.message ?? ''}）`,
    );
  }
  return r.data;
}

/** The prompt without its acc-mock block (what a human would read). */
export function stripMockPlan(prompt: string): string {
  return prompt.replace(FENCE, '').trim();
}
